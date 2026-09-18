import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { createServer } from 'node:net';
import { execFileSync } from 'node:child_process';

const root = import.meta.dirname;
process.chdir(root);
await mkdir('.private', { recursive: true });
// Restrict generated credentials to this Windows account before writing them.
if (process.platform === 'win32') {
  const account = execFileSync('whoami', { encoding: 'utf8' }).trim();
  execFileSync('icacls', ['.private', '/inheritance:r', '/grant:r', `${account}:(OI)(CI)F`], { stdio: 'pipe' });
}
for (const port of [18880, 18881, 18882, 18883]) {
  await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', () => reject(new Error(`Required loopback port ${port} unavailable; nothing changed.`)));
    server.listen(port, '127.0.0.1', () => server.close(resolve));
  });
}
let exists = true;
try { await access('.private/config.json'); }
catch (error) { if (error.code !== 'ENOENT') throw error; exists = false; }

if (!exists) {
  const secret = () => randomBytes(32).toString('base64url');
  const reader = { username: 'synthetic-reader', password: secret(), subject: randomUUID() };
  const nonreader = { username: 'synthetic-nonreader', password: secret(), subject: randomUUID() };
  const connectorSecret = secret();
  const config = {
    issuer: 'http://127.0.0.1:18880/realms/local-obo',
    redirectUri: 'http://127.0.0.1:18881/callback',
    reader, nonreader, connectorSecret,
    flag: `LOCAL_SYNTHETIC_${secret()}`,
  };
  await writeFile('.private/config.json', JSON.stringify(config, null, 2), { mode: 0o600, flag: 'wx' });
}
{
  const config = JSON.parse(await readFile('.private/config.json', 'utf8'));
  const { reader, nonreader, connectorSecret } = config;
  const audience = (name) => ({
    name: `audience-${name}`, protocol: 'openid-connect', protocolMapper: 'oidc-audience-mapper',
    config: { 'included.client.audience': name, 'access.token.claim': 'true', 'id.token.claim': 'false' },
  });
  const subject = {
    name: 'subject', protocol: 'openid-connect', protocolMapper: 'oidc-sub-mapper',
    config: { 'access.token.claim': 'true', 'introspection.token.claim': 'true' },
  };
  const client = (clientId) => ({
    clientId, protocol: 'openid-connect', enabled: true, publicClient: false,
    standardFlowEnabled: false, implicitFlowEnabled: false, directAccessGrantsEnabled: false,
    serviceAccountsEnabled: false, fullScopeAllowed: false,
    defaultClientScopes: [], optionalClientScopes: [],
  });
  const realm = {
    realm: 'local-obo', enabled: true, sslRequired: 'none',
    registrationAllowed: false, resetPasswordAllowed: false, rememberMe: false,
    accessTokenLifespan: 120, ssoSessionIdleTimeout: 600, ssoSessionMaxLifespan: 1800,
    eventsEnabled: false, adminEventsEnabled: false,
    clients: [
      { ...client('interactive'), publicClient: true, standardFlowEnabled: true,
        redirectUris: [config.redirectUri], webOrigins: [],
        attributes: { 'pkce.code.challenge.method': 'S256', 'use.refresh.tokens': 'false' },
        protocolMappers: [subject, audience('connector')] },
      { ...client('connector'), secret: connectorSecret,
        attributes: { 'standard.token.exchange.enabled': 'true', 'use.refresh.tokens': 'false' },
        protocolMappers: [subject, audience('flag-api')] },
      { ...client('flag-api'), bearerOnly: true },
    ],
    users: [reader, nonreader].map((user) => ({
      id: user.subject, username: user.username, enabled: true,
      firstName: 'Synthetic', lastName: 'Local', email: `${user.username}@example.invalid`,
      emailVerified: true, requiredActions: [],
      credentials: [{ type: 'password', value: user.password, temporary: false }],
    })),
  };
  await writeFile('.private/realm.json', JSON.stringify(realm, null, 2), { mode: 0o600 });
}
if (process.argv.includes('--reimport')) {
  execFileSync('docker', ['compose', 'run', '--rm', '--no-deps', 'keycloak',
    'import', '--file=/opt/keycloak/data/import/realm.json', '--override=true'], { stdio: 'inherit' });
}
execFileSync('docker', ['compose', 'up', '-d'], { stdio: 'inherit' });
const config = JSON.parse(await readFile('.private/config.json', 'utf8'));
let ready = false;
for (let attempt = 0; attempt < 120; attempt++) {
  try {
    const response = await fetch(`${config.issuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(2000) });
    if (response.ok) { ready = true; break; }
  } catch (error) {
    if (!(error instanceof TypeError) && error.name !== 'TimeoutError') throw error;
  }
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
if (!ready) throw new Error('Local provider did not become ready');
const container = execFileSync('docker', ['compose', 'ps', '-q', 'keycloak'], { encoding: 'utf8' }).trim();
await writeFile('.private/provider-runtime.json', JSON.stringify({ container, composeProject: 'taskrabbit-local-obo', image: 'quay.io/keycloak/keycloak:26.7.4' }, null, 2));
console.log('Local Keycloak ready at http://127.0.0.1:18880; synthetic credentials are private, not printed.');
