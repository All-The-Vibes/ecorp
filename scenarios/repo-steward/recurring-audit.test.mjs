import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fixtureSnapshot } from './fixtures/demo.mjs';
import { runAuditCycle, runAuditCycles, readAuditState, setAuditControl } from './lib/recurring-audit.mjs';
import { audit } from './lib/steward.mjs';
import { SCOPE } from './lib/common.mjs';
import { createFeedbackCorpus, createFeedbackEvidence, feedbackDigest, proposeFeedback, reviewFeedback, retireFeedback } from './lib/feedback.mjs';

const sourceCommit = 'a'.repeat(40);
const now = new Date('2026-09-18T10:00:00.000Z');
const sha = value => createHash('sha256').update(value).digest('hex');
function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ecorp-recurring-audit-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('ecorp-recurring-audit-'));
    assert.equal(lstatSync(root).isSymbolicLink(), false);
    rmSync(root, { recursive: true });
  });
  const stateDirectory = path.join(root, 'state');
  return { root, stateDirectory, options: { stateDirectory, sourceCommit, source: 'synthetic-fixture', now } };
}
const read = (directory, reference) => {
  const bytes = readFileSync(path.join(directory, reference.file));
  assert.equal(sha(bytes), reference.sha256); assert.equal(bytes.length, reference.bytes);
  return JSON.parse(bytes);
};
const code = expected => error => error.code === expected;

test('one audit writes source-bound immutable private reports and an advisory handoff', async t => {
  const { options, stateDirectory } = fixture(t), snapshot = fixtureSnapshot(now), before = structuredClone(snapshot);
  assert.equal(readAuditState({ stateDirectory }), null);
  const result = await runAuditCycle({ ...options, snapshot });
  assert.equal(result.status, 'recorded'); assert.equal(result.attempts, 1); assert.deepEqual(snapshot, before);
  const receipt = read(stateDirectory, result.receipt), handoff = read(stateDirectory, result.handoff);
  assert.equal(receipt.sourceCommit, sourceCommit); assert.equal(receipt.github_mutations, 0);
  assert.deepEqual(receipt.executed_actions, []); assert.equal(handoff.executable, false); assert.equal(handoff.execution_authority, 'none');
  assert.ok(handoff.new_findings.some(f => f.rule === 'PR_CLOSURE_CONFLICT'));
  assert.ok(handoff.new_findings.every(f => !f.proposal || f.proposal.executable === false));
  const state = readAuditState({ stateDirectory }); assert.equal(state.status, 'running'); assert.equal(state.attempts, 1);
  const checkpoint = read(stateDirectory, state.checkpoint);
  assert.deepEqual(Object.keys(checkpoint.implementation_digests).sort(), ['../policy.json', 'collector-profile.mjs', 'common.mjs', 'feedback.mjs', 'github.mjs', 'recurring-audit.mjs', 'steward.mjs']);
  assert.equal(existsSync(path.join(stateDirectory, 'audit.lock')), false);
  if (process.platform !== 'win32') assert.equal(lstatSync(path.join(stateDirectory, result.handoff.file)).mode & 0o777, 0o600);
});

test('fresh capture timestamps and transport metrics alone produce no new report or proposal across restart', async t => {
  const { options, stateDirectory } = fixture(t), firstSnapshot = fixtureSnapshot(now);
  const first = await runAuditCycle({ ...options, snapshot: firstSnapshot });
  const original = read(stateDirectory, first.receipt);
  const secondSnapshot = structuredClone(firstSnapshot);
  secondSnapshot.captured_at = new Date(now.getTime() + 1000).toISOString();
  secondSnapshot.collection = { requests: 19, response_bytes: 10000, authenticated_login: 'Bakar404', writes: 0 };
  const second = await runAuditCycle({ ...options, snapshot: secondSnapshot, now: new Date(now.getTime() + 1000) });
  assert.equal(second.status, 'no-op'); assert.equal(second.handoff, null); assert.deepEqual(second.newFindings, []);
  const receipt = read(stateDirectory, second.receipt);
  assert.deepEqual(receipt.report, original.report); assert.deepEqual(receipt.handoff, original.handoff);
  assert.equal(receipt.evidence_digest, original.evidence_digest); assert.notEqual(receipt.snapshot_digest, original.snapshot_digest);
  assert.equal(readAuditState({ stateDirectory }).attempts, 2);
});

