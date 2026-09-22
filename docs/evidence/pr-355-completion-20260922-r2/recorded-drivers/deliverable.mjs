import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import path from 'node:path';

const root = process.env.ECORP_COMPLETION_QA_ROOT;
assert.match(root ?? '', /[\\/]qa[\\/]pr265-run-activity-pr355-20260922-r\d+$/);
assert.equal(process.env.ECORP_COMPLETION_PR, '355');
const ownership = JSON.parse(await readFile(path.join(root, 'ownership.json'), 'utf8'));
assert.equal(ownership.test_owned, true);
assert.equal(ownership.purpose, 'pr265-run-activity');
assert.equal(path.resolve(ownership.workspace), path.resolve(root));
const { demo, source, plan } = ownership;
assert.equal(plan.server, 'http://127.0.0.1:29355');
assert.equal(plan.web, 'http://127.0.0.1:26355');
assert.ok(ownership.processes.server.pid && ownership.processes.runner.pid);
const sourcePath = path.join(root, 'source');
const runRoot = path.join(root, 'runner');
const execute = promisify(execFile);
const git = async (at, ...args) => (await execute('git', ['-C', at, ...args], { windowsHide: true, timeout: 15000 })).stdout.trim();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = { pr: 355, status: 'running', started_at: new Date().toISOString(), source,
  scope: 'Real Edge browser launches deterministic native runner missions on a fresh owned PostgreSQL fixture; no vendor inference or external publication.',
  scenarios: [], errors: [], blocked_requests: [] };
