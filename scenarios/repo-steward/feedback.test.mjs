import test from 'node:test';
import assert from 'node:assert/strict';
import { audit } from './lib/steward.mjs';
import { fixtureSnapshot } from './fixtures/demo.mjs';
import { FEEDBACK_LIMITS, feedbackDigest, createFeedbackEvidence, createFeedbackCorpus,
  proposeFeedback, reviewFeedback, retireFeedback, observeFeedback, validateFeedbackCorpus, createNativeBehaviorEvidence } from './lib/feedback.mjs';

const now = new Date('2026-09-18T12:00:00Z');
const later = minutes => new Date(now.getTime() + minutes * 60000);
const expiresAt = later(1440).toISOString();
const guidance = { text: 'Inspect the source references before proposing a workstream label; do not infer an assignee.', route: 'inspect-evidence' };
const reviewEvidence = { sha256: feedbackDigest({ fixture: 'local operator review; no verified identity' }), reason: 'Synthetic reviewed guidance stays advisory and retains the original finding.', operatorLabel: 'unverified-fixture-label' };
function fixture(at = now) {
  const snapshot = fixtureSnapshot(at);
  const report = audit(snapshot, { now: at, source: 'synthetic-fixture' });
  return { snapshot, report };
}
function evidence(at = now) {
  const { snapshot, report } = fixture(at);
  const selected = report.findings.filter(item => item.rule === 'WORKSTREAM_UNTAGGED').slice(0, 2);
  assert.equal(selected.length, 2);
  return selected.map(item => createFeedbackEvidence({ snapshot, findingId: item.id, now: at, source: 'synthetic-fixture' }));
}
function corpus(maxActive = 8) { return createFeedbackCorpus({ scope: fixture().snapshot.scope, maxActive, now }); }
function propose(base = corpus(), overrides = {}) {
  return proposeFeedback({ corpus: base, rule: 'WORKSTREAM_UNTAGGED', guidance, evidence: evidence(), expiresAt, now, ...overrides });
}
function activate(proposed, overrides = {}) {
  return reviewFeedback({ corpus: proposed.corpus, candidateId: proposed.record.id, expectedCandidateDigest: proposed.recordDigest,
    decision: 'activate', reviewEvidence, now, ...overrides });
}
function observe(base, at = now) {
  const { snapshot, report } = fixture(at);
  return observeFeedback({ corpus: base, report, evidenceDigest: feedbackDigest(snapshot), now: at });
}
function freeze(value) {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}

function nativeBehavior(run = 1) {
  const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  return createNativeBehaviorEvidence({ scope: corpus().scope, rule: 'WORKSTREAM_UNTAGGED', capturedAt: now,
    native: { server_origin_sha256: 'a'.repeat(64), corp_id: uuid(10), room_id: uuid(11), mission_id: uuid(12), task_id: uuid(13),
      run_id: uuid(run), connection_id: uuid(14), repository: 'local/original-native-case', base_ref: 'HEAD', base_commit: 'b'.repeat(40),
      target: 'src/module.mjs', resume_event_id: uuid(15), resumed_from_run_id: uuid(16), actor_id: uuid(17), agent_id: uuid(18), runner_id: 'native-fixture',
      contract_version: 2, contract_sha256: 'c'.repeat(64), verification_policy_sha256: 'd'.repeat(64), resume_prompt_sha256: 'e'.repeat(64),
      verification_sha256: 'f'.repeat(64), deliverable_sha256: '1'.repeat(64), native_check_count: 3 },
    behavior: { check: 'exact-append-v1', manifest_sha256: '2'.repeat(64), expected_sha256: '3'.repeat(64), native_outcome: 'completed',
      native_verification: 'passed', external_outcome: 'rejected', instruction_alignment: 'not-reviewed', native_test_target_binding: 'retained-workspace-only',
      before_git_blob: '4'.repeat(40), after_git_blob: '5'.repeat(40), worktree_registration_sha256: '6'.repeat(64) },
    filesSha256: Object.fromEntries(['terminal', 'resume_intent', 'before_attestation', 'after_attestation', 'before_target', 'after_target', 'external_failure', 'external_checker'].map(key => [key, '7'.repeat(64)])) });
}

