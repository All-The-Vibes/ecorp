import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixtureSnapshot } from '../scenarios/repo-steward/fixtures/demo.mjs';
import { audit } from '../scenarios/repo-steward/lib/steward.mjs';
import { readAuditState } from '../scenarios/repo-steward/lib/recurring-audit.mjs';

// Executes real local CLI processes against explicit synthetic inputs. No live
// collection, provider, ECorp server, GitHub mutation or scheduler is invoked.
assert.equal(process.argv.length, 4, 'Usage: node tools/e2e_steward_maintenance.mjs --output NEW_ABSOLUTE_DIRECTORY');
assert.equal(process.argv[2], '--output');
assert.ok(path.isAbsolute(process.argv[3]), 'An absolute owned output directory is required.');
const output = path.resolve(process.argv[3]);
assert.equal(existsSync(output), false, 'Preserve existing acceptance evidence; choose a new output directory.');
mkdirSync(output);
const repo = fileURLToPath(new URL('../', import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const save = (name, value) => {
  const file = path.join(output, name);
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return file;
};
const commands = [], assertions = [], started = new Date().toISOString();
function check(name, operation) { operation(); assertions.push({ name, passed: true }); }
function invoke(script, args, expected = 0) {
  const result = spawnSync(process.execPath, [path.join(repo, 'scenarios/repo-steward', script), ...args],
    { cwd: repo, windowsHide: true, timeout: 30000, maxBuffer: 1048576, encoding: 'utf8' });
  const record = { index: commands.length + 1, script, args, status: result.status,
    stdout: result.stdout, stderr: result.stderr, error_code: result.error?.code ?? null };
  save(`command-${String(record.index).padStart(2, '0')}.json`, record);
  commands.push(record);
  assert.equal(result.error, undefined);
  assert.equal(result.status, expected, result.stderr);
  return JSON.parse(expected === 0 ? result.stdout : result.stderr);
}
const snapshot = fixtureSnapshot(), source = snapshot.scope.source_commit;
const input = save('snapshot.json', snapshot), state = path.join(output, 'audit-state');
const common = ['--state-dir', state, '--source-commit', source];
const once = extra => invoke('maintenance.mjs', ['once', ...common, '--snapshot', input, ...extra]);
const artifact = (directory, reference) => {
  const bytes = readFileSync(path.join(directory, reference.file));
  assert.equal(sha(bytes), reference.sha256);
  return JSON.parse(bytes);
};
const snapshotWrite = value => writeFileSync(input, JSON.stringify(value, null, 2) + '\n');
try {
  const first = once([]), original = readAuditState({ stateDirectory: state });
  check('first real CLI audit records findings', () => assert.equal(first.cycles[0].status, 'recorded'));
  const repeated = invoke('maintenance.mjs', ['watch', ...common, '--snapshot', input, '--cycles', '3', '--interval-ms', '1000', '--duration-ms', '10000']);
  const afterRepeat = readAuditState({ stateDirectory: state });
  check('finite recurring CLI produces three no-ops and no duplicate handoff', () => {
    assert.equal(repeated.completed_cycles, 3);
    assert.ok(repeated.cycles.every(cycle => cycle.status === 'no-op'));
    assert.equal(afterRepeat.attempts, 4);
    assert.deepEqual(artifact(state, afterRepeat.checkpoint).latest.handoff, artifact(state, original.checkpoint).latest.handoff);
  });
  snapshot.issues.find(issue => issue.number === 27).state = 'CLOSED';
  snapshot.captured_at = new Date().toISOString(); snapshotWrite(snapshot);
  check('changed finding facts produce a new observation after process restart', () => assert.equal(once([]).cycles[0].status, 'recorded'));
  snapshot.captured_at = new Date().toISOString(); snapshotWrite(snapshot);
  check('capture time alone preserves deduplication', () => assert.equal(once([]).cycles[0].status, 'no-op'));
  invoke('maintenance.mjs', ['pause', ...common, '--reason', 'Acceptance pause']);
  writeFileSync(input, 'invalid JSON while paused');
  check('durable pause prevents snapshot reads', () => assert.equal(once([]).exit_reason, 'paused'));
  snapshotWrite(snapshot);
  invoke('maintenance.mjs', ['resume', ...common, '--reason', 'Acceptance resume']);
  check('resumed process preserves prior finding history', () => assert.equal(once([]).cycles[0].status, 'no-op'));
  invoke('maintenance.mjs', ['stop', ...common, '--reason', 'Acceptance scope complete']);
  check('terminal stop rejects resume', () => assert.equal(invoke('maintenance.mjs', ['resume', ...common, '--reason', 'Must refuse'], 1).error, 'STOPPED'));

  const stale = structuredClone(snapshot); stale.captured_at = new Date(Date.now() - 7200000).toISOString();
  const staleInput = save('stale.json', stale), staleState = path.join(output, 'stale-state');
  check('stale snapshot failure is durable', () => {
    assert.equal(invoke('maintenance.mjs', ['once', '--state-dir', staleState, '--source-commit', source, '--snapshot', staleInput], 1).error, 'STALE_SNAPSHOT');
    const failedState = readAuditState({ stateDirectory: staleState });
    assert.equal(failedState.attempts, 1);
    const failureReceipt = artifact(staleState, artifact(staleState, failedState.checkpoint).receipt);
    assert.equal(failureReceipt.kind, 'audit-cycle-failure');
    assert.equal(failureReceipt.error, 'STALE_SNAPSHOT');
  });
  const partial = structuredClone(snapshot); partial.coverage.complete = false;
  const partialInput = save('partial.json', partial);
  check('partial snapshot is refused', () => assert.equal(invoke('maintenance.mjs', ['once', '--state-dir', path.join(output, 'partial-state'), '--source-commit', source, '--snapshot', partialInput], 1).error, 'INCOMPLETE'));

  const fresh = fixtureSnapshot(), freshInput = save('feedback-snapshot.json', fresh);
  const findings = audit(fresh).findings.filter(finding => finding.rule === 'WORKSTREAM_UNTAGGED').slice(0, 2);
  assert.equal(findings.length, 2);
  const corpus0 = path.join(output, 'corpus-0.json');
  invoke('feedback.mjs', ['init', '--snapshot', freshInput, '--out', corpus0]);
  const evidence = findings.map((finding, index) => {
    const file = path.join(output, `finding-evidence-${index}.json`);
    invoke('feedback.mjs', ['evidence', '--snapshot', freshInput, '--finding', finding.id, '--out', file]);
    return JSON.parse(readFileSync(file));
  });
  const proposal = save('proposal.json', { rule: 'WORKSTREAM_UNTAGGED', guidance: {
    text: 'Inspect source references before suggesting workstream labels; do not infer an assignee.', route: 'inspect-evidence' },
    evidence, expiresAt: new Date(Date.now() + 86400000).toISOString() });
  const corpus1 = path.join(output, 'corpus-1.json');
  const proposed = invoke('feedback.mjs', ['propose', '--corpus', corpus0, '--input', proposal, '--out', corpus1]);
  const reviewFile = path.join(output, 'fixture-review.md');
  writeFileSync(reviewFile, 'Synthetic operator-supplied review for CLI acceptance. This does not verify reviewer identity or independence.\n', { flag: 'wx' });
  const decision = save('decision.json', { candidateId: proposed.record_id, expectedCandidateDigest: proposed.record_digest,
    decision: 'activate', reviewEvidence: { sha256: '0'.repeat(64), reason: 'Fixture verifies additive, source-bound local guidance.' } });
  const protectedInputs = new Map([corpus0, corpus1, proposal, decision, reviewFile, freshInput].map(file => [file, sha(readFileSync(file))]));
  const corpus2 = path.join(output, 'corpus-2.json');
  const activated = invoke('feedback.mjs', ['review', '--corpus', corpus1, '--input', decision, '--review-file', reviewFile, '--out', corpus2]);
  const active = JSON.parse(readFileSync(corpus2));
  protectedInputs.set(corpus2, sha(readFileSync(corpus2)));
  check('review records actual file digest without identity claims', () => {
    assert.equal(active.records[0].review.evidence_sha256, sha(readFileSync(reviewFile)));
    assert.equal(active.records[0].review.independent_review_verified, false);
    assert.equal(active.records[0].review.human_approval_verified, false);
  });
  const feedbackState = path.join(output, 'feedback-state');
  const feedbackArgs = ['once', '--state-dir', feedbackState, '--source-commit', source, '--snapshot', freshInput];
  invoke('maintenance.mjs', [...feedbackArgs, '--corpus', corpus1]);
  const candidateCheckpoint = artifact(feedbackState, readAuditState({ stateDirectory: feedbackState }).checkpoint);
  check('unreviewed candidate contributes no guidance', () => assert.equal(artifact(feedbackState, candidateCheckpoint.latest.feedback).annotations.length, 0));
  const withActive = invoke('maintenance.mjs', [...feedbackArgs, '--corpus', corpus2]);
  check('later real CLI audit consumes activated feedback', () => assert.equal(withActive.cycles[0].status, 'recorded'));
  const observed = readAuditState({ stateDirectory: feedbackState });
  const current = artifact(feedbackState, observed.checkpoint);
  const feedback = artifact(feedbackState, current.latest.feedback);
  const report = artifact(feedbackState, current.latest.report);
  check('guidance is additive and original findings remain unchanged', () => {
    assert.ok(feedback.annotations.length > 0);
    assert.deepEqual(report.findings, audit(fresh).findings);
    assert.ok(feedback.annotations.every(item => item.advisory_only && item.authority === 'none'));
    for (const item of feedback.annotations) {
      assert.equal(item.feedback_rule_id, activated.record_id);
      assert.equal(item.feedback_rule_digest, activated.record_digest);
      assert.deepEqual(item.guidance, JSON.parse(readFileSync(proposal)).guidance);
      assert.deepEqual([...item.evidence_ids].sort(), evidence.map(entry => entry.evidence_id).sort());
    }
  });
  check('active guidance is deduplicated on replay', () => assert.equal(invoke('maintenance.mjs', [...feedbackArgs, '--corpus', corpus2]).cycles[0].status, 'no-op'));
  const retirement = save('retirement.json', { ruleId: activated.record_id, expectedRuleDigest: activated.record_digest, reason: 'Fixture scope finished.' });
  const corpus3 = path.join(output, 'corpus-3.json');
  invoke('feedback.mjs', ['retire', '--corpus', corpus2, '--input', retirement, '--out', corpus3]);
  invoke('maintenance.mjs', [...feedbackArgs, '--corpus', corpus3]);
  const retiredCheckpoint = artifact(feedbackState, readAuditState({ stateDirectory: feedbackState }).checkpoint);
  check('retired guidance is excluded from the next audit', () => assert.equal(artifact(feedbackState, retiredCheckpoint.latest.feedback).annotations.length, 0));
  check('stale review cannot be applied to an active corpus', () => {
    const result = invoke('feedback.mjs', ['review', '--corpus', corpus2, '--input', decision, '--review-file', reviewFile, '--out', path.join(output, 'must-not-exist.json')], 1);
    assert.equal(result.error, 'FEEDBACK_STALE');
    assert.equal(existsSync(path.join(output, 'must-not-exist.json')), false);
  });
  check('all source snapshots, reviews and prior corpus versions remain byte-identical', () => {
    for (const [file, digest] of protectedInputs) assert.equal(sha(readFileSync(file)), digest);
  });
  const pins = ['maintenance.mjs', 'feedback.mjs', 'lib/recurring-audit.mjs', 'lib/feedback.mjs', 'lib/steward.mjs', 'lib/common.mjs', 'policy.json']
    .map(file => ({ file: `scenarios/repo-steward/${file}`, sha256: sha(readFileSync(path.join(repo, 'scenarios/repo-steward', file))) }));
  const result = { schema_version: 1, status: 'passed', started_at: started, finished_at: new Date().toISOString(),
    node: process.version, commands: commands.length, assertions, source_files: pins,
    scope: 'Real local CLI processes and persistent files; all repository snapshots and review inputs are explicit synthetic fixtures.',
    live_collection: false, provider_inference: false, authenticated_review: false, remote_mutations: 0, scheduler_installed: false };
  save('result.json', result);
  console.log(JSON.stringify({ status: result.status, commands: result.commands, passed: assertions.length, output }, null, 2));
} catch (error) {
  save('failure.json', { status: 'failed', started_at: started, failed_at: new Date().toISOString(), completed_commands: commands.length,
    assertions, error: String(error.message).slice(0, 2000), evidence_preserved: true });
  throw error;
}