test('live state binds the exact selected principal and profile through restart and controls', async t => {
  const { root, options, stateDirectory } = fixture(t);
  const profile = { schema_version: 1, kind: 'repo-steward-readonly-collector-profile', ...SCOPE, collector_login: 'rajesh-ms' };
  const bytes = Buffer.from(JSON.stringify(profile));
  const collectorProfile = { path: path.join(root, 'collector.json'), sha256: sha(bytes) };
  writeFileSync(collectorProfile.path, bytes, { flag: 'wx' });
  const snapshot = fixtureSnapshot(now);
  snapshot.collection = { authenticated_login: 'rajesh-ms', collector_profile_sha256: collectorProfile.sha256, writes: 0 };
  const live = { ...options, source: 'live-github-two-pass', collectorProfile, snapshot };
  const first = await runAuditCycle(live);
  const binding = { collector_login: 'rajesh-ms', profile_sha256: collectorProfile.sha256 };
  assert.deepEqual(read(stateDirectory, first.receipt).collector, binding);
  assert.deepEqual(readAuditState({ stateDirectory, collectorProfile }).collector, binding);
  assert.equal((await runAuditCycle(live)).status, 'no-op');
  const names = readdirSync(stateDirectory).sort();
  assert.throws(() => readAuditState({ stateDirectory }), { code: 'IMPLEMENTATION_DRIFT' });
  await assert.rejects(setAuditControl({ ...options, action: 'pause', reason: 'Wrong profile omitted' }), { code: 'IMPLEMENTATION_DRIFT' });
  const alternateBytes = Buffer.from(JSON.stringify({ ...profile, collector_login: 'Bakar404' }));
  const alternate = { path: path.join(root, 'alternate.json'), sha256: sha(alternateBytes) };
  writeFileSync(alternate.path, alternateBytes, { flag: 'wx' });
  await assert.rejects(runAuditCycle({ ...live, collectorProfile: alternate }), { code: 'IMPLEMENTATION_DRIFT' });
  assert.deepEqual(readdirSync(stateDirectory).sort(), names);
  assert.equal((await setAuditControl({ ...options, collectorProfile, action: 'pause', reason: 'Inspect actual findings' })).status, 'paused');
  assert.equal((await runAuditCycle(live)).status, 'paused');
  assert.equal((await setAuditControl({ ...options, collectorProfile, action: 'resume', reason: 'Continue same read scope' })).status, 'running');
  assert.equal((await runAuditCycle(live)).status, 'no-op');
  assert.equal((await setAuditControl({ ...options, collectorProfile, action: 'stop', reason: 'Finite cadence complete' })).status, 'stopped');
  writeFileSync(collectorProfile.path, '{}');
  assert.throws(() => readAuditState({ stateDirectory, collectorProfile }), { code: 'COLLECTOR_PROFILE_CHANGED' });
});

test('profile metadata cannot convert supplied evidence or a different live principal into accepted observations', async t => {
  const { root, options, stateDirectory } = fixture(t);
  const bytes = Buffer.from(JSON.stringify({ schema_version: 1, kind: 'repo-steward-readonly-collector-profile', ...SCOPE, collector_login: 'rajesh-ms' }));
  const collectorProfile = { path: path.join(root, 'collector.json'), sha256: sha(bytes) };
  writeFileSync(collectorProfile.path, bytes, { flag: 'wx' });
  const snapshot = fixtureSnapshot(now);
  await assert.rejects(runAuditCycle({ ...options, collectorProfile, snapshot }), { code: 'COLLECTOR_PROFILE_SOURCE' });
  assert.equal(existsSync(stateDirectory), false);
  snapshot.collection = { authenticated_login: 'Bakar404', collector_profile_sha256: collectorProfile.sha256, writes: 0 };
  await assert.rejects(runAuditCycle({ ...options, source: 'live-github-two-pass', collectorProfile, snapshot }), { code: 'SOURCE' });
  const state = readAuditState({ stateDirectory, collectorProfile });
  assert.equal(state.attempts, 1);
  assert.equal(read(stateDirectory, read(stateDirectory, state.checkpoint).receipt).kind, 'audit-cycle-failure');
});