test('native behavioral evidence remains candidate with original local source and no finding impersonation', () => {
  const support = [nativeBehavior(1), nativeBehavior(2)], proposed = propose(corpus(), { evidence: support });
  assert.equal(proposed.record.status, 'candidate'); validateFeedbackCorpus(proposed.corpus);
  assert.equal(support[0].native.repository, 'local/original-native-case'); assert.equal(support[0].source_commit, 'b'.repeat(40));
  assert.equal(Object.hasOwn(support[0], 'finding_id'), false); assert.equal(support[0].identity_verification, 'not-performed');
  assert.deepEqual(observe(proposed.corpus).annotations, []);
  assert.throws(() => activate(proposed), { code: 'FEEDBACK_REVIEW_AUTHORITY' });
});

test('native behavioral activation is denied for mixed support and forged active or retired history', () => {
  const mixed = propose(corpus(), { evidence: [nativeBehavior(), evidence()[0]] });
  assert.throws(() => activate(mixed), { code: 'FEEDBACK_REVIEW_AUTHORITY' });
  const forged = structuredClone(mixed.corpus), record = forged.records[0];
  record.status = 'active'; record.review = { decision: 'activate', at: now.toISOString(), evidence_sha256: reviewEvidence.sha256,
    reason: 'Local hashes do not authorize activation.', operator_label: null, identity_verification: 'not-performed', independent_review_verified: false, human_approval_verified: false };
  assert.throws(() => validateFeedbackCorpus(forged), { code: 'FEEDBACK_REVIEW_AUTHORITY' });
  assert.throws(() => observe(forged), { code: 'FEEDBACK_REVIEW_AUTHORITY' });
  record.status = 'retired'; record.retirement = { at: now.toISOString(), reason: 'Cannot launder prior activation.', disposition: 'operator-retired', superseded_by: null };
  assert.throws(() => validateFeedbackCorpus(forged), { code: 'FEEDBACK_REVIEW_AUTHORITY' });
});

test('native behavioral candidates can be rejected without widening legacy review authority', () => {
  const proposed = propose(corpus(), { evidence: [nativeBehavior()] });
  const rejected = reviewFeedback({ corpus: proposed.corpus, candidateId: proposed.record.id, expectedCandidateDigest: proposed.recordDigest,
    decision: 'reject', reviewEvidence, now });
  assert.equal(rejected.record.status, 'retired'); assert.equal(rejected.record.retirement.disposition, 'rejected');
  validateFeedbackCorpus(rejected.corpus); assert.deepEqual(observe(rejected.corpus).annotations, []);
  assert.equal(activate(propose()).record.status, 'active');
});

test('native behavioral bytes, identity claims, source and repeated runs remain validated', () => {
  assert.throws(() => propose(corpus(), { evidence: [nativeBehavior(), nativeBehavior()] }), { code: 'FEEDBACK_EVIDENCE' });
  for (const mutate of [e => { e.human_approval_verified = true; }, e => { e.source_commit = 'c'.repeat(40); },
    e => { e.behavior.instruction_alignment = 'authenticated'; }, e => { e.files_sha256.after_target = e.behavior.expected_sha256; }]) {
    const e = nativeBehavior(); mutate(e);
    const { evidence_sha256: _old, ...body } = e; e.evidence_sha256 = feedbackDigest(body);
    assert.throws(() => propose(corpus(), { evidence: [e] }), { code: 'FEEDBACK_EVIDENCE' });
  }
});

test('evidence binds actual audit finding and supplied snapshot without certifying collection or identity', () => {
  const { snapshot, report } = fixture();
  const finding = report.findings.find(item => item.rule === 'WORKSTREAM_UNTAGGED');
  const item = createFeedbackEvidence({ snapshot: freeze(snapshot), findingId: finding.id, now });
  assert.equal(item.source, 'provided-snapshot'); assert.equal(item.provenance, 'caller-supplied-data');
  assert.equal(item.authority, 'none'); assert.equal(item.snapshot_sha256, feedbackDigest(snapshot));
  assert.equal(item.finding_sha256, feedbackDigest(finding)); assert.equal(item.finding_revision, finding.revision);
  assert.equal(item.source_commit, snapshot.scope.source_commit);
  assert.throws(() => createFeedbackEvidence({ snapshot, findingId: finding.id, now, source: 'live-github-two-pass' }), { code: 'FEEDBACK_EVIDENCE' });
});

