// Explicit synthetic acceptance. Never run this against a real human/Entra account.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
let fixture, lab, base, corp, alice, bob, room, prefix;
const evidence = { kind: 'AUTOMATED_SYNTHETIC_NOT_HUMAN_ACCEPTANCE', live_azure: 'NOT_EXECUTED', checks: [], jobs: [] };
const permitted = process.env.ECORP_SYNTHETIC_OBO_TEST === '1';
const qa = process.env.ECORP_DELEGATED_QA_ROOT;
const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
  /^(SystemRoot|WINDIR|PATH|PATHEXT|TEMP|TMP|PSModulePath|ProgramFiles|ProgramFiles\(x86\)|ProgramW6432)$/iu.test(name)));
function ownedFixture() {
  assert.ok(qa && path.isAbsolute(qa), 'Supply an explicit owned QA root.');
  try {
    return JSON.parse(execFileSync('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive',
      '-File', path.join(root, 'tools', 'verify_delegated_stack.ps1'), '-QaRoot', qa], {
      env: environment, encoding: 'utf8', windowsHide: true, timeout: 30_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }));
  } catch { throw new Error('Exact delegated fixture ownership could not be verified.'); }
}
function uuid(value) {
  assert.match(value, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu);
  return value;
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function api(url, body, expected = 200) {
  const response = await fetch(base + url, body ? {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  } : {});
  assert.equal(response.status, expected, `Unexpected HTTP status for ${url.split('?')[0]}`);
  return response.json();
}
function sql(query) {
  // Revalidate exact process/listener/database ownership before every test-admin
  // query. Credentials stay in a private PGPASSFILE; query input uses stdin.
  const current = ownedFixture();
  assert.deepEqual(current, fixture, 'Fixture metadata changed during acceptance.');
  try {
    return execFileSync(current.psql, ['-XwqAt', '-h', current.database.host,
      '-p', String(current.database.port), '-U', current.database.user,
      '-d', current.database.name, '-v', 'ON_ERROR_STOP=1'], {
      env: { ...environment, PGPASSFILE: current.passfile }, input: query,
      encoding: 'utf8', windowsHide: true, timeout: 30_000, stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch { throw new Error('Owned delegated fixture SQL assertion failed.'); }
}
async function operation(task) {
  const data = await api(`${prefix}?actor_id=${alice}`);
  return data.operations.find(o => o.task_id === task);
}
async function until(check, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await sleep(500);
  }
  assert.fail('Timed out waiting for bounded delegated test state');
}
async function job() {
  const ids = await api(`${prefix}/jobs`, { actor_id: alice, room_id: room });
  const op = await until(async () => { const o = await operation(ids.task_id); return o?.run_id && o; });
  evidence.jobs.push({ ...ids, operation_id: op.id, run_id: op.run_id });
  return op;
}
function scope(op) {
  // Existing test-admin database access; assignment credentials remain in process memory.
  return JSON.parse(sql(`SELECT json_build_object('run_id',r.id,'task_id',r.task_id,
    'runner_id',r.runner_id,'connection_epoch',n.connection_epoch,'assignment_token',r.assignment_token)
    FROM runs r JOIN runner_nodes n ON n.id=r.runner_id WHERE r.id='${uuid(op.run_id)}';`));
}
async function cancel(op) { await api(`${prefix}/${op.id}/cancel`, { actor_id: alice }); }
async function login(op, user) {
  const { chromium } = await import(pathToFileURL(path.join(fixture.playwright, 'index.mjs')).href);
  const { browser_url } = await api(`${prefix}/${op.id}/authorize`, { actor_id: alice });
  const browser = await chromium.launch({ headless: true, channel: 'msedge' });
  try {
    const page = await browser.newPage();
    let callbackUrl;
    page.on('request', request => {
      if (request.url().startsWith(`${base}/api/delegated/callback?`)) callbackUrl = request.url();
    });
    await page.goto(browser_url);
    assert.equal((await fetch(browser_url, { redirect: 'manual' })).status, 403);
    const flow = (await page.context().cookies()).find(cookie => cookie.name === 'delegated_flow');
    await page.locator('#username').fill(user.username);
    await page.locator('#password').fill(user.password);
    await page.locator('#kc-login').click();
    await page.waitForURL(url => url.origin === new URL(fixture.web).origin && url.searchParams.has('delegated_auth'));
    assert.ok(callbackUrl && flow);
    const replay = await fetch(callbackUrl, { redirect: 'manual', headers: { cookie: `delegated_flow=${flow.value}` } });
    assert.equal(replay.status, 303);
    assert.ok(replay.headers.get('location').endsWith('delegated_auth=denied'));
    return new URL(page.url()).searchParams.get('delegated_auth');
  } catch {
    // Playwright errors can include fill values; never propagate those diagnostics.
    assert.fail('Synthetic browser authentication contract failed (details intentionally suppressed)');
  } finally { await browser.close(); }
}

async function browserLifecycle(config) {
  const { chromium } = await import(pathToFileURL(path.join(fixture.playwright, 'index.mjs')).href);
  const browser = await chromium.launch({ headless: true, channel: 'msedge' });
  let releaseAuthorization = () => {};
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    await page.goto(fixture.web);
    const panel = page.getByRole('region', { name: 'Protected resource jobs' });
    const runButton = panel.getByRole('button', { name: 'Run protected resource job', exact: true });
    await until(async () => await runButton.isEnabled().catch(() => false));
    const before = new Set((await api(`${prefix}?actor_id=${alice}`)).operations.map(op => op.id));
    const popupPromise = context.waitForEvent('page');
    await runButton.click();
    const popup = await popupPromise;
    const op = await until(async () => (await api(`${prefix}?actor_id=${alice}`)).operations
      .find(candidate => !before.has(candidate.id) && candidate.run_id));
    evidence.jobs.push({ mission_id: op.mission_id, task_id: op.task_id, operation_id: op.id, run_id: op.run_id, via: 'browser' });
    await popup.locator('#username').fill(config.reader.username);
    await popup.locator('#password').fill(config.reader.password);
    await popup.locator('#kc-login').click();
    await popup.waitForURL(url => url.origin === new URL(fixture.web).origin && url.searchParams.get('delegated_auth') === 'returned');
    await popup.close();
    const article = panel.locator('article').filter({ hasText: op.task_id });
    await article.getByRole('button', { name: 'Release private receipt', exact: true }).waitFor();
    await article.screenshot({ path: path.join(fixture.evidence, 'browser-private-receipt.png') });
    assert.equal((await operation(op.task_id)).released, false);
    await article.getByRole('button', { name: 'Release private receipt', exact: true }).click();
    await until(async () => (await operation(op.task_id))?.status === 'completed', 60_000);
    await article.getByText('Completed', { exact: true }).waitFor();
    await article.screenshot({ path: path.join(fixture.evidence, 'browser-completed.png') });
    const snapshot = await api(`/api/corps/${corp}/snapshot?actor_id=${alice}`);
    const run = snapshot.snapshot.runs.find(candidate => candidate.id === op.run_id);
    assert.equal(run.status, 'completed');
    assert.equal(run.verification_status, 'passed');
    evidence.checks.push('browser-start-login-private-preview-release-original-run-verifier-completion');

    // Delay a real successful authorize response until after the real cancel
    // POST commits. The UI must discard that old ticket and close its popup.
    let observedAuthorization;
    const authorizationSeen = new Promise(resolve => { observedAuthorization = resolve; });
    const heldAuthorization = new Promise(resolve => { releaseAuthorization = resolve; });
    let requests = 0;
    await context.route('**/delegated/*/authorize', async route => {
      requests++;
      const response = await route.fetch();
      observedAuthorization();
      await heldAuthorization;
      await route.fulfill({ response });
    });
    const known = new Set((await api(`${prefix}?actor_id=${alice}`)).operations.map(candidate => candidate.id));
    await until(async () => runButton.isEnabled());
    const cancelledPopupPromise = context.waitForEvent('page');
    await runButton.click();
    const cancelledPopup = await cancelledPopupPromise;
    await Promise.race([authorizationSeen, sleep(30_000).then(() => assert.fail('UI did not request authorization'))]);
    const cancelled = await until(async () => (await api(`${prefix}?actor_id=${alice}`)).operations
      .find(candidate => !known.has(candidate.id) && candidate.run_id));
    evidence.jobs.push({ mission_id: cancelled.mission_id, task_id: cancelled.task_id,
      operation_id: cancelled.id, run_id: cancelled.run_id, via: 'browser-cancellation-race' });
    const cancelledArticle = panel.locator('article').filter({ hasText: cancelled.task_id });
    await cancelledArticle.getByRole('button', { name: 'Cancel job', exact: true }).click();
    await until(async () => (await operation(cancelled.task_id))?.status === 'cancelled');
    releaseAuthorization();
    await cancelledArticle.getByText('Cancelled', { exact: true }).waitFor();
    assert.equal(cancelledPopup.isClosed(), true);
    assert.equal(await cancelledArticle.getByRole('button', { name: 'Resume sign-in', exact: true }).count(), 0);
    await panel.getByRole('button', { name: 'Refresh status', exact: true }).click();
    assert.equal(requests, 1);
    await cancelledArticle.screenshot({ path: path.join(fixture.evidence, 'browser-cancelled.png') });
    evidence.checks.push('real-browser-cancellation-fences-delayed-authorize-response-and-closes-popup');
  } catch {
    // Browser diagnostics can include OAuth URLs or fill values.
    assert.fail('Owned browser lifecycle assertion failed (private diagnostics suppressed)');
  } finally {
    releaseAuthorization();
    await browser.close();
  }
}

test('actual ECorp delegated job and integrated negative cases', { skip: !permitted, timeout: 420000 }, async () => {
  // No HTTP, private-config read, or SQL occurs before this ownership proof.
  fixture = ownedFixture();
  ({ lab, base } = fixture);
  ({ corp_id: corp, alice_actor_id: alice, bob_actor_id: bob, room_id: room } = fixture.demo);
  [corp, alice, bob, room].forEach(uuid);
  prefix = `/api/corps/${corp}/delegated`;
  await mkdir(fixture.evidence, { recursive: true });
  const config = JSON.parse(await readFile(path.join(lab, '.private', 'config.json'), 'utf8'));
  try {
    const initial = await api(`${prefix}?actor_id=${alice}`);
    assert.equal(initial.provider, 'keycloak-test');
    assert.equal(initial.enabled, true);
    const deniedResource = await fetch(fixture.resource);
    assert.equal(deniedResource.status, 401);
    evidence.checks.push('protected-resource-denies-anonymous');
    const op = await job();
    const original = scope(op);
    await api('/api/delegated/runner/read', original, 202);
    assert.equal(sql(`SELECT preview IS NULL AND token_ciphertext IS NULL FROM delegated_operations WHERE id='${uuid(op.id)}';`), 't');
    evidence.checks.push('original-assignment-denied-before-auth');
    await api('/api/delegated/runner/read', { ...original, task_id: randomUUID() }, 403);
    await api('/api/delegated/runner/read', { ...original, run_id: randomUUID() }, 403);
    await api('/api/delegated/runner/read', { ...original, connection_epoch: randomUUID() }, 403);
    await api('/api/delegated/runner/read', { ...original, assignment_token: randomUUID() }, 403);
    evidence.checks.push('cross-task-run-epoch-assignment-denied');
    await api(`${prefix}/${op.id}/authorize`, { actor_id: bob }, 403);
    await api(`${prefix}/${op.id}/cancel`, { actor_id: bob }, 403);
    await api(`${prefix}/${op.id}/release`, { actor_id: bob }, 403);
    const other = await api(`${prefix}?actor_id=${bob}`);
    assert.equal(other.operations.length, 0);
    evidence.checks.push('cross-human-authorize-cancel-release-preview-denied');
    assert.equal(await login(op, config.reader), 'returned');
    const preview = await until(async () => { const o = await operation(op.task_id); return o?.private_preview && o; });
    assert.equal(preview.private_preview.sha256, createHash('sha256').update(config.flag).digest('hex'));
    assert.equal(preview.private_preview.verified, true);
    assert.equal(preview.released, false);
    await api('/api/delegated/runner/read', original, 202);
    await api('/api/delegated/runner/read', { ...original, task_id: randomUUID() }, 403);
    await api(`${prefix}/${op.id}/release`, { actor_id: bob }, 403);
    assert.equal(sql(`SELECT token_ciphertext IS NULL AND token_nonce IS NULL FROM delegated_operations WHERE id='${uuid(op.id)}';`), 't');
    evidence.checks.push('pkce-then-keycloak-exchange-protected-read-independent-digest-private-release-gate');
    evidence.checks.push('single-use-browser-ticket-and-callback-replay-denied');
    await api(`${prefix}/${op.id}/release`, { actor_id: alice });
    await until(async () => (await operation(op.task_id))?.status === 'completed', 60000);
    const snapshot = await api(`/api/corps/${corp}/snapshot?actor_id=${alice}`);
    const run = snapshot.snapshot.runs.find(r => r.id === op.run_id);
    assert.equal(run.status, 'completed');
    assert.equal(run.verification_status, 'passed');
    assert.equal(snapshot.snapshot.runs.filter(r => r.task_id === op.task_id).length, 1);
    const download = await fetch(`${base}${run.artifact_uri}?actor_id=${alice}`);
    assert.equal(download.status, 200);
    const artifact = Buffer.from(await download.arrayBuffer());
    assert.equal(createHash('sha256').update(artifact).digest('hex'), run.artifact_sha256);
    const receipt = JSON.parse(artifact.toString('utf8'));
    assert.equal(receipt.run_id, op.run_id);
    assert.equal(receipt.task_id, op.task_id);
    assert.equal(receipt.sha256, preview.private_preview.sha256);
    await writeFile(path.join(fixture.evidence, 'synthetic-receipt.json'), artifact);
    const serialized = JSON.stringify(snapshot);
    assert.ok(!serialized.includes(config.flag) && !serialized.includes(config.connectorSecret) && !serialized.includes(config.reader.password));
    evidence.checks.push('same-original-run-native-artifact-verifier-completion-no-secret-in-shared-state');
    evidence.checks.push('independent-authenticated-artifact-download-sha256-and-exact-receipt');
    const wrongHuman = await job();
    assert.equal(await login(wrongHuman, config.nonreader), 'denied');
    assert.equal((await operation(wrongHuman.task_id)).status, 'failed');
    evidence.checks.push('provider-subject-mismatch-denied');
    const cancelled = await job();
    const cancelledScope = scope(cancelled);
    const ticket = await api(`${prefix}/${cancelled.id}/authorize`, { actor_id: alice });
    await cancel(cancelled);
    await api('/api/delegated/runner/read', cancelledScope, 403);
    const revokedBrowser = await fetch(ticket.browser_url, { redirect: 'manual' });
    assert.equal(revokedBrowser.status, 403);
    evidence.checks.push('cancel-denies-read-and-unopened-auth-ticket');
    const expired = await job();
    const expiredScope = scope(expired);
    sql(`UPDATE delegated_operations SET expires_at=now()-interval '1 second' WHERE id='${uuid(expired.id)}';`);
    // The independent sweeper must converge without a runner read or authorize
    // request triggering cleanup. Listing is read-only.
    await until(async () => (await operation(expired.task_id))?.status === 'expired', 15_000);
    await api('/api/delegated/runner/read', expiredScope, 403);
    await api(`${prefix}/${expired.id}/authorize`, { actor_id: alice }, 403);
    assert.equal((await operation(expired.task_id)).status, 'expired');
    evidence.checks.push('expired-operation-cannot-read-or-reopen');
    const tokenExpired = await job();
    assert.equal(await login(tokenExpired, config.reader), 'returned');
    await until(async () => (await operation(tokenExpired.task_id))?.private_preview);
    // Controlled test-admin clock fault, not a production API or credential shortcut.
    sql(`UPDATE delegated_operations SET preview=NULL,token_expires_at=now()-interval '1 second' WHERE id='${uuid(tokenExpired.id)}';`);
    await until(async () => (await operation(tokenExpired.task_id))?.status === 'expired', 15_000);
    await api('/api/delegated/runner/read', scope(tokenExpired), 403);
    assert.equal((await operation(tokenExpired.task_id)).status, 'expired');
    await api(`${prefix}/${tokenExpired.id}/release`, { actor_id: alice }, 403);
    evidence.checks.push('expired-downstream-grant-cannot-read-or-release-clock-fault');
    await browserLifecycle(config);
    evidence.outcome = 'PASSED';
  } catch (error) {
    evidence.outcome = 'FAILED';
    // Assertions use public statuses only. Never persist provider URL/body or credentials.
    evidence.failed_check = evidence.checks.length;
    throw error;
  } finally {
    await writeFile(path.join(fixture.evidence, 'synthetic-integration.json'),
      JSON.stringify(evidence, null, 2));
  }
});
