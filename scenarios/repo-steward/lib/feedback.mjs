import { createHash } from 'node:crypto';
import { audit } from './steward.mjs';
import { isObject, requireThat, safeText, sameRepo, SCOPE, validTime } from './common.mjs';

// Advisory data only. A digest binds bytes, not a person's identity, independent
// review, permission, or GitHub provenance. The trusted caller owns corpus files
// and actual review. No supplied name or approval boolean grants authority here.
export const FEEDBACK_LIMITS = Object.freeze({ maxActive: 8, maxRecords: 64, maxEvidence: 8, minEvidence: 2, maxLifetimeDays: 30,
  maxAnnotations: 512, maxOutputBytes: 1024 * 1024 });
const DIGEST = /^[a-f0-9]{64}$/;
const SOURCE_COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const RULE = /^[A-Z][A-Z0-9_]{0,63}$/;
const RECORD_ID = /^FB-[a-f0-9]{64}$/;
const ROUTES = new Set(['inspect-evidence', 'clarify-requirements', 'manual-review']);
const DAY = 86400000;
const fail = (test, suffix, message) => requireThat(test, `FEEDBACK_${suffix}`, message);
const clone = value => structuredClone(value);

function canonical(value, seen = new Set(), depth = 0, auditJSON = false) {
  fail(depth <= 40, 'DATA', 'Feedback data is too deeply nested.');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') { fail(Number.isFinite(value), 'DATA', 'Feedback numbers must be finite.'); return JSON.stringify(value); }
  fail(Array.isArray(value) || isObject(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)), 'DATA', 'Feedback accepts JSON data only.');
  fail(!seen.has(value), 'DATA', 'Feedback data must not contain cycles.');
  seen.add(value);
  const result = Array.isArray(value)
    ? `[${Array.from(value, item => canonical(auditJSON && item === undefined ? null : item, seen, depth + 1, auditJSON)).join(',')}]`
    : `{${Object.keys(value).filter(key => !auditJSON || value[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key], seen, depth + 1, auditJSON)}`).join(',')}}`;
  seen.delete(value);
  return result;
}

function digestText(text) {
  fail(Buffer.byteLength(text) <= 16777216, 'BOUND', 'Feedback input exceeds its byte bound.');
  return createHash('sha256').update(text).digest('hex');
}

export function feedbackDigest(value) { return digestText(canonical(value)); }

// Auditor-owned optional fields can be undefined even for a valid JSON snapshot.
// Bind the JSON representation that native report persistence retains, without
// changing inputs or accepting executable/non-JSON values elsewhere in feedback.
function auditDigest(value) { return digestText(canonical(value, new Set(), 0, true)); }

function keys(value, allowed, suffix = 'SCHEMA') {
  fail(isObject(value) && Object.keys(value).every(key => allowed.includes(key)), suffix, 'Unexpected feedback fields.');
}
function instant(value) {
  if (value instanceof Date) { fail(Number.isFinite(value.getTime()), 'TIME', 'A valid time is required.'); return value.toISOString(); }
  fail(validTime(value), 'TIME', 'An explicit valid timestamp is required.');
  return new Date(value).toISOString();
}
function plain(value, maximum, suffix = 'TEXT') {
  fail(typeof value === 'string' && value.trim().length > 0 && Buffer.byteLength(value) <= maximum && safeText(value, maximum) === value,
    suffix, 'Feedback text must be bounded plain data without secrets or control characters.');
  return value;
}
function scopeOf(value) {
  fail(isObject(value) && sameRepo(value.repository) && value.repository_id === SCOPE.repository_id && value.project_id === SCOPE.project_id,
    'SCOPE', 'Feedback must stay in the approved repository and Project.');
  for (const key of ['project_owner', 'project_number']) if (Object.hasOwn(value, key)) fail(value[key] === SCOPE[key], 'SCOPE', 'Feedback Project scope differs.');
  if (Object.hasOwn(value, 'ecorp_execution_authority')) fail(value.ecorp_execution_authority === 'none', 'SCOPE', 'Feedback cannot grant execution authority.');
  return { repository: SCOPE.repository, repository_id: SCOPE.repository_id, project_id: SCOPE.project_id };
}
function same(a, b) { return canonical(a) === canonical(b); }
function guidanceOf(value) {
  keys(value, ['text', 'route']);
  plain(value.text, 800);
  fail(ROUTES.has(value.route), 'GUIDANCE', 'Only fixed advisory routes are supported.');
  return clone(value);
}
function evidenceIdentity(value) {
  return `FE-${feedbackDigest({ scope: value.scope, source_commit: value.source_commit, finding_id: value.finding_id, rule: value.rule, finding_revision: value.finding_revision })}`;
}
function checkEvidence(value, scope, rule) {
  keys(value, ['schema_version', 'evidence_id', 'scope', 'source_commit', 'snapshot_sha256', 'audit_sha256', 'finding_id', 'rule', 'finding_revision', 'finding_sha256', 'captured_at', 'source', 'provenance', 'authority', 'evidence_sha256']);
  fail(value.schema_version === 1 && same(scopeOf(value.scope), scope) && same(value.scope, scope), 'EVIDENCE', 'Evidence scope differs.');
  fail(typeof value.source_commit === 'string' && SOURCE_COMMIT.test(value.source_commit) && /^F-[a-f0-9]{16}$/.test(value.finding_id || '') && RULE.test(value.rule || '') && value.rule === rule,
    'EVIDENCE', 'Evidence must bind one exact source, finding and rule.');
  for (const key of ['snapshot_sha256', 'audit_sha256', 'finding_revision', 'finding_sha256', 'evidence_sha256']) fail(DIGEST.test(value[key] || ''), 'EVIDENCE', 'Evidence digest is invalid.');
  instant(value.captured_at);
  fail(['provided-snapshot', 'synthetic-fixture'].includes(value.source) && value.provenance === 'caller-supplied-data' && value.authority === 'none', 'EVIDENCE', 'Supplied evidence is not authenticated authority.');
  const { evidence_sha256, ...body } = value;
  fail(value.evidence_id === evidenceIdentity(value) && evidence_sha256 === feedbackDigest(body), 'EVIDENCE', 'Evidence identity or content changed.');
}

export function createFeedbackEvidence({ snapshot, findingId, now = new Date(), source = 'provided-snapshot' }) {
  fail(['provided-snapshot', 'synthetic-fixture'].includes(source), 'EVIDENCE', 'Feedback does not certify live collection.');
  fail(typeof snapshot?.scope?.source_commit === 'string' && SOURCE_COMMIT.test(snapshot.scope.source_commit), 'EVIDENCE', 'Feedback evidence requires an exact 40- or 64-character source commit.');
  const at = instant(now);
  // Reuse the existing snapshot validation/auditor and its read-only policy load.
  const report = audit(snapshot, { now: new Date(at), source });
  fail(report.freshness === 'within-policy-window', 'EVIDENCE', 'Stale data cannot create new feedback evidence.');
  const finding = report.findings.find(item => item.id === findingId);
  fail(finding !== undefined, 'EVIDENCE', 'The exact finding must exist in the supplied audit.');
  const body = { schema_version: 1, scope: scopeOf(snapshot.scope), source_commit: snapshot.scope.source_commit,
    snapshot_sha256: feedbackDigest(snapshot), audit_sha256: auditDigest(report), finding_id: finding.id,
    rule: finding.rule, finding_revision: finding.revision, finding_sha256: auditDigest(finding),
    captured_at: instant(snapshot.captured_at), source, provenance: 'caller-supplied-data', authority: 'none' };
  body.evidence_id = evidenceIdentity(body);
  return { ...body, evidence_sha256: feedbackDigest(body) };
}

export function createFeedbackCorpus({ scope, maxActive = 8, now = new Date() }) {
  fail(Number.isSafeInteger(maxActive) && maxActive >= 1 && maxActive <= FEEDBACK_LIMITS.maxActive, 'CAP', 'Active feedback cap is outside its finite bounds.');
  const at = instant(now);
  return { schema_version: 1, mode: 'advisory-only', scope: scopeOf(scope), max_active: maxActive,
    max_records: FEEDBACK_LIMITS.maxRecords, revision: 0, created_at: at, updated_at: at, records: [] };
}

function recordIdentity(record, scope) {
  return `FB-${feedbackDigest({ scope, rule: record.rule, guidance: record.guidance, evidence_ids: record.evidence.map(item => item.evidence_id).sort(), expires_at: record.expires_at, supersedes: record.supersedes })}`;
}
function checkReview(review) {
  keys(review, ['decision', 'at', 'evidence_sha256', 'reason', 'operator_label', 'identity_verification', 'independent_review_verified', 'human_approval_verified']);
  fail(['activate', 'reject'].includes(review.decision) && DIGEST.test(review.evidence_sha256 || ''), 'REVIEW', 'An exact local review-evidence digest and decision are required.');
  instant(review.at); plain(review.reason, 1600);
  if (review.operator_label !== null) plain(review.operator_label, 120);
  fail(review.identity_verification === 'not-performed' && review.independent_review_verified === false && review.human_approval_verified === false,
    'REVIEW', 'Names and digests cannot certify human or independent approval.');
}
function checkCorpus(corpus) {
  keys(corpus, ['schema_version', 'mode', 'scope', 'max_active', 'max_records', 'revision', 'created_at', 'updated_at', 'records']);
  fail(corpus.schema_version === 1 && corpus.mode === 'advisory-only' && same(scopeOf(corpus.scope), corpus.scope), 'SCHEMA', 'Only scoped advisory corpus version 1 is supported.');
  fail(Number.isSafeInteger(corpus.max_active) && corpus.max_active >= 1 && corpus.max_active <= FEEDBACK_LIMITS.maxActive && corpus.max_records === FEEDBACK_LIMITS.maxRecords, 'CAP', 'Corpus limits changed or exceed bounds.');
  fail(Array.isArray(corpus.records) && corpus.records.length <= corpus.max_records && Number.isSafeInteger(corpus.revision) && corpus.revision >= 0 && corpus.revision <= FEEDBACK_LIMITS.maxRecords * 3, 'BOUND', 'Corpus history exceeds its bounds.');
  const created = Date.parse(instant(corpus.created_at)), updated = Date.parse(instant(corpus.updated_at));
  fail(updated >= created, 'TIME', 'Corpus time moved backwards.');
  const ids = new Set();
  for (const record of corpus.records) {
    keys(record, ['id', 'rule', 'guidance', 'evidence', 'created_at', 'expires_at', 'supersedes', 'status', 'review', 'retirement']);
    fail(RECORD_ID.test(record.id || '') && !ids.has(record.id) && RULE.test(record.rule || ''), 'SCHEMA', 'Feedback identities must be valid and unique.'); ids.add(record.id);
    guidanceOf(record.guidance);
    fail(Array.isArray(record.evidence) && record.evidence.length >= 1 && record.evidence.length <= FEEDBACK_LIMITS.maxEvidence, 'EVIDENCE', 'Evidence count is outside its bounds.');
    for (const item of record.evidence) checkEvidence(item, corpus.scope, record.rule);
    fail(new Set(record.evidence.map(item => item.evidence_id)).size === record.evidence.length, 'EVIDENCE', 'Repeated captures of the same finding revision are one evidence identity.');
    const made = Date.parse(instant(record.created_at)), expires = Date.parse(instant(record.expires_at));
    fail(made >= created && made <= updated && expires > made && expires <= made + FEEDBACK_LIMITS.maxLifetimeDays * DAY, 'TIME', 'Feedback lifetime exceeds its prospective bound.');
    fail(record.supersedes === null || RECORD_ID.test(record.supersedes), 'SUPERSESSION', 'Supersession must identify an exact feedback record.');
    fail(record.id === recordIdentity(record, corpus.scope), 'SCHEMA', 'Feedback proposal identity changed.');
    fail(['candidate', 'active', 'retired'].includes(record.status), 'STATE', 'Unknown feedback state.');
    if (record.review !== null) {
      checkReview(record.review); fail(Date.parse(record.review.at) >= made && Date.parse(record.review.at) <= updated, 'TIME', 'Review time is inconsistent.');
      if (record.review.decision === 'activate') fail(record.evidence.length >= FEEDBACK_LIMITS.minEvidence && Date.parse(record.review.at) < expires, 'STATE', 'Activation history lacks sufficient prospective evidence.');
    }
    if (record.status === 'candidate') fail(record.review === null && record.retirement === null, 'STATE', 'Candidate already has a decision.');
    if (record.status === 'active') fail(record.review?.decision === 'activate' && record.evidence.length >= FEEDBACK_LIMITS.minEvidence && record.retirement === null && Date.parse(record.review.at) < expires, 'STATE', 'Active feedback lacks a valid prospective local decision.');
    if (record.status === 'retired') {
      keys(record.retirement, ['at', 'reason', 'disposition', 'superseded_by']);
      instant(record.retirement.at); plain(record.retirement.reason, 1600);
      fail(record.review !== null && Date.parse(record.retirement.at) >= Date.parse(record.review.at) && Date.parse(record.retirement.at) <= updated, 'STATE', 'Retirement lacks its preceding decision.');
      fail(['rejected', 'operator-retired', 'superseded'].includes(record.retirement.disposition), 'STATE', 'Unknown retirement disposition.');
      fail(record.retirement.disposition === 'rejected' ? record.review.decision === 'reject' : record.review.decision === 'activate', 'STATE', 'Retirement contradicts the review decision.');
      fail(record.retirement.disposition === 'superseded' ? RECORD_ID.test(record.retirement.superseded_by || '') : record.retirement.superseded_by === null, 'SUPERSESSION', 'Invalid retirement linkage.');
    }
  }
  fail(corpus.records.filter(record => record.status === 'active').length <= corpus.max_active, 'CAP', 'Active feedback exceeds the fixed cap.');
  for (const record of corpus.records) {
    if (record.supersedes !== null) {
      const previous = corpus.records.find(item => item.id === record.supersedes && item.id !== record.id && item.rule === record.rule);
      fail(previous !== undefined, 'SUPERSESSION', 'Superseded record is missing or belongs to another rule.');
      if (record.review?.decision === 'activate') fail(previous.retirement?.disposition === 'superseded' && previous.retirement.superseded_by === record.id, 'SUPERSESSION', 'Activated replacement did not retire its exact predecessor.');
    }
    if (record.retirement?.disposition === 'superseded') fail(corpus.records.some(next => next.id === record.retirement.superseded_by && next.supersedes === record.id && next.review?.decision === 'activate'), 'SUPERSESSION', 'Supersession receipt has no matching activated successor.');
  }
  feedbackDigest(corpus);
  return corpus;
}
function transition(corpus, next, recordId, kind, at) {
  next.revision += 1; next.updated_at = at; checkCorpus(next);
  const record = next.records.find(item => item.id === recordId), corpusDigest = feedbackDigest(next);
  return { corpus: next, record: clone(record), recordDigest: feedbackDigest(record), corpusDigest,
    transition: { kind, at, record_id: recordId, previous_corpus_digest: feedbackDigest(corpus), next_corpus_digest: corpusDigest, authority: 'none' } };
}
function changeTime(corpus, now) {
  checkCorpus(corpus); const at = instant(now);
  fail(Date.parse(at) >= Date.parse(corpus.updated_at), 'TIME', 'Feedback changes cannot move time backwards.');
  return at;
}

export function proposeFeedback({ corpus, rule, guidance, evidence, expiresAt, supersedes = null, now = new Date() }) {
  const at = changeTime(corpus, now);
  fail(RULE.test(rule || ''), 'RULE', 'An exact existing finding rule is required.');
  fail(corpus.records.length < corpus.max_records, 'CAP', 'Corpus is full; preserve/archive it before creating another version.');
  fail(Array.isArray(evidence) && evidence.length >= 1 && evidence.length <= FEEDBACK_LIMITS.maxEvidence, 'EVIDENCE', 'Bounded source evidence is required.');
  for (const item of evidence) { checkEvidence(item, corpus.scope, rule); fail(Date.parse(item.captured_at) <= Date.parse(at) + 300000, 'TIME', 'Evidence capture lies in the future.'); }
  if (supersedes !== null) fail(corpus.records.some(item => item.id === supersedes && item.status === 'active' && item.rule === rule), 'SUPERSESSION', 'Only an exact active rule may be proposed for replacement.');
  const record = { rule, guidance: guidanceOf(guidance), evidence: clone(evidence).sort((a,b) => a.evidence_id.localeCompare(b.evidence_id)),
    created_at: at, expires_at: instant(expiresAt), supersedes, status: 'candidate', review: null, retirement: null };
  record.id = recordIdentity(record, corpus.scope);
  fail(!corpus.records.some(item => item.id === record.id), 'DUPLICATE', 'This exact feedback proposal already exists.');
  const next = clone(corpus); next.records.push(record);
  return transition(corpus, next, record.id, 'candidate-proposed', at);
}

export function reviewFeedback({ corpus, candidateId, expectedCandidateDigest, decision, reviewEvidence, now = new Date() }) {
  const at = changeTime(corpus, now), current = corpus.records.find(item => item.id === candidateId);
  fail(current?.status === 'candidate' && DIGEST.test(expectedCandidateDigest || '') && feedbackDigest(current) === expectedCandidateDigest, 'STALE', 'Review must bind the exact undecided candidate.');
  fail(['activate', 'reject'].includes(decision), 'REVIEW', 'An explicit activate or reject decision is required.');
  keys(reviewEvidence, ['sha256', 'reason', 'operatorLabel'], 'REVIEW');
  fail(DIGEST.test(reviewEvidence.sha256 || ''), 'REVIEW', 'A content-bound local review record is required.');
  plain(reviewEvidence.reason, 1600); if (reviewEvidence.operatorLabel !== undefined) plain(reviewEvidence.operatorLabel, 120);
  const next = clone(corpus), record = next.records.find(item => item.id === candidateId);
  record.review = { decision, at, evidence_sha256: reviewEvidence.sha256, reason: reviewEvidence.reason,
    operator_label: reviewEvidence.operatorLabel ?? null, identity_verification: 'not-performed', independent_review_verified: false, human_approval_verified: false };
  if (decision === 'reject') {
    record.status = 'retired'; record.retirement = { at, reason: reviewEvidence.reason, disposition: 'rejected', superseded_by: null };
  } else {
    fail(record.evidence.length >= FEEDBACK_LIMITS.minEvidence, 'EVIDENCE', 'Activation requires at least two distinct finding/source evidence identities; independence still needs external review.');
    fail(Date.parse(at) < Date.parse(record.expires_at), 'EXPIRED', 'Expired feedback cannot be activated.');
    if (record.supersedes !== null) {
      const previous = next.records.find(item => item.id === record.supersedes);
      fail(previous?.status === 'active', 'SUPERSESSION', 'Supersession target is no longer active.');
      previous.status = 'retired'; previous.retirement = { at, reason: 'Replaced by an explicitly reviewed advisory rule.', disposition: 'superseded', superseded_by: record.id };
    }
    record.status = 'active';
  }
  return transition(corpus, next, record.id, decision === 'activate' ? 'candidate-activated' : 'candidate-rejected', at);
}

export function retireFeedback({ corpus, ruleId, expectedRuleDigest, reason, now = new Date() }) {
  const at = changeTime(corpus, now), current = corpus.records.find(item => item.id === ruleId);
  fail(current?.status === 'active' && DIGEST.test(expectedRuleDigest || '') && feedbackDigest(current) === expectedRuleDigest, 'STALE', 'Retirement must bind the exact active rule.');
  plain(reason, 1600);
  const next = clone(corpus), record = next.records.find(item => item.id === ruleId);
  record.status = 'retired'; record.retirement = { at, reason, disposition: 'operator-retired', superseded_by: null };
  return transition(corpus, next, record.id, 'active-retired', at);
}

export function observeFeedback({ corpus, report, evidenceDigest, now = new Date() }) {
  checkCorpus(corpus); const at = instant(now), scope = scopeOf(report?.scope);
  fail(same(scope, corpus.scope) && report.schema_version === 1 && report.mode === 'audit-only' && report.freshness === 'within-policy-window' && report.github_mutations === 0 && report.assignment_changes === 0 && Array.isArray(report.executed_actions) && report.executed_actions.length === 0,
    'REPORT', 'Only a current scoped zero-mutation audit can receive advisory feedback.');
  fail(DIGEST.test(evidenceDigest || '') && Array.isArray(report.findings) && report.findings.length <= 30000, 'REPORT', 'A bounded evidence-bound report is required.');
  fail(Date.parse(at) >= Date.parse(corpus.updated_at), 'TIME', 'Cannot apply feedback before its recorded decisions.');
  const skipped_rules = [], activeRecords = [];
  const findingIds = new Set(), findingCounts = new Map();
  for (const finding of report.findings) {
    fail(isObject(finding) && /^F-[a-f0-9]{16}$/.test(finding.id || '') && !findingIds.has(finding.id) && RULE.test(finding.rule || '') && DIGEST.test(finding.revision || ''), 'REPORT', 'Finding identity or revision is invalid.');
    findingIds.add(finding.id);
    findingCounts.set(finding.rule, (findingCounts.get(finding.rule) || 0) + 1);
  }
  let annotationCount = 0, annotationBytes = 0;
  const placeholder = '0'.repeat(64);
  const annotation = (record, finding, recordDigest, findingDigest) => ({
    finding_id: finding.id, finding_revision: finding.revision, finding_digest: findingDigest,
    feedback_rule_id: record.id, feedback_rule_digest: recordDigest, guidance: clone(record.guidance),
    evidence_ids: record.evidence.map(item => item.evidence_id), advisory_only: true, authority: 'none',
  });
  for (const record of [...corpus.records].sort((a,b) => a.id.localeCompare(b.id))) {
    if (record.status !== 'active' || Date.parse(record.expires_at) <= Date.parse(at)) {
      skipped_rules.push({ rule_id: record.id, reason: record.status === 'active' ? 'expired' : record.retirement?.disposition ?? record.status }); continue;
    }
    const matches = findingCounts.get(record.rule) || 0;
    annotationCount += matches;
    fail(annotationCount <= FEEDBACK_LIMITS.maxAnnotations, 'OUTPUT_BOUND', 'Advisory annotation count exceeds its finite bound; no partial annotations are emitted.');
    // Validated finding IDs/revisions and digests have fixed ASCII lengths. One
    // bounded template therefore measures every matching annotation exactly,
    // including JSON escaping and multibyte guidance, before fanout allocation.
    const template = annotation(record, { id: `F-${'0'.repeat(16)}`, revision: placeholder }, placeholder, placeholder);
    annotationBytes += matches * Buffer.byteLength(JSON.stringify(template));
    activeRecords.push(record);
  }
  const result = { schema_version: 1, corpus_digest: placeholder, report_digest: placeholder,
    evidence_digest: evidenceDigest, annotations: [], skipped_rules, executed_actions: [], authority: 'none' };
  const outputBytes = Buffer.byteLength(JSON.stringify(result)) + annotationBytes + Math.max(0, annotationCount - 1);
  fail(outputBytes <= FEEDBACK_LIMITS.maxOutputBytes, 'OUTPUT_BOUND', 'Advisory output exceeds its finite byte bound; no partial annotations are emitted.');
  const findings = [...report.findings].sort((a,b) => a.id.localeCompare(b.id));
  for (const record of activeRecords) {
    const recordDigest = feedbackDigest(record);
    for (const finding of findings) if (finding.rule === record.rule) {
      result.annotations.push(annotation(record, finding, recordDigest, auditDigest(finding)));
    }
  }
  result.corpus_digest = feedbackDigest(corpus); result.report_digest = auditDigest(report);
  return result;
}