test('accepted missing Project status binds the native serialized report and finding in evidence and observations', () => {
  const snapshots = [0, 1].map(index => {
    const snapshot = fixtureSnapshot(now); delete snapshot.project_items[index].status; return snapshot;
  });
  const reports = snapshots.map(snapshot => audit(snapshot, { now, source: 'synthetic-fixture' }));
  const findings = reports.map(report => report.findings.find(finding => finding.rule === 'PROJECT_STATUS_REVIEW'));
  const serialized = value => JSON.parse(JSON.stringify(value));
  const support = snapshots.map((snapshot, index) => createFeedbackEvidence({
    snapshot: freeze(snapshot), findingId: findings[index].id, now, source: 'synthetic-fixture',
  }));
  for (let index = 0; index < support.length; index++) {
    assert.equal(Object.hasOwn(findings[index].evidence, 'status'), true);
    assert.equal(findings[index].evidence.status, undefined);
    assert.equal(support[index].audit_sha256, feedbackDigest(serialized(reports[index])));
    assert.equal(support[index].finding_sha256, feedbackDigest(serialized(findings[index])));
  }
  const active = activate(propose(corpus(), { rule: 'PROJECT_STATUS_REVIEW', evidence: support }));
  const before = structuredClone(reports[0]);
  const result = observeFeedback({ corpus: freeze(active.corpus), report: freeze(reports[0]),
    evidenceDigest: feedbackDigest(snapshots[0]), now });
  assert.equal(result.annotations.length, 1);
  assert.equal(result.report_digest, feedbackDigest(serialized(reports[0])));
  assert.equal(result.annotations[0].finding_digest, feedbackDigest(serialized(findings[0])));
  assert.deepEqual(reports[0], before);
  assert.equal(Object.hasOwn(reports[0].findings.find(item => item.id === findings[0].id).evidence, 'status'), true);
  assert.deepEqual(result.annotations[0].guidance, guidance);
});

test('auditor optional-field normalization retains strict data-only feedback and report validation', () => {
  for (const value of [{ optional: undefined }, [undefined], Array(1)]) {
    assert.throws(() => feedbackDigest(value), { code: 'FEEDBACK_DATA' });
  }
  assert.throws(() => propose(corpus(), { guidance: { ...guidance, optional: undefined } }), { code: 'FEEDBACK_SCHEMA' });
  assert.throws(() => propose(corpus(), { guidance: { ...guidance, text: undefined } }), { code: 'FEEDBACK_TEXT' });
  const active = activate(propose()), { report, snapshot } = fixture();
  for (const invalid of [() => 'hidden', NaN, Infinity, new Date()]) {
    const altered = structuredClone(report); altered.findings[0].evidence.invalid = invalid;
    assert.throws(() => observeFeedback({ corpus: active.corpus, report: altered, evidenceDigest: feedbackDigest(snapshot), now }), { code: 'FEEDBACK_DATA' });
  }
  let called = false;
  const altered = structuredClone(report); altered.findings[0].evidence.toJSON = () => { called = true; return {}; };
  assert.throws(() => observeFeedback({ corpus: active.corpus, report: altered, evidenceDigest: feedbackDigest(snapshot), now }), { code: 'FEEDBACK_DATA' });
  assert.equal(called, false);
});

test('timestamp-only or unrelated snapshot changes do not manufacture repeated supporting evidence', () => {
  const { snapshot, report } = fixture(), findingId = report.findings.find(item => item.rule === 'WORKSTREAM_UNTAGGED').id;
  const first = createFeedbackEvidence({ snapshot, findingId, now });
  const next = structuredClone(snapshot); next.captured_at = later(1).toISOString(); next.coverage.consistency = 'still supplied data';
  const second = createFeedbackEvidence({ snapshot: next, findingId, now: later(1) });
  assert.equal(first.evidence_id, second.evidence_id); assert.notEqual(first.snapshot_sha256, second.snapshot_sha256);
  assert.notEqual(first.evidence_sha256, second.evidence_sha256);
  assert.throws(() => propose(corpus(), { evidence: [first, second], now: later(1) }), { code: 'FEEDBACK_EVIDENCE' });
});

