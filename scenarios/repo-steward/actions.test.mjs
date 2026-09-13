import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendActionSummary, assertLiveContext, parseActionArgs, PUBLIC_RULES, renderActionSummary, runAction } from './actions.mjs';
import { audit } from './lib/steward.mjs';
import { SCOPE } from './lib/common.mjs';
import { fixtureSnapshot } from './fixtures/demo.mjs';

const now = new Date('2026-09-13T23:00:00Z');
const snapshot = () => fixtureSnapshot(now);
const report = () => audit(snapshot(), { now, source: 'synthetic-fixture' });
const validEnv = () => ({
  GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_REPOSITORY: SCOPE.repository, GITHUB_REF: 'refs/heads/main',
  GITHUB_ACTOR: 'Bakar404', GITHUB_TRIGGERING_ACTOR: 'Bakar404',
  GITHUB_SHA: 'a'.repeat(40), GH_TOKEN: 'synthetic-never-used-for-authentication',
  ECORP_STEWARD_ACTIONS_ENABLED: 'true', ECORP_STEWARD_PUBLIC_SUMMARY: 'true',
});

test('Actions preview performs no live reads or summary publication', async () => {
  let calls = 0;
  const result = await runAction([], { collect: async () => { calls++; throw Error('must not run'); } });
  assert.equal(calls, 0); assert.equal(result.result.dry_run, true); assert.equal(result.summary, null);
});
test('Actions fixture uses the real auditor without GitHub access', async () => {
  let calls = 0;
  const result = await runAction(['--fixture'], { now: () => now, collect: async () => { calls++; } });
  assert.equal(calls, 0); assert.equal(result.result.mode, 'synthetic-fixture');
  assert.match(result.summary, /Synthetic fixture/); assert.match(result.summary, /PR_CLOSURE_CONFLICT/);
});
test('invalid workflow input is rejected during preview without data access', async () => {
  let calls = 0;
  await assert.rejects(runAction(['--dry-run'], { env: { GITHUB_ACTIONS: 'true', ECORP_STEWARD_REQUESTED_MODE: 'invalid' }, collect: async () => { calls++; } }), { code: 'ACTION_ARGUMENT' });
  assert.equal(calls, 0);
});
for (const [name, changes, code] of [
  ['non-Actions host', { GITHUB_ACTIONS: undefined }, 'ACTION_EVENT'],
  ['PR event', { GITHUB_EVENT_NAME: 'pull_request' }, 'ACTION_EVENT'],
  ['another repository', { GITHUB_REPOSITORY: 'other/ecorp' }, 'ACTION_SCOPE'],
  ['feature branch', { GITHUB_REF: 'refs/heads/codex/test' }, 'ACTION_SCOPE'],
  ['another actor', { GITHUB_ACTOR: 'other' }, 'ACTION_ACTOR'],
  ['another rerun operator', { GITHUB_TRIGGERING_ACTOR: 'other' }, 'ACTION_ACTOR'],
  ['missing triggering actor', { GITHUB_TRIGGERING_ACTOR: undefined }, 'ACTION_ACTOR'],
  ['missing source commit', { GITHUB_SHA: undefined }, 'ACTION_COMMIT'],
  ['disabled pilot', { ECORP_STEWARD_ACTIONS_ENABLED: undefined }, 'ACTION_NOT_ENABLED'],
  ['unapproved public summary', { ECORP_STEWARD_PUBLIC_SUMMARY: 'false' }, 'ACTION_PUBLICATION'],
  ['missing credential', { GH_TOKEN: undefined }, 'ACTION_CREDENTIAL'],
  ['blank credential', { GH_TOKEN: ' ' }, 'ACTION_CREDENTIAL'],
  ['write-enabled configuration', { ECORP_STEWARD_ALLOW_WRITES: 'true' }, 'ACTION_READ_ONLY'],
]) test('hosted live mode rejects ' + name + ' before reading data', async () => {
  let calls = 0;
  await assert.rejects(runAction(['--live'], { env: { ...validEnv(), ...changes }, collect: async () => { calls++; return snapshot(); }, now: () => now }), { code });
  assert.equal(calls, 0);
});
test('GITHUB_TOKEN does not substitute for Project-readable credentials', () => {
  const env = validEnv(); delete env.GH_TOKEN; env.GITHUB_TOKEN = 'synthetic';
  assert.throws(() => assertLiveContext(env), { code: 'ACTION_CREDENTIAL' });
});
test('an admitted live path collects once and retains zero mutations', async () => {
  let calls = 0;
  const result = await runAction(['--live'], { env: validEnv(), collect: async () => { calls++; return snapshot(); }, now: () => now });
  assert.equal(calls, 1); assert.equal(result.result.github_mutations, 0);
  assert.equal(result.result.raw_snapshot_published, false); assert.equal(result.result.teams_access, false);
});
test('collector failure does not produce a successful report', async () => {
  await assert.rejects(runAction(['--live'], { env: validEnv(), collect: async () => { throw new Error('private native failure'); } }));
});
test('stale hosted snapshots fail instead of publishing old findings', async () => {
  const stale = snapshot(); stale.captured_at = '2026-09-12T00:00:00Z';
  await assert.rejects(runAction(['--live'], { env: validEnv(), collect: async () => stale, now: () => now }), { code: 'ACTION_STALE' });
});
test('public summaries never include free-form source or evidence text', () => {
  const r = report(), canary = 'PRIVATE_FREE_TEXT_CANARY';
  r.agent = canary; r.scope.extra = canary; r.summary.extra = canary;
  for (const finding of r.findings) {
    finding.title = canary; finding.detail = canary; finding.evidence = { secret: canary };
    finding.proposal = { description: canary }; finding.references.forEach(reference => { reference.title = canary; });
  }
  const rendered = renderActionSummary(r);
  assert.ok(!rendered.includes(canary));
  assert.match(rendered, /https:\/\/github.com\/All-The-Vibes\/ecorp\/pull\/237/);
});
for (const [name, mutate, code] of [
  ['unknown rule', r => { r.findings[0].rule = 'UNREVIEWED_RULE'; }, 'ACTION_REPORT_RULE'],
  ['bad finding id', r => { r.findings[0].id = '::error::injected'; }, 'ACTION_REPORT_RULE'],
  ['foreign reference', r => { r.findings.find(finding => finding.references.length).references[0].url = 'https://example.invalid/secret'; }, 'ACTION_REPORT_REFERENCES'],
  ['mutation claim', r => { r.github_mutations = 1; }, 'ACTION_REPORT'],
  ['wrong scope', r => { r.scope.repository = 'other/repo'; }, 'ACTION_REPORT_SCOPE'],
  ['invalid timestamp', r => { r.captured_at = '::error::injected'; }, 'ACTION_REPORT_SOURCE'],
  ['bad totals', r => { r.summary.errors++; }, 'ACTION_REPORT_COUNTS'],
]) test('summary rejects ' + name, () => { const r = report(); mutate(r); assert.throws(() => renderActionSummary(r), { code }); });
test('public finding index is bounded without copying omitted details', () => {
  const r = report(), first = r.findings[0];
  r.findings = Array.from({ length: 120 }, () => structuredClone(first));
  r.summary.errors = first.severity === 'error' ? 120 : 0;
  r.summary.warnings = first.severity === 'warning' ? 120 : 0;
  r.summary.informational = first.severity === 'info' ? 120 : 0;
  const rendered = renderActionSummary(r);
  assert.match(rendered, /Showing 50 of 120/); assert.ok(Buffer.byteLength(rendered) <= 65536);
});
test('every configured fixture rule has an explicit publication review', () => {
  assert.ok(report().findings.every(finding => PUBLIC_RULES.includes(finding.rule)));
});
test('summary file writes remain inside a supplied native temporary directory', () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'ecorp-steward-summary-'));
  const summary = path.join(temp, 'step-summary.md');
  try {
    writeFileSync(summary, '');
    const env = { GITHUB_ACTIONS: 'true', RUNNER_TEMP: temp, GITHUB_STEP_SUMMARY: summary };
    appendActionSummary('fixture-only\n', env); assert.equal(readFileSync(summary, 'utf8'), 'fixture-only\n');
    assert.throws(() => appendActionSummary('no', { ...env, RUNNER_TEMP: path.join(temp, 'missing') }));
    assert.throws(() => appendActionSummary('no', { ...env, GITHUB_ACTIONS: 'false' }), { code: 'ACTION_SUMMARY' });
  } finally {
    try { unlinkSync(summary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    rmdirSync(temp);
  }
});
for (const args of [['--apply'], ['--live', '--fixture'], ['--live', '--token', 'not-accepted']]) {
  test('Actions CLI rejects unsupported arguments ' + args[0], () => assert.throws(() => parseActionArgs(args), { code: 'ACTION_ARGUMENT' }));
}
test('actual fixture CLI needs no hosted secrets or Teams SDK', () => {
  const env = { ...process.env }; delete env.GITHUB_ACTIONS; delete env.GH_TOKEN; delete env.GITHUB_TOKEN;
  const result = JSON.parse(execFileSync(process.execPath, [fileURLToPath(new URL('./actions.mjs', import.meta.url)), '--fixture'], { env, encoding: 'utf8', windowsHide: true }));
  assert.equal(result.mode, 'synthetic-fixture'); assert.equal(result.github_mutations, 0);
});
test('manual workflow keeps first-party actions pinned and live credentials isolated', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/repo-steward.yml', import.meta.url), 'utf8');
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /^\s*(schedule|pull_request|pull_request_target|workflow_run|push):/m);
  assert.match(workflow, /permissions:\s*\n\s+contents: read/);
  assert.doesNotMatch(workflow, /contents: write|issues: write|pull-requests: write|upload-artifact/);
  const uses = [...workflow.matchAll(/uses:\s+(\S+)/g)].map(match => match[1]);
  assert.ok(uses.length > 0 && uses.every(value => /^actions\/(?:checkout|setup-node)@[a-f0-9]{40}$/.test(value)));
  assert.equal((workflow.match(/persist-credentials: false/g) || []).length, 2);
  assert.match(workflow, /environment: repo-steward-readonly/);
  assert.match(workflow, /ECORP_STEWARD_PUBLIC_SUMMARY:/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /node --test steward\.test\.mjs actions\.test\.mjs/);
  assert.doesNotMatch(workflow, /npm (?:ci|install)|teams-host\.mjs/);
});