test('changed scoped content produces a new receipt while retaining stable finding dedupe', async t => {
  const { options, stateDirectory } = fixture(t), snapshot = fixtureSnapshot(now);
  const first = await runAuditCycle({ ...options, snapshot });
  const before = read(stateDirectory, first.handoff);
  snapshot.issues[0].title += ' changed'; snapshot.issues[0].updated_at = now.toISOString();
  const second = await runAuditCycle({ ...options, snapshot });
  assert.equal(second.status, 'recorded'); assert.notEqual(second.handoff.sha256, first.handoff.sha256);
  const after = read(stateDirectory, second.handoff);
  assert.ok(after.new_findings.length < before.new_findings.length);
  assert.ok(after.new_findings.every(f => f.references.some(r => r.kind === 'issue' && r.number === snapshot.issues[0].number)));
  assert.deepEqual(after.resolved_finding_ids, []);
});

test('resolved findings are recorded without claiming a remote correction', async t => {
  const { options, stateDirectory } = fixture(t), snapshot = fixtureSnapshot(now);
  const first = await runAuditCycle({ ...options, snapshot });
  const conflict = read(stateDirectory, first.handoff).new_findings.find(f => f.rule === 'PR_CLOSURE_CONFLICT');
  snapshot.pull_requests[0].closes = [];
  const second = await runAuditCycle({ ...options, snapshot });
  assert.ok(second.resolvedFindingIds.includes(conflict.id));
  assert.equal(read(stateDirectory, second.handoff).execution_authority, 'none');
});

for (const [name, mutate, expected] of [
  ['stale input', s => { s.captured_at = new Date(now.getTime() - 31 * 60000).toISOString(); }, 'STALE_SNAPSHOT'],
  ['future input', s => { s.captured_at = new Date(now.getTime() + 6 * 60000).toISOString(); }, 'STALE_SNAPSHOT'],
  ['incomplete input', s => { s.coverage.complete = false; }, 'INCOMPLETE'],
  ['source drift', s => { s.scope.source_commit = 'b'.repeat(40); }, 'SOURCE_DRIFT'],
]) test(`${name} fails and preserves a failed attempt, never reusing previous success`, async t => {
  const { options, stateDirectory } = fixture(t), snapshot = fixtureSnapshot(now);
  const good = await runAuditCycle({ ...options, snapshot });
  mutate(snapshot);
  await assert.rejects(runAuditCycle({ ...options, snapshot }), code(expected));
  const state = readAuditState({ stateDirectory }), checkpoint = read(stateDirectory, state.checkpoint);
  const failure = read(stateDirectory, checkpoint.receipt);
  assert.equal(state.attempts, 2); assert.equal(state.sourceCommit, sourceCommit);
  assert.equal(failure.kind, 'audit-cycle-failure'); assert.equal(failure.error, expected);
  assert.equal(checkpoint.latest.handoff.sha256, good.handoff.sha256);
  assert.equal(existsSync(path.join(stateDirectory, good.receipt.file)), true);
});

test('changing the caller source pin cannot migrate an existing directory', async t => {
  const { options, stateDirectory } = fixture(t);
  await runAuditCycle({ ...options, snapshot: fixtureSnapshot(now) });
  await assert.rejects(runAuditCycle({ ...options, sourceCommit: 'b'.repeat(40), snapshot: fixtureSnapshot(now) }), code('SOURCE_DRIFT'));
  assert.equal(readAuditState({ stateDirectory }).sourceCommit, sourceCommit);
});

test('pause prevents input use, resume retains dedupe, and stop cannot resume', async t => {
  const { options, stateDirectory } = fixture(t);
  await runAuditCycle({ ...options, snapshot: fixtureSnapshot(now) });
  assert.equal((await setAuditControl({ ...options, action: 'pause', reason: 'Operator pause' })).status, 'paused');
  const paused = await runAuditCycle({ ...options, snapshot: null }); assert.equal(paused.status, 'paused'); assert.equal(paused.attempts, 1);
  await setAuditControl({ ...options, action: 'resume', reason: 'Continue the same bounded audit' });
  assert.equal((await runAuditCycle({ ...options, snapshot: fixtureSnapshot(now) })).status, 'no-op');
  await setAuditControl({ ...options, action: 'stop', reason: 'Finished local inspection' });
  assert.equal((await runAuditCycle({ ...options, snapshot: null })).status, 'stopped');
  await assert.rejects(setAuditControl({ ...options, action: 'resume', reason: 'Not permitted' }), code('STOPPED'));
  assert.equal(readAuditState({ stateDirectory }).attempts, 2);
});