test('partial, cross-scope, stale or missing findings cannot become feedback evidence', () => {
  const { snapshot, report } = fixture(), findingId = report.findings[0].id;
  assert.throws(() => createFeedbackEvidence({ snapshot: { ...snapshot, coverage: { ...snapshot.coverage, complete: false } }, findingId, now }), { code: 'INCOMPLETE' });
  assert.throws(() => createFeedbackEvidence({ snapshot: { ...snapshot, scope: { ...snapshot.scope, project_id: 'another-project' } }, findingId, now }), { code: 'SCOPE' });
  assert.throws(() => createFeedbackEvidence({ snapshot, findingId, now: later(1440) }), { code: 'FEEDBACK_EVIDENCE' });
  assert.throws(() => createFeedbackEvidence({ snapshot, findingId: 'F-0000000000000000', now }), { code: 'FEEDBACK_EVIDENCE' });
});

test('feedback source pins accept exactly 40 or 64 hexadecimal characters, including supplied evidence', () => {
  const { snapshot, report } = fixture(), findingId = report.findings[0].id;
  for (const length of [40, 64]) {
    const pinned = { ...snapshot, scope: { ...snapshot.scope, source_commit: 'a'.repeat(length) } };
    assert.equal(createFeedbackEvidence({ snapshot: pinned, findingId, now }).source_commit.length, length);
  }
  for (const source_commit of [39, 41, 63, 65].map(length => 'a'.repeat(length)).concat([['a'.repeat(40)]])) {
    const pinned = { ...snapshot, scope: { ...snapshot.scope, source_commit } };
    assert.throws(() => createFeedbackEvidence({ snapshot: pinned, findingId, now }), { code: 'FEEDBACK_EVIDENCE' });
  }
  for (const source_commit of ['a'.repeat(41), ['a'.repeat(40)]]) {
    const supplied = evidence(), item = supplied[0]; item.source_commit = source_commit;
    item.evidence_id = `FE-${feedbackDigest({ scope: item.scope, source_commit: item.source_commit,
      finding_id: item.finding_id, rule: item.rule, finding_revision: item.finding_revision })}`;
    const { evidence_sha256: _previous, ...body } = item; item.evidence_sha256 = feedbackDigest(body);
    assert.throws(() => propose(corpus(), { evidence: supplied }), { code: 'FEEDBACK_EVIDENCE' });
  }
});

test('candidate, active and retired versions preserve their inputs and have exact transition digests', () => {
  const initial = freeze(corpus()), proposed = propose(initial);
  assert.equal(initial.records.length, 0); assert.equal(proposed.record.status, 'candidate');
  assert.equal(proposed.transition.previous_corpus_digest, feedbackDigest(initial));
  assert.equal(proposed.recordDigest, feedbackDigest(proposed.record));
  const active = activate({ ...proposed, corpus: freeze(proposed.corpus) });
  assert.equal(proposed.corpus.records[0].status, 'candidate'); assert.equal(active.record.status, 'active');
  assert.equal(active.corpus.revision, 2); assert.equal(active.record.review.identity_verification, 'not-performed');
  assert.equal(active.record.review.human_approval_verified, false); assert.equal(active.record.review.independent_review_verified, false);
  const retired = retireFeedback({ corpus: freeze(active.corpus), ruleId: active.record.id, expectedRuleDigest: active.recordDigest, reason: 'Synthetic correction was superseded by upstream behavior.', now: later(2) });
  assert.equal(active.corpus.records[0].status, 'active'); assert.equal(retired.record.status, 'retired');
  assert.equal(retired.record.retirement.disposition, 'operator-retired'); assert.equal(retired.corpus.revision, 3);
  assert.equal(retired.transition.next_corpus_digest, retired.corpusDigest);
});

test('one observation, fabricated evidence bytes and replayed reviews cannot activate a rule', () => {
  const one = propose(corpus(), { evidence: evidence().slice(0, 1) });
  assert.throws(() => activate(one), { code: 'FEEDBACK_EVIDENCE' });
  const tampered = evidence(); tampered[0].finding_revision = '0'.repeat(64);
  assert.throws(() => propose(corpus(), { evidence: tampered }), { code: 'FEEDBACK_EVIDENCE' });
  const proposed = propose();
  assert.throws(() => activate(proposed, { expectedCandidateDigest: '0'.repeat(64) }), { code: 'FEEDBACK_STALE' });
  const active = activate(proposed);
  assert.throws(() => activate({ ...proposed, corpus: active.corpus }), { code: 'FEEDBACK_STALE' });
});

