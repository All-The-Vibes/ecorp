// Explicit synthetic acceptance. Never run this against a real human/Entra account.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const lab = process.env.ECORP_DELEGATED_LAB
  ? path.resolve(process.env.ECORP_DELEGATED_LAB)
  : path.join(root, 'tools', 'fixtures', 'delegated-keycloak');
const base = 'http://127.0.0.1:8791';
const corp = '00000000-0000-4000-8000-000000000001';
const alice = '00000000-0000-4000-8000-000000000011';
const bob = '00000000-0000-4000-8000-000000000012';
const room = '00000000-0000-4000-8000-000000000041';
const prefix = `/api/corps/${corp}/delegated`;
const evidence = { kind: 'AUTOMATED_SYNTHETIC_NOT_HUMAN_ACCEPTANCE', live_azure: 'NOT_EXECUTED', checks: [], jobs: [] };
const permitted = process.env.ECORP_SYNTHETIC_OBO_TEST === '1';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function api(url, body, expected = 200) {
  const response = await fetch(base + url, body ? {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  } : {});
  assert.equal(response.status, expected, `Unexpected HTTP status for ${url.split('?')[0]}`);
  return response.json();
}
function sql(query) {
  return execFileSync('docker', ['exec', '-i', 'ecorp-obo-285-postgres-1', 'psql', '-U', 'crony', '-d', 'crony', '-At', '-v', 'ON_ERROR_STOP=1'],
    { input: query, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
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
    FROM runs r JOIN runner_nodes n ON n.id=r.runner_id WHERE r.id='${op.run_id}';`));
}
async function cancel(op) { await api(`${prefix}/${op.id}/cancel`, { actor_id: alice }); }
async function login(op, user) {
  const { chromium } = await import(pathToFileURL(path.join(lab, 'node_modules', 'playwright', 'index.mjs')).href);
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
    await page.waitForURL(/127\.0\.0\.1:5187\/\?delegated_auth=/);
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

test('actual ECorp delegated job and integrated negative cases', { skip: !permitted, timeout: 180000 }, async () => {
  await mkdir(path.join(root, 'output', 'delegated-evidence'), { recursive: true });
  const config = JSON.parse(await readFile(path.join(lab, '.private', 'config.json'), 'utf8'));
  try {
    const initial = await api(`${prefix}?actor_id=${alice}`);
    assert.equal(initial.provider, 'keycloak-test');
    assert.equal(initial.enabled, true);
    const deniedResource = await fetch('http://127.0.0.1:18883/flag');
    assert.equal(deniedResource.status, 401);
    evidence.checks.push('protected-resource-denies-anonymous');
    const op = await job();
    const original = scope(op);
    await api('/api/delegated/runner/read', original, 202);
    assert.equal(sql(`SELECT preview IS NULL AND token_ciphertext IS NULL FROM delegated_operations WHERE id='${op.id}';`), 't');
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
    assert.equal(sql(`SELECT token_ciphertext IS NULL AND token_nonce IS NULL FROM delegated_operations WHERE id='${op.id}';`), 't');
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
    await writeFile(path.join(root, 'output', 'delegated-evidence', 'synthetic-receipt.json'), artifact);
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
    sql(`UPDATE delegated_operations SET expires_at=now()-interval '1 second' WHERE id='${expired.id}';`);
    await api('/api/delegated/runner/read', expiredScope, 403);
    await api(`${prefix}/${expired.id}/authorize`, { actor_id: alice }, 403);
    assert.equal((await operation(expired.task_id)).status, 'expired');
    evidence.checks.push('expired-operation-cannot-read-or-reopen');
    const tokenExpired = await job();
    assert.equal(await login(tokenExpired, config.reader), 'returned');
    await until(async () => (await operation(tokenExpired.task_id))?.private_preview);
    // Controlled test-admin clock fault, not a production API or credential shortcut.
    sql(`UPDATE delegated_operations SET preview=NULL,token_expires_at=now()-interval '1 second' WHERE id='${tokenExpired.id}';`);
    await api('/api/delegated/runner/read', scope(tokenExpired), 403);
    assert.equal((await operation(tokenExpired.task_id)).status, 'expired');
    await api(`${prefix}/${tokenExpired.id}/release`, { actor_id: alice }, 403);
    evidence.checks.push('expired-downstream-grant-cannot-read-or-release-clock-fault');
    evidence.outcome = 'PASSED';
  } catch (error) {
    evidence.outcome = 'FAILED';
    // Assertions use public statuses only. Never persist provider URL/body or credentials.
    evidence.failed_check = evidence.checks.length;
    throw error;
  } finally {
    await writeFile(path.join(root, 'output', 'delegated-evidence', 'synthetic-integration.json'),
      JSON.stringify(evidence, null, 2));
  }
});
