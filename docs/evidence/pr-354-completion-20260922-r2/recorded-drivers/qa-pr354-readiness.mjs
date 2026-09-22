import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.env.ECORP_COMPLETION_QA_ROOT;
assert.match(root ?? '', /[\\/]qa[\\/]pr265-run-activity-pr354-20260922-r\d+$/);
assert.equal(process.env.ECORP_COMPLETION_PR, '354');
const ownership = JSON.parse(await readFile(path.join(root, 'ownership.json'), 'utf8'));
assert.equal(ownership.test_owned, true);
assert.equal(ownership.purpose, 'pr265-run-activity');
assert.equal(path.resolve(ownership.workspace), path.resolve(root));
assert.match(ownership.plan.server, /^http:\/\/127\.0\.0\.1:29354$/);
assert.equal(ownership.plan.database.port, 25354);
assert.match(ownership.demo.corp_id, /^[0-9a-f-]{36}$/);
const { demo, source } = ownership;
const [owner, name] = source.repository.split('/');
assert.ok(owner && name);
const contract = {
  objective: 'Observe dispatch readiness without claiming or dispatching work',
  expected_output: 'result.md', allowed_tools: ['filesystem'],
  prohibited_actions: ['No external effects'], write_scope: ['result.md'],
};
const request = {
  actor_id: demo.alice_actor_id,
  source_repository_owner: owner, source_repository_name: name,
  title: 'PR354 owned native dispatch readiness',
  description: 'Deterministic local acceptance; no provider execution',
  preferred_adapter: 'fake-process', strategy: 'single',
  budget_tokens: 1000, budget_cost_microusd: 1000000, contract,
  policy: {
    schema_version: 1, source_of_truth: 'github_project', auto_merge: false,
    repository_allowlist: [source.repository], source_base_ref: source.base_ref,
    source_base_commit: source.base_commit, adapter_allowlist: ['fake-process'],
    strategy_allowlist: ['single'], model: null, reasoning_effort: null,
    write_scope: contract.write_scope, allowed_tools: contract.allowed_tools,
    prohibited_actions: contract.prohibited_actions, secret_ids: [],
    verification_required: true, budget_tokens: 1000, budget_cost_microusd: 1000000,
  },
};
const report = {
  pr: 354, started_at: new Date().toISOString(), status: 'running',
  scope: 'Real HTTP server and reconciled native runner on a new owned PostgreSQL fixture; no claims, dispatch, external publication, or vendor inference.',
  source, assertions: [],
};
const destination = path.join(root, 'evidence', 'pr354-dispatch-readiness.json');
const save = () => writeFile(destination, `${JSON.stringify(report, null, 2)}\n`, { flag: 'w' });
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function ledger() {
  const tables = ['factory_work_items', 'factory_operations', 'missions', 'tasks',
    'runs', 'events', 'factory_controllers', 'factory_controller_operations'];
  const fields = tables.map(table => `'${table}', (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text), '[]'::jsonb) FROM ${table} t WHERE corp_id='${demo.corp_id}'::uuid)`);
  const sql = `SELECT jsonb_build_object(${fields.join(', ')});`;
  const result = spawnSync(process.env.ECORP_COMPLETION_PSQL, [
    '-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1', '-p', '25354',
    '-U', 'pr265_qa', '-d', 'pr265_activity', '-c', sql,
  ], { encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(result.status, 0, `Owned ledger read failed: ${result.error?.code ?? result.status}`);
  return JSON.parse(result.stdout.trim());
}
async function preflight(body) {
  const response = await fetch(`${ownership.plan.server}/api/corps/${demo.corp_id}/factory/preflight`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
  });
  const text = await response.text();
  let payload;
  try { payload = JSON.parse(text); } catch { payload = text; }
  return { status: response.status, payload };
}
try {
  // Seed deterministic staff only in this freshly owned fixture, before taking
  // the ledger baseline. Plan-only fake-process preflight uses existing staff.
  const bootstrap = await fetch(`${ownership.plan.server}/api/demo/bootstrap?seed_crew=true`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    signal: AbortSignal.timeout(15000),
  });
  assert.equal(bootstrap.status, 200);
  assert.deepEqual(await bootstrap.json(), demo);
  report.fixture_setup = 'Deterministic crew seeded before all ledger measurements';
  // Reconciliation is asynchronous; wait on the actual selector before measuring.
  const deadline = Date.now() + 45000;
  let ready;
  do {
    ready = await preflight(request);
    assert.equal(ready.status, 200, JSON.stringify(ready));
    if (ready.payload.dispatch_readiness?.status === 'ready') break;
    await new Promise(resolve => setTimeout(resolve, 200));
  } while (Date.now() < deadline);
  assert.equal(ready.payload.dispatch_readiness?.status, 'ready');
  const before = ledger();
  const mismatched = structuredClone(request);
  mismatched.policy.source_base_commit = source.base_commit === 'a'.repeat(40) ? 'b'.repeat(40) : 'a'.repeat(40);
  const offline = await preflight(mismatched);
  assert.equal(offline.status, 200);
  assert.equal(offline.payload.valid, true);
  assert.equal(offline.payload.dispatch_readiness.status, 'not_ready');
  assert.ok(offline.payload.dispatch_readiness.reason);
  assert.deepEqual(ledger(), before);
  report.assertions.push({ name: 'Valid plan remains available with a source mismatch', response: offline });
  const strict = await preflight({ ...mismatched, require_dispatch_ready: true });
  assert.equal(strict.status, 409);
  assert.deepEqual(ledger(), before);
  report.assertions.push({ name: 'Execution intent fails before claim or dispatch', response: strict });
  const matching = await preflight({ ...request, require_dispatch_ready: true });
  assert.equal(matching.status, 200);
  assert.deepEqual(matching.payload.dispatch_readiness, { status: 'ready' });
  assert.deepEqual(ledger(), before);
  report.assertions.push({ name: 'Matching immutable source and reconciled native runner are ready', response: matching });
  const denied = await preflight({ ...request, actor_id: demo.eve_actor_id, require_dispatch_ready: true });
  assert.equal(denied.status, 403);
  const after = ledger();
  assert.deepEqual(after, before);
  report.assertions.push({ name: 'Observer cannot acquire execution authority through preflight', response: denied });
  report.ledger = { tables: Object.keys(before), before_sha256: digest(before), after_sha256: digest(after), exact_rows_unchanged: true };
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.failure = error.message;
  throw error;
} finally {
  report.finished_at = new Date().toISOString();
  await save();
  console.log(JSON.stringify(report, null, 2));
}