test('reviewer labels and claimed approval booleans do not supply verified review authority', () => {
  const proposed = propose();
  for (const field of ['human_approval', 'independent_review_verified', 'approved', 'reviewer_id']) {
    assert.throws(() => activate(proposed, { reviewEvidence: { ...reviewEvidence, [field]: true } }), { code: 'FEEDBACK_REVIEW' });
  }
  assert.throws(() => activate(proposed, { reviewEvidence: { ...reviewEvidence, sha256: 'not-a-digest' } }), { code: 'FEEDBACK_REVIEW' });
  const active = activate(proposed, { reviewEvidence: { ...reviewEvidence, operatorLabel: 'Human approver (unverified supplied label)' } });
  assert.equal(active.record.review.identity_verification, 'not-performed');
  assert.equal(active.record.review.human_approval_verified, false);
  const corrupted = structuredClone(active.corpus); corrupted.records[0].review.independent_review_verified = true;
  assert.throws(() => observe(corrupted), { code: 'FEEDBACK_REVIEW' });
});

test('explicit rejection remains terminal and contributes no advice', () => {
  const proposed = propose(corpus(), { evidence: evidence().slice(0, 1) });
  const rejected = reviewFeedback({ corpus: proposed.corpus, candidateId: proposed.record.id, expectedCandidateDigest: proposed.recordDigest,
    decision: 'reject', reviewEvidence, now });
  assert.equal(rejected.record.status, 'retired'); assert.equal(rejected.record.retirement.disposition, 'rejected');
  assert.deepEqual(observe(rejected.corpus).annotations, []);
  assert.equal(observe(rejected.corpus).skipped_rules[0].reason, 'rejected');
  assert.throws(() => activate({ ...proposed, corpus: rejected.corpus }), { code: 'FEEDBACK_STALE' });
});

test('prospective expiry is mandatory, bounded, and effective at the exact boundary', () => {
  for (const value of [undefined, 'invalid', now.toISOString(), later(31 * 1440).toISOString()]) {
    assert.throws(() => propose(corpus(), { expiresAt: value }), { code: 'FEEDBACK_TIME' });
  }
  const proposed = propose();
  assert.throws(() => activate(proposed, { now: new Date(expiresAt) }), { code: 'FEEDBACK_EXPIRED' });
  const active = activate(proposed);
  assert.ok(observe(active.corpus, later(1439)).annotations.length > 0);
  assert.equal(observe(active.corpus, later(1440)).annotations.length, 0);
  assert.equal(observe(active.corpus, later(1440)).skipped_rules[0].reason, 'expired');
  assert.throws(() => retireFeedback({ corpus: active.corpus, ruleId: active.record.id, expectedRuleDigest: active.recordDigest, reason: 'Backdated.', now: later(-1) }), { code: 'FEEDBACK_TIME' });
});

test('active capacity cannot expand and supersession retires only the exact predecessor', () => {
  assert.throws(() => corpus(FEEDBACK_LIMITS.maxActive + 1), { code: 'FEEDBACK_CAP' });
  const first = activate(propose(corpus(1)));
  const second = propose(first.corpus, { guidance: { ...guidance, text: 'A second bounded advisory.' } });
  assert.throws(() => activate(second), { code: 'FEEDBACK_CAP' });
  const replacement = propose(first.corpus, { guidance: { ...guidance, text: 'Revised evidence inspection guidance.' }, supersedes: first.record.id });
  const updated = activate(replacement);
  assert.equal(updated.corpus.records[0].retirement.disposition, 'superseded');
  assert.equal(updated.corpus.records[0].retirement.superseded_by, replacement.record.id);
  assert.equal(updated.corpus.records.filter(item => item.status === 'active').length, 1);
  assert.ok(observe(updated.corpus).annotations.every(item => item.feedback_rule_id === replacement.record.id));
  assert.equal(first.corpus.records[0].status, 'active');
  const broken = structuredClone(updated.corpus); broken.records[0].status = 'active'; broken.records[0].retirement = null;
  assert.throws(() => observe(broken), { code: 'FEEDBACK_CAP' });
});