test('concurrent cycles have one winner and never create duplicate accepted receipts', async t => {
  const { options, stateDirectory } = fixture(t), snapshot = fixtureSnapshot(now);
  const results = await Promise.allSettled([runAuditCycle({ ...options, snapshot }), runAuditCycle({ ...options, snapshot })]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.code, 'LOCKED');
  assert.equal(readAuditState({ stateDirectory }).attempts, 1);
});

test('retained locks fail closed without PID reuse or timeout-based recovery', async t => {
  const { options, stateDirectory } = fixture(t); mkdirSync(stateDirectory);
  const lock = path.join(stateDirectory, 'audit.lock'); const value = '{"pid":999999,"nonce":"retained"}\n'; writeFileSync(lock, value);
  await assert.rejects(runAuditCycle({ ...options, snapshot: fixtureSnapshot(now) }), code('LOCKED'));
  assert.equal(readFileSync(lock, 'utf8'), value);
});

test('incomplete intent and rollback to an older checkpoint refuse replay', async t => {
  const { options, stateDirectory } = fixture(t), snapshot = fixtureSnapshot(now);
  await runAuditCycle({ ...options, snapshot });
  const first = readFileSync(path.join(stateDirectory, 'state.json'));
  await runAuditCycle({ ...options, snapshot });
  writeFileSync(path.join(stateDirectory, 'state.json'), first);
  await assert.rejects(runAuditCycle({ ...options, snapshot }), code('STATE_AMBIGUOUS'));
  assert.equal(existsSync(path.join(stateDirectory, 'intent-0002.json')), true);
});

test('tampered referenced artifacts are rejected and preserved', async t => {
  const { options, stateDirectory } = fixture(t);
  const first = await runAuditCycle({ ...options, snapshot: fixtureSnapshot(now) });
  const file = path.join(stateDirectory, first.handoff.file); writeFileSync(file, '{}\n');
  await assert.rejects(runAuditCycle({ ...options, snapshot: fixtureSnapshot(now) }), code('STATE_INTEGRITY'));
  assert.equal(readFileSync(file, 'utf8'), '{}\n');
});