const destination = path.join(root, 'evidence', 'pr355-preserved-export.json');
const save = () => writeFile(destination, `${JSON.stringify(report, null, 2)}\n`);
let browser, page;
async function api(route, body) {
  const response = await fetch(`${plan.server}${route}`, { method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000) });
  assert.equal(response.status, 200, `${route}: ${response.status} ${await response.clone().text()}`);
  return response.json();
}
const snapshot = () => api(`/api/corps/${demo.corp_id}/snapshot?actor_id=${demo.alice_actor_id}`);
function view(state, id) {
  const s = state.snapshot;
  const tasks = s.tasks.filter(item => item.mission_id === id);
  const taskIds = new Set(tasks.map(item => item.id));
  return { mission: s.missions.find(item => item.id === id), tasks,
    runs: s.runs.filter(item => taskIds.has(item.task_id)), state: s };
}
async function until(label, read, predicate, timeout = 90000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    last = await read();
    if (predicate(last)) return last;
    await pause(200);
  }
  throw new Error(`Timed out waiting for ${label}; last mission status=${last?.mission?.status}`);
}
async function fingerprint(at) {
  const index = await git(at, 'rev-parse', '--path-format=absolute', '--git-path', 'index');
  return { head: await git(at, 'rev-parse', 'HEAD'), index_sha256: hash(await readFile(index)),
    status: await git(at, 'status', '--porcelain=v1', '--untracked-files=all'),
    readme_sha256: hash(await readFile(path.join(at, 'README.md'))) };
}
async function capture(name) {
  const file = path.join(root, 'evidence', `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  return { file: path.basename(file), sha256: hash(await readFile(file)) };
}
async function scenario(label, writeScope, outcome) {
  const body = { title: `[portable-deliverable] PR355 ${label} ${randomUUID().slice(0, 8)}`,
    description: 'Owned acceptance of preserved complete source scope. No external effects.',
    requested_by: demo.alice_actor_id, preferred_adapter: 'fake-process', strategy: 'single',
    source, max_task_attempts: 2, secret_refs: [], budget_tokens: 1000,
    budget_cost_microusd: 1000000,
    deliverable: { form: 'commit_branch', commit_after_verification: true, paths: [] },
    contract: { objective: 'Export the complete deterministic worktree', expected_output: 'result.md',
      write_scope: writeScope, allowed_tools: ['filesystem'], prohibited_actions: ['No external effects'] },
    verification_policy: { checks: [{ type: 'file', path: 'result.md', min_bytes: 1 }], manual_gate: null } };
  const created = await api(`/api/corps/${demo.corp_id}/missions`, body);
  const receipt = { label, created, request: body };
  report.scenarios.push(receipt); await save();
  await page.goto(`${plan.web}/#missions`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.locator('.live-indicator.live-live').waitFor({ timeout: 30000 });
  const card = page.locator(`[data-mission-id="${created.mission_id}"]`);
  await card.locator('.status-chip-ready').waitFor();
  const launched = page.waitForResponse(r => r.url() === `${plan.server}/api/corps/${demo.corp_id}/missions/${created.mission_id}/launch` && r.request().method() === 'POST');
  await card.getByTestId('work-result-card').getByRole('button', { name: 'Start mission', exact: true }).click();
  assert.equal((await launched).status(), 200);
  const done = await until(label, async () => view(await snapshot(), created.mission_id), s =>
    s.runs.length === 1 && s.mission.status === outcome && s.runs[0].workspace_disposition === 'preserved');
  const run = done.runs[0];
  assert.equal(run.status, outcome);
  assert.equal(run.runner_id, plan.runner_id);
  assert.equal(run.source_base_commit, source.base_commit);
  assert.equal(done.tasks[0].max_attempts, 2);
  const relative = path.relative(runRoot, run.workspace_path);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  const events = done.state.events.filter(event => event.aggregate_id === run.id);
  const evidence = done.state.verification_evidence.filter(item => item.run_id === run.id);
  assert.equal(evidence.length, 1); assert.equal(evidence[0].status, 'passed');
  const files = {};
  for (const name of ['README.md', 'portable-untracked.txt', 'result.md']) {
    const bytes = await readFile(path.join(run.workspace_path, name));
    assert.ok(bytes.length); files[name] = hash(bytes);
  }
  assert.match(await readFile(path.join(run.workspace_path, 'README.md'), 'utf8'), /Portable deliverable fixture: tracked change/);
  if (outcome === 'failed') {
    const failure = events.filter(event => event.type === 'run.failed');
    assert.equal(failure.length, 1);
    assert.equal(failure[0].payload.failure_kind, 'deliverable_export');
    assert.match(failure[0].payload.error, /outside the task write scope/);
    assert.match(failure[0].payload.error, /Automatic fresh-worktree retry is disabled/);
    assert.equal(events.filter(event => event.type === 'run.completed').length, 0);
    assert.equal(run.deliverable_sha256, null);
    const kept = await fingerprint(run.workspace_path);
    assert.equal(kept.head, source.base_commit);
    await pause(3000);
    const later = view(await snapshot(), created.mission_id);
    assert.equal(later.runs.length, 1); assert.equal(later.mission.status, 'failed');
    assert.deepEqual(await fingerprint(run.workspace_path), kept);
    for (const [name, digest] of Object.entries(files)) assert.equal(hash(await readFile(path.join(run.workspace_path, name))), digest);
    receipt.no_fresh_workspace_retry = true; receipt.preserved_fingerprint = kept;
  } else {
    assert.match(run.deliverable_sha256, /^[a-f0-9]{64}$/);
    assert.equal(events.filter(event => event.type === 'run.completed').length, 1);
    assert.notEqual(await git(run.workspace_path, 'rev-parse', 'HEAD'), source.base_commit);
    const changed = (await git(run.workspace_path, 'diff', '--name-only', source.base_commit, 'HEAD')).split(/\r?\n/);
    // The product contract exports source changes and retains provider evidence separately.
    assert.deepEqual(changed.sort(), ['README.md', 'portable-untracked.txt'].sort());
    for (const name of changed) {
      const committed = await execute('git', ['-C', run.workspace_path, 'show', `HEAD:${name}`], {
        windowsHide: true, timeout: 15000, encoding: 'buffer',
      });
      assert.equal(hash(committed.stdout), files[name], `${name} committed bytes differ from verified source`);
    }
    const providerEvidence = events.filter(event => event.type === 'run.artifact'
      && event.payload.artifact_role === 'provider_evidence' && event.payload.file_name === 'result.md');
    assert.equal(providerEvidence.length, 1);
    assert.equal(providerEvidence[0].payload.sha256, files['result.md']);
    assert.equal(providerEvidence[0].payload.metadata.workspace_relative_path, 'result.md');
    assert.match(await git(run.workspace_path, 'status', '--porcelain=v1'), /\?\? result\.md/);
    receipt.provider_evidence_retained_separately = {
      artifact_id: providerEvidence[0].payload.artifact_id, sha256: files['result.md'],
      excluded_from_source_commit: true, preserved_in_worktree: true,
    };
    receipt.committed_files = changed;
  }
  receipt.final = { mission: done.mission, tasks: done.tasks, run, events, evidence, files };
  await until('browser final status', () => card.innerText(), text => text.toLowerCase().includes(outcome), 30000);
  receipt.screenshot = await capture(`pr355-${label}`);
  await save();
}
try {
  const before = await fingerprint(sourcePath);
  assert.equal(before.head, source.base_commit); assert.equal(before.status, '');
  const require = createRequire(import.meta.url);
  const { chromium } = require(process.env.CRONY_PLAYWRIGHT_MODULE);
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, reducedMotion: 'reduce' });
  await context.route('**/*', async route => {
    const u = new URL(route.request().url());
    if (![plan.server, plan.web].includes(u.origin) || u.pathname === '/api/demo/reset' || /verification-decision|action-approval/.test(u.pathname)) {
      report.blocked_requests.push({ origin: u.origin, path: u.pathname }); await route.abort();
    } else await route.continue();
  });
  page = await context.newPage();
  page.on('pageerror', e => report.errors.push(e.message));
  await scenario('restricted-scope', ['result.md'], 'failed');
  await scenario('complete-scope', ['README.md', 'portable-untracked.txt', 'result.md'], 'completed');
  const after = await fingerprint(sourcePath);
  assert.deepEqual(after, before);
  assert.equal(report.errors.length, 0); assert.equal(report.blocked_requests.length, 0);
  report.source_fingerprint = { before, after }; report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.failure = error.message;
  if (page) report.failure_screenshot = await capture('pr355-failure').catch(() => null);
  process.exitCode = 1;
} finally {
  await browser?.close(); report.finished_at = new Date().toISOString(); await save();
  console.log(JSON.stringify({ status: report.status, failure: report.failure, report: destination }));
}