test('supersession rejects stale targets and cannot cross finding rules', () => {
  const first = activate(propose());
  const next = propose(first.corpus, { guidance: { ...guidance, text: 'Replacement awaiting local review.' }, supersedes: first.record.id });
  const retired = retireFeedback({ corpus: next.corpus, ruleId: first.record.id, expectedRuleDigest: first.recordDigest, reason: 'Retired before replacement review.', now });
  assert.throws(() => activate({ ...next, corpus: retired.corpus }), { code: 'FEEDBACK_SUPERSESSION' });
  assert.throws(() => propose(first.corpus, { supersedes: 'FB-' + '0'.repeat(64) }), { code: 'FEEDBACK_SUPERSESSION' });
});

test('active guidance annotates only matching findings without hiding or changing original conclusions', () => {
  const { report, snapshot } = fixture(), original = structuredClone(report);
  const active = activate(propose());
  const result = observeFeedback({ corpus: freeze(active.corpus), report: freeze(report), evidenceDigest: feedbackDigest(snapshot), now });
  assert.deepEqual(report, original);
  assert.equal(result.annotations.length, report.findings.filter(item => item.rule === 'WORKSTREAM_UNTAGGED').length);
  for (const annotation of result.annotations) {
    const finding = report.findings.find(item => item.id === annotation.finding_id);
    assert.equal(finding.rule, 'WORKSTREAM_UNTAGGED'); assert.equal(annotation.finding_digest, feedbackDigest(finding));
    assert.equal(annotation.finding_revision, finding.revision); assert.equal(annotation.authority, 'none');
    assert.equal(annotation.advisory_only, true); assert.deepEqual(annotation.guidance, guidance);
  }
  assert.equal(result.report_digest, feedbackDigest(report)); assert.equal(result.corpus_digest, active.corpusDigest);
  assert.deepEqual(result.executed_actions, []); assert.equal(result.authority, 'none');
  assert.equal(Object.hasOwn(result, 'findings'), false); assert.equal(Object.hasOwn(result, 'permissions'), false);
});

test('broad matching admits at most the finite annotation limit and never truncates an excessive report', () => {
  let current = corpus();
  for (let index = 0; index < FEEDBACK_LIMITS.maxActive; index++) {
    current = activate(propose(current, { guidance: { ...guidance, text: `Bounded advisory ${index}.` } })).corpus;
  }
  const { report, snapshot } = fixture(), finding = report.findings.find(item => item.rule === 'WORKSTREAM_UNTAGGED');
  const broadReport = count => ({ ...report, findings: Array.from({ length: count }, (_, index) => ({
    id: `F-${index.toString(16).padStart(16, '0')}`, rule: finding.rule, revision: finding.revision,
  })) });
  const admitted = broadReport(FEEDBACK_LIMITS.maxAnnotations / FEEDBACK_LIMITS.maxActive);
  const result = observeFeedback({ corpus: current, report: admitted, evidenceDigest: feedbackDigest(snapshot), now });
  assert.equal(result.annotations.length, FEEDBACK_LIMITS.maxAnnotations);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= FEEDBACK_LIMITS.maxOutputBytes);
  for (const count of [FEEDBACK_LIMITS.maxAnnotations / FEEDBACK_LIMITS.maxActive + 1, 30000]) {
    const oversized = broadReport(count), before = feedbackDigest(oversized);
    assert.throws(() => observeFeedback({ corpus: current, report: oversized, evidenceDigest: feedbackDigest(snapshot), now }), { code: 'FEEDBACK_OUTPUT_BOUND' });
    assert.equal(feedbackDigest(oversized), before);
  }
});

test('serialized output bytes are admitted before escaped guidance and evidence references fan out', () => {
  const { snapshot, report } = fixture(), finding = report.findings.find(item => item.rule === 'WORKSTREAM_UNTAGGED');
  const sources = Array.from({ length: FEEDBACK_LIMITS.maxEvidence }, (_, index) => {
    const pinned = { ...snapshot, scope: { ...snapshot.scope, source_commit: (index + 1).toString(16).padStart(40, '0') } };
    return createFeedbackEvidence({ snapshot: pinned, findingId: finding.id, now, source: 'synthetic-fixture' });
  });
  const active = activate(propose(corpus(), { evidence: sources, guidance: { ...guidance, text: '\\'.repeat(800) } }));
  const expanded = { ...report, findings: Array.from({ length: FEEDBACK_LIMITS.maxAnnotations }, (_, index) => ({
    ...finding, id: `F-${index.toString(16).padStart(16, '0')}`,
  })) };
  const one = observeFeedback({ corpus: active.corpus, report: { ...report, findings: [finding] }, evidenceDigest: feedbackDigest(snapshot), now });
  assert.ok(Buffer.byteLength(JSON.stringify(one.annotations[0])) * expanded.findings.length > FEEDBACK_LIMITS.maxOutputBytes);
  assert.throws(() => observeFeedback({ corpus: active.corpus, report: expanded, evidenceDigest: feedbackDigest(snapshot), now }), { code: 'FEEDBACK_OUTPUT_BOUND' });
});

