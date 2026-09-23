import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createOAuth } from '../oauth.mjs';
import { localBrowser, enterCredentials, browserAuthorization } from '../browser.mjs';
import { bindSubject } from '../security.mjs';

process.chdir(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const config = JSON.parse(await readFile('.private/config.json', 'utf8'));
const oauth = await createOAuth(config);
const evidence = [];
const auth = (token) => ({ Authorization: `Bearer ${token}` });
const digest = (value) => createHash('sha256').update(value).digest('hex');

async function rawExchange(token, secret, parameters = {}) {
  const body = {
    grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
    subject_token: token,
    subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
    requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
    audience: 'flag-api',
    ...parameters,
  };
  const headers = {};
  if (secret === undefined) body.client_id = 'connector';
  else headers.Authorization = `Basic ${Buffer.from(`connector:${secret}`).toString('base64')}`;
  return fetch(oauth.metadata.token_endpoint, {
    method: 'POST', headers, body: new URLSearchParams(body), signal: AbortSignal.timeout(10_000),
  });
}

test('real local browser + RFC8693 proof (parallel isolated contexts)', { timeout: 180_000, concurrency: 4 }, async (t) => {
  const browser = await localBrowser();
  async function scenario(name, body) {
    return t.test(name, async () => {
      try {
        const details = await body();
        evidence.push({ name, status: 'passed', kind: 'live', ...details });
      } catch {
        evidence.push({ name, status: 'failed', kind: 'live' });
        // Assertion objects can contain callback URLs or token responses; never emit those.
        throw new Error(`Live scenario failed: ${name}`);
      }
    });
  }
  try {
    await Promise.all([
      scenario('native loopback browser login reads bounded flag through connector exchange', async () => {
        const context = await browser.newContext();
        try {
          const page = await context.newPage();
          await page.goto('http://127.0.0.1:18881/login');
          await enterCredentials(page, config.reader);
          await page.waitForURL('http://127.0.0.1:18881/result');
          const data = JSON.parse(await page.locator('body').innerText());
          assert.equal(data.read, true);
          assert.equal(data.flagSha256, digest(config.flag));
          assert.equal(data.subjectPreserved, true);
          assert.equal(data.readerBound, true);
          assert.equal(data.incomingAudience, 'connector');
          assert.equal(data.exchangedAudience, 'flag-api');
          return data;
        } finally { await context.close(); }
      }),
      scenario('reader tokens require audience change; wrong audience, tampering and writes denied', async () => {
        const { callback, transaction } = await browserAuthorization(browser, oauth, config.reader);
        const { token, claims } = await oauth.finish(callback, transaction);
        assert.equal(claims.sub === config.reader.subject, true);
        const direct = await fetch('http://127.0.0.1:18883/flag', { headers: auth(token) });
        assert.equal(direct.status, 401);
        const exchanged = await oauth.exchange(token);
        assert.equal(exchanged !== token, true);
        const target = await oauth.validate(exchanged, 'flag-api', 'connector');
        assert.equal(bindSubject(claims, target), true);
        const good = await fetch('http://127.0.0.1:18883/flag', { headers: auth(exchanged) });
        assert.equal(good.status, 200);
        assert.equal(digest((await good.json()).flag), digest(config.flag));
        const write = await fetch('http://127.0.0.1:18883/flag', { method: 'POST', headers: auth(exchanged), body: '{}' });
        assert.equal(write.status, 403);
        const parts = exchanged.split('.');
        parts[2] = (parts[2][0] === 'A' ? 'B' : 'A') + parts[2].slice(1);
        const tampered = await fetch('http://127.0.0.1:18883/flag', { headers: auth(parts.join('.')) });
        assert.equal(tampered.status, 401);
        const reverse = await fetch('http://127.0.0.1:18882/read', { headers: auth(exchanged) });
        assert.equal(reverse.status, 401);
        return { directAudienceStatus: direct.status, writeStatus: write.status,
          invalidSignatureStatus: tampered.status, reversedAudienceStatus: reverse.status,
          subjectPreserved: true, distinctProviderTokens: true, actClaimPresent: target.act !== undefined };
      }),
      scenario('provider rejects exchange without correct confidential connector credentials', async () => {
        const { callback, transaction } = await browserAuthorization(browser, oauth, config.reader);
        const { token } = await oauth.finish(callback, transaction);
        const statuses = [];
        for (const secret of [undefined, 'deliberately-invalid-local-test-secret']) {
          const response = await rawExchange(token, secret);
          const body = await response.json();
          assert.equal([400, 401].includes(response.status), true);
          assert.equal(['invalid_client', 'unauthorized_client'].includes(body.error), true);
          assert.equal(body.access_token, undefined);
          statuses.push(response.status);
        }
        return { missingSecretStatus: statuses[0], wrongSecretStatus: statuses[1] };
      }),
      scenario('exchange cannot select unauthorized audience or escalate scope or switch subject', async () => {
        const { callback, transaction } = await browserAuthorization(browser, oauth, config.reader);
        const { token, claims } = await oauth.finish(callback, transaction);
        const audience = await rawExchange(token, config.connectorSecret, { audience: 'interactive' });
        const audienceBody = await audience.json();
        assert.equal(audience.status, 400);
        assert.equal(audienceBody.access_token, undefined);
        const scope = await rawExchange(token, config.connectorSecret, { scope: 'local-forbidden-scope' });
        const scopeBody = await scope.json();
        if (scope.ok) {
          const issued = await oauth.validate(scopeBody.access_token, 'flag-api', 'connector');
          assert.equal((issued.scope ?? '').split(' ').includes('local-forbidden-scope'), false);
          assert.equal(bindSubject(claims, issued), true);
        } else {
          assert.equal(scope.status, 400);
          assert.equal(scopeBody.access_token, undefined);
        }
        // requested_subject is a legacy impersonation parameter, not a standard v2 grant.
        const subject = await rawExchange(token, config.connectorSecret, { requested_subject: config.nonreader.subject });
        const subjectBody = await subject.json();
        if (subject.ok) {
          const issued = await oauth.validate(subjectBody.access_token, 'flag-api', 'connector');
          assert.equal(bindSubject(claims, issued), true);
          assert.equal(issued.sub === config.reader.subject, true);
        } else {
          assert.equal(subject.status, 400);
          assert.equal(subjectBody.access_token, undefined);
        }
        return { unauthorizedAudienceStatus: audience.status,
          unknownScopeStatus: scope.status, unknownScopeBehavior: scope.ok ? 'ignored; not granted' : 'rejected',
          subjectSwitchStatus: subject.status,
          subjectSwitchBehavior: subject.ok ? 'unsupported parameter ignored; original subject preserved' : 'rejected' };
      }),
      scenario('unauthorized synthetic user rejected after valid browser authentication and exchange', async () => {
        const { callback, transaction } = await browserAuthorization(browser, oauth, config.nonreader);
        const { token, claims } = await oauth.finish(callback, transaction);
        assert.equal(claims.sub === config.nonreader.subject, true);
        const exchanged = await oauth.exchange(token);
        const outgoing = await oauth.validate(exchanged, 'flag-api', 'connector');
        assert.equal(bindSubject(claims, outgoing), true);
        const resource = await fetch('http://127.0.0.1:18883/flag', { headers: auth(exchanged) });
        assert.equal(resource.status, 403);
        const connector = await fetch('http://127.0.0.1:18882/read', { headers: auth(token) });
        assert.equal(connector.status, 403);
        return { resourceStatus: resource.status, connectorStatus: connector.status, subjectPreserved: true };
      }),
      scenario('provider rejects wrong S256 PKCE verifier', async () => {
        const { callback } = await browserAuthorization(browser, oauth, config.reader);
        const response = await fetch(oauth.metadata.token_endpoint, {
          method: 'POST', body: new URLSearchParams({
            grant_type: 'authorization_code', client_id: 'interactive',
            redirect_uri: config.redirectUri, code: new URL(callback).searchParams.get('code'),
            code_verifier: 'A'.repeat(64),
          }),
        });
        assert.equal(response.status, 400);
        assert.equal((await response.json()).error, 'invalid_grant');
        return { providerStatus: response.status, rejection: 'invalid_grant' };
      }),
      scenario('provider rejects replayed authorization code', async () => {
        const { callback, transaction } = await browserAuthorization(browser, oauth, config.reader);
        await oauth.finish(callback, transaction);
        const replay = await fetch(oauth.metadata.token_endpoint, {
          method: 'POST', body: new URLSearchParams({
            grant_type: 'authorization_code', client_id: 'interactive',
            redirect_uri: config.redirectUri, code: new URL(callback).searchParams.get('code'),
            code_verifier: transaction.verifier,
          }),
        });
        assert.equal(replay.status, 400);
        assert.equal((await replay.json()).error, 'invalid_grant');
        return { providerStatus: replay.status, rejection: 'invalid_grant' };
      }),
      scenario('missing and invalid credentials fail closed on both APIs', async () => {
        for (const endpoint of ['http://127.0.0.1:18882/read', 'http://127.0.0.1:18883/flag']) {
          for (const headers of [{}, auth('invalid.token.value')]) {
            const response = await fetch(endpoint, { headers });
            assert.equal(response.status, 401);
          }
        }
        const callback = await fetch('http://127.0.0.1:18881/callback?state=unbound&code=not-real');
        assert.equal(callback.status, 400);
        return { missingStatus: 401, invalidStatus: 401, unboundCallbackStatus: 400 };
      }),
      scenario('OIDC library rejects wrong state and nonce using real browser authorization', async () => {
        const stateCase = await browserAuthorization(browser, oauth, config.reader);
        await assert.rejects(() => oauth.finish(stateCase.callback, { ...stateCase.transaction, state: 'wrong' }));
        const nonceCase = await browserAuthorization(browser, oauth, config.reader);
        await assert.rejects(() => oauth.finish(nonceCase.callback, { ...nonceCase.transaction, nonce: 'wrong' }));
        return { stateRejected: true, nonceRejected: true, rejectionLayer: 'OIDC relying-party validation, not provider' };
      }),
      scenario('provider disallows password and client-credentials grants', async () => {
        const password = await fetch(oauth.metadata.token_endpoint, { method: 'POST', body: new URLSearchParams({
          grant_type: 'password', client_id: 'interactive', username: config.reader.username, password: config.reader.password,
        }) });
        assert.equal(password.status, 400);
        assert.equal((await password.json()).error, 'unauthorized_client');
        const service = await fetch(oauth.metadata.token_endpoint, { method: 'POST',
          headers: { Authorization: `Basic ${Buffer.from(`connector:${config.connectorSecret}`).toString('base64')}` },
          body: new URLSearchParams({ grant_type: 'client_credentials' }),
        });
        assert.equal(service.status, 401);
        assert.equal((await service.json()).error, 'unauthorized_client');
        return { passwordGrantStatus: password.status, clientCredentialsStatus: service.status };
      }),
    ]);
  } finally {
    await browser.close();
    await writeFile('live.evidence.json', JSON.stringify({
      generatedAt: new Date().toISOString(), provider: 'official Keycloak 26.7.4', syntheticOnly: true,
      protocol: 'authorization_code S256 PKCE -> RFC8693 standard token exchange v2',
      unitTests: { command: 'npm test', cases: 5, separateFromLive: true },
      liveCases: evidence,
      limitations: ['HTTP loopback development only', 'No Entra OBO or Azure Cosmos claim', 'Same-OS-user is not credential isolation'],
    }, null, 2));
  }
});