test('output-directory redirection refuses writes through a symlink or junction', async t => {
  const { options, root, stateDirectory } = fixture(t), outside = path.join(root, 'outside'); mkdirSync(outside);
  symlinkSync(outside, stateDirectory, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(runAuditCycle({ ...options, snapshot: fixtureSnapshot(now) }), code('STATE_REDIRECT'));
  assert.deepEqual(readdirSync(outside), []);
});

test('an unexpected output file is retained, not overwritten or removed', async t => {
  const { options, stateDirectory } = fixture(t); mkdirSync(stateDirectory);
  const unknown = path.join(stateDirectory, 'operator-notes.txt'); writeFileSync(unknown, 'retained');
  await assert.rejects(runAuditCycle({ ...options, snapshot: fixtureSnapshot(now) }), code('STATE_AMBIGUOUS'));
  assert.equal(readFileSync(unknown, 'utf8'), 'retained');
});

test('missing, traversal-style and incomplete control requests do not create authority', async t => {
  const { options, stateDirectory } = fixture(t);
  await assert.rejects(setAuditControl({ ...options, action: 'pause', reason: 'No state yet' }), code('STATE_MISSING'));
  await assert.rejects(runAuditCycle({ ...options, stateDirectory: '../redirect', snapshot: fixtureSnapshot(now) }), code('STATE_PATH'));
  await assert.rejects(runAuditCycle({ ...options, sourceCommit: 'main', snapshot: fixtureSnapshot(now) }), code('SOURCE_PIN'));
  await assert.rejects(runAuditCycle({ ...options, sourceCommit: 'a'.repeat(41), snapshot: fixtureSnapshot(now) }), code('SOURCE_PIN'));
  assert.equal(existsSync(stateDirectory), false);
});

test('live source claims retain the existing collector identity and zero-write metadata', async t => {
  const { options, stateDirectory } = fixture(t), snapshot = fixtureSnapshot(now);
  snapshot.collection = { authenticated_login: 'another-account', writes: 0 };
  await assert.rejects(runAuditCycle({ ...options, source: 'live-github-two-pass', snapshot }), code('SOURCE'));
  const state = readAuditState({ stateDirectory }); assert.equal(state.attempts, 1);
});

test('finite convenience API has explicit bounds and performs no scheduling', async t => {
  const { options, stateDirectory } = fixture(t), snapshot = fixtureSnapshot(now);
  await assert.rejects(runAuditCycles({ ...options, snapshots: [] }), code('ATTEMPT_BOUND'));
  await assert.rejects(runAuditCycles({ ...options, snapshots: Array(101).fill(snapshot) }), code('ATTEMPT_BOUND'));
  const results = await runAuditCycles({ ...options, snapshots: [snapshot, snapshot, snapshot] });
  assert.deepEqual(results.map(r => r.status), ['recorded', 'no-op', 'no-op']);
  assert.equal(readAuditState({ stateDirectory }).attempts, 3);
});

test('state and artifact redirection are not followed on read', async t => {
  const { options, root, stateDirectory } = fixture(t);
  const first = await runAuditCycle({ ...options, snapshot: fixtureSnapshot(now) });
  const handoff = path.join(stateDirectory, first.handoff.file), retained = path.join(root, 'retained.json');
  writeFileSync(retained, readFileSync(handoff)); unlinkSync(handoff);
  // A hard link is equally unsafe: writes through another name could change a receipt.
  const { linkSync } = await import('node:fs'); linkSync(retained, handoff);
  assert.throws(() => readAuditState({ stateDirectory }), code('STATE_FILE'));
  assert.equal(existsSync(retained), true);
});

for (const mutation of ['alter', 'delete']) test(`${mutation} of earlier history is detected after a newer successful cycle`, async t => {
  const { options, stateDirectory } = fixture(t), snapshot = fixtureSnapshot(now);
  const first = await runAuditCycle({ ...options, snapshot });
  snapshot.pull_requests[0].closes = [];
  await runAuditCycle({ ...options, snapshot });
  const oldReceipt = path.join(stateDirectory, first.receipt.file);
  if (mutation === 'alter') writeFileSync(oldReceipt, '{}\n'); else unlinkSync(oldReceipt);
  const names = readdirSync(stateDirectory).sort();
  await assert.rejects(runAuditCycle({ ...options, snapshot }), code('STATE_INTEGRITY'));
  assert.deepEqual(readdirSync(stateDirectory).sort(), names);
});

test('changed implementation pins fail before a new intent is written', async t => {
  const { options, stateDirectory } = fixture(t);
  await runAuditCycle({ ...options, snapshot: fixtureSnapshot(now) });
  const loaded = readAuditState({ stateDirectory }), checkpoint = read(stateDirectory, loaded.checkpoint);
  checkpoint.implementation_digests['common.mjs'] = '0'.repeat(64);
  const bytes = Buffer.from(JSON.stringify(checkpoint) + '\n');
  const reference = { file: `artifact-${sha(bytes)}.json`, sha256: sha(bytes), bytes: bytes.length };
  writeFileSync(path.join(stateDirectory, reference.file), bytes);
  writeFileSync(path.join(stateDirectory, 'state.json'), JSON.stringify({ schema_version: 1, checkpoint: reference }));
  await assert.rejects(runAuditCycle({ ...options, snapshot: fixtureSnapshot(now) }), code('IMPLEMENTATION_DRIFT'));
  assert.equal(existsSync(path.join(stateDirectory, 'intent-0002.json')), false);
});

test('a directory replaced while a caller holds its lock cannot redirect any artifact write', async t => {
  const { options, root, stateDirectory } = fixture(t), outside = path.join(root, 'outside'), retained = path.join(root, 'retained-state');
  mkdirSync(outside);
  const pending = runAuditCycle({ ...options, snapshot: fixtureSnapshot(now) });
  assert.equal(existsSync(path.join(stateDirectory, 'audit.lock')), true);
  try { renameSync(stateDirectory, retained); }
  catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) {
      // Windows may prohibit moving the directory while its native lock handle
      // is open. That prevents substitution before the library's recheck.
      const completed = await pending;
      assert.equal(completed.status, 'recorded');
      assert.equal(readAuditState({ stateDirectory }).attempts, 1);
      assert.equal(existsSync(retained), false);
      assert.deepEqual(readdirSync(outside), []);
      return;
    }
    await pending.catch(() => {});
    throw error;
  }
  try { symlinkSync(outside, stateDirectory, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { await pending.catch(() => {}); throw error; }
  await assert.rejects(pending, code('STATE_REDIRECT'));
  assert.deepEqual(readdirSync(outside), []);
  assert.equal(existsSync(path.join(retained, 'audit.lock')), true);
});

function feedbackFixture(snapshot, expiresAt = new Date(now.getTime() + 60000).toISOString()) {
  const report = audit(snapshot, { now, source: 'synthetic-fixture' });
  const evidence = report.findings.filter(f => f.rule === 'WORKSTREAM_UNTAGGED').slice(0, 2)
    .map(f => createFeedbackEvidence({ snapshot, findingId: f.id, now, source: 'synthetic-fixture' }));
  const proposed = proposeFeedback({ corpus: createFeedbackCorpus({ scope: snapshot.scope, now }), rule: 'WORKSTREAM_UNTAGGED',
    guidance: { text: 'Inspect the exact source evidence before proposing an advisory label.', route: 'inspect-evidence' }, evidence, expiresAt, now });
  const active = reviewFeedback({ corpus: proposed.corpus, candidateId: proposed.record.id, expectedCandidateDigest: proposed.recordDigest,
    decision: 'activate', reviewEvidence: { sha256: feedbackDigest({ fixture: 'explicit local advisory decision, no verified human identity' }), reason: 'Synthetic advisory guidance remains separate from original findings.' }, now });
  return { proposed, active };
}

test('actual corpus activation and retirement change only separately bound advisory output', async t => {
  const { options, stateDirectory } = fixture(t), snapshot = fixtureSnapshot(now), { proposed, active } = feedbackFixture(snapshot);
  const first = await runAuditCycle({ ...options, snapshot, corpus: proposed.corpus });
  const firstReceipt = read(stateDirectory, first.receipt), firstReport = read(stateDirectory, firstReceipt.report);
  assert.equal(read(stateDirectory, firstReceipt.feedback).annotations.length, 0);
  const second = await runAuditCycle({ ...options, snapshot, corpus: active.corpus });
  const secondReceipt = read(stateDirectory, second.receipt);
  assert.equal(second.status, 'recorded'); assert.deepEqual(second.newFindings, []);
  assert.equal(secondReceipt.corpus_digest, feedbackDigest(active.corpus));
  assert.deepEqual(read(stateDirectory, secondReceipt.report).findings, firstReport.findings);
  assert.ok(read(stateDirectory, secondReceipt.feedback).annotations.length > 0);
  assert.equal((await runAuditCycle({ ...options, snapshot, corpus: active.corpus })).status, 'no-op');
  const retired = retireFeedback({ corpus: active.corpus, ruleId: active.record.id, expectedRuleDigest: active.recordDigest, reason: 'Retired synthetic guidance.', now });
  const fourth = await runAuditCycle({ ...options, snapshot, corpus: retired.corpus });
  const fourthReceipt = read(stateDirectory, fourth.receipt);
  assert.equal(fourth.status, 'recorded'); assert.deepEqual(fourth.newFindings, []);
  assert.deepEqual(read(stateDirectory, fourthReceipt.report).findings, firstReport.findings);
  assert.equal(read(stateDirectory, fourthReceipt.feedback).annotations.length, 0);
});

test('expiry invalidates cached advisory annotations even without corpus byte changes', async t => {
  const { options, stateDirectory } = fixture(t), snapshot = fixtureSnapshot(now), { active } = feedbackFixture(snapshot);
  const first = await runAuditCycle({ ...options, snapshot, corpus: active.corpus });
  const original = read(stateDirectory, first.receipt);
  assert.ok(read(stateDirectory, original.feedback).annotations.length > 0);
  const later = new Date(now.getTime() + 120000); snapshot.captured_at = later.toISOString();
  const second = await runAuditCycle({ ...options, now: later, snapshot, corpus: active.corpus });
  assert.equal(second.status, 'recorded');
  const next = read(stateDirectory, second.receipt);
  assert.equal(next.evidence_digest, original.evidence_digest); assert.equal(next.corpus_digest, original.corpus_digest);
  assert.equal(read(stateDirectory, next.feedback).annotations.length, 0);
  assert.equal(read(stateDirectory, next.feedback).skipped_rules[0].reason, 'expired');
});

test('mixed retained controls and new cycles enforce one transition bound with a reserved terminal stop', async t => {
  const { options, stateDirectory } = fixture(t), snapshot = fixtureSnapshot(now);
  await runAuditCycle({ ...options, snapshot });
  let pointer = readAuditState({ stateDirectory }).checkpoint;
  let state = read(stateDirectory, pointer);
  const save = value => {
    const bytes = Buffer.from(JSON.stringify(value) + '\n');
    const reference = { file: `artifact-${sha(bytes)}.json`, sha256: sha(bytes), bytes: bytes.length };
    writeFileSync(path.join(stateDirectory, reference.file), bytes, { flag: 'wx', mode: 0o600 });
    return reference;
  };
  // A synthetic retained history exercises the real loader and final operations
  // at the boundary without running 196 redundant filesystem control cycles.
  for (let version = 2; version <= 197; version++) {
    const action = version % 2 ? 'resume' : 'pause', status = version % 2 ? 'running' : 'paused';
    const name = `control-intent-${String(version).padStart(4, '0')}.json`;
    const bytes = Buffer.from(JSON.stringify({ action, sourceCommit, previous: pointer, at: now.toISOString() }) + '\n');
    writeFileSync(path.join(stateDirectory, name), bytes, { flag: 'wx', mode: 0o600 });
    const receipt = save({ schema_version: 1, kind: 'audit-control', action, status, sourceCommit,
      at: now.toISOString(), reason: 'Synthetic retained control history.',
      intent: { file: name, sha256: sha(bytes), bytes: bytes.length }, execution_authority: 'none' });
    state = { ...state, version, receipt, control: { status, reason: 'Synthetic retained control.', updated_at: now.toISOString() }, previous_checkpoint: pointer };
    pointer = save(state);
  }
  writeFileSync(path.join(stateDirectory, 'state.json'), JSON.stringify({ schema_version: 1, checkpoint: pointer }));
  assert.equal(readAuditState({ stateDirectory }).status, 'running');
  assert.equal((await runAuditCycle({ ...options, snapshot })).status, 'no-op');
  assert.equal((await runAuditCycle({ ...options, snapshot })).status, 'no-op');
  const names = readdirSync(stateDirectory).sort();
  await assert.rejects(runAuditCycle({ ...options, snapshot }), code('CONTROL_BOUND'));
  await assert.rejects(setAuditControl({ ...options, action: 'pause', reason: 'No ordinary transition remains.' }), code('CONTROL_BOUND'));
  assert.deepEqual(readdirSync(stateDirectory).sort(), names);
  assert.equal((await setAuditControl({ ...options, action: 'stop', reason: 'Use reserved terminal transition.' })).status, 'stopped');
  const final = readAuditState({ stateDirectory });
  assert.equal(final.attempts, 3); assert.equal(read(stateDirectory, final.checkpoint).version, 200);
  assert.equal((await runAuditCycle({ ...options, snapshot })).status, 'stopped');
});

test('accepted snapshots with omitted optional metadata produce parseable JSON artifacts and replay', async t => {
  const { options, stateDirectory } = fixture(t), snapshot = fixtureSnapshot(now);
  snapshot.issues[0].state = 'CLOSED';
  delete snapshot.project_items[0].status;
  const first = await runAuditCycle({ ...options, snapshot });
  const receipt = read(stateDirectory, first.receipt), report = read(stateDirectory, receipt.report);
  assert.ok(report.findings.some(f => f.rule === 'CLOSED_ISSUE_NOT_DONE'));
  assert.equal((await runAuditCycle({ ...options, snapshot })).status, 'no-op');
});

test('optional auditor metadata works through the real feedback evidence and recurring consumer bridge', async t => {
  const { options, stateDirectory } = fixture(t), snapshot = fixtureSnapshot(now);
  snapshot.issues[0].state = 'CLOSED'; delete snapshot.project_items[0].status;
  const { active } = feedbackFixture(snapshot);
  const before = structuredClone(snapshot);
  const result = await runAuditCycle({ ...options, snapshot, corpus: active.corpus });
  const receipt = read(stateDirectory, result.receipt), report = read(stateDirectory, receipt.report), feedback = read(stateDirectory, receipt.feedback);
  assert.deepEqual(snapshot, before);
  assert.deepEqual(report.findings, JSON.parse(JSON.stringify(audit(snapshot, { now, source: 'synthetic-fixture' }).findings)));
  assert.ok(feedback.annotations.length > 0); assert.equal(feedback.corpus_digest, receipt.corpus_digest);
  assert.equal((await runAuditCycle({ ...options, snapshot, corpus: active.corpus })).status, 'no-op');
});