test('later audits honor activation and retirement while the original report stays identical', () => {
  const proposed = propose(), before = observe(proposed.corpus), active = activate(proposed), during = observe(active.corpus);
  const retired = retireFeedback({ corpus: active.corpus, ruleId: active.record.id, expectedRuleDigest: active.recordDigest, reason: 'The advisory is no longer helpful.', now });
  const after = observe(retired.corpus);
  assert.equal(before.annotations.length, 0); assert.ok(during.annotations.length > 0); assert.equal(after.annotations.length, 0);
  assert.equal(before.report_digest, during.report_digest); assert.equal(during.report_digest, after.report_digest);
  assert.notEqual(before.corpus_digest, during.corpus_digest); assert.notEqual(during.corpus_digest, after.corpus_digest);
  assert.deepEqual(observe(active.corpus), during);
});

test('unknown executable, suppression, assignment and permission options are rejected', () => {
  for (const extra of [{ regex: '.*' }, { suppress: true }, { severity: 'info' }, { command: 'anything' }, { assignee: 'anyone' }, { permission: 'allow' }]) {
    assert.throws(() => propose(corpus(), { guidance: { ...guidance, ...extra } }), { code: 'FEEDBACK_SCHEMA' });
  }
  assert.throws(() => propose(corpus(), { guidance: { text: 'Bounded data.', route: 'execute' } }), { code: 'FEEDBACK_GUIDANCE' });
  assert.throws(() => propose(corpus(), { guidance: { ...guidance, text: 'ghp_' + 'a'.repeat(30) } }), { code: 'FEEDBACK_TEXT' });
  assert.throws(() => propose(corpus(), { guidance: { ...guidance, text: 'Hidden\u202econtrol' } }), { code: 'FEEDBACK_TEXT' });
});

test('stale reports, foreign scope and altered evidence fail closed', () => {
  const active = activate(propose()), { report, snapshot } = fixture();
  for (const altered of [{ ...report, freshness: 'stale' }, { ...report, github_mutations: 1 }, { ...report, executed_actions: ['change'] }]) {
    assert.throws(() => observeFeedback({ corpus: active.corpus, report: altered, evidenceDigest: feedbackDigest(snapshot), now }), { code: 'FEEDBACK_REPORT' });
  }
  assert.throws(() => observeFeedback({ corpus: active.corpus, report: { ...report, scope: { ...report.scope, project_id: 'outside' } }, evidenceDigest: feedbackDigest(snapshot), now }), { code: 'FEEDBACK_SCOPE' });
  const corrupted = structuredClone(active.corpus); corrupted.records[0].guidance.text = 'Changed after the bound proposal.';
  assert.throws(() => observe(corrupted), { code: 'FEEDBACK_SCHEMA' });
});

test('canonical digests ignore property insertion order but reject executable and non-finite data', () => {
  assert.equal(feedbackDigest({ a: 1, b: [true, null] }), feedbackDigest({ b: [true, null], a: 1 }));
  for (const value of [undefined, NaN, Infinity, () => {}]) assert.throws(() => feedbackDigest(value), { code: 'FEEDBACK_DATA' });
  const cycle = {}; cycle.self = cycle; assert.throws(() => feedbackDigest(cycle), { code: 'FEEDBACK_DATA' });
});

test('reusable corpus validation preserves input and rejects authority claims or altered guidance', () => {
  const active = activate(propose()).corpus, before = structuredClone(active);
  assert.equal(validateFeedbackCorpus(freeze(active)), active);
  assert.deepEqual(active, before);
  const changed = structuredClone(before); changed.records[0].guidance.text = 'Changed after review';
  assert.throws(() => validateFeedbackCorpus(changed), { code: 'FEEDBACK_SCHEMA' });
  assert.throws(() => validateFeedbackCorpus({ ...before, authorized: true }), { code: 'FEEDBACK_SCHEMA' });
});
