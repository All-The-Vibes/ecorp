import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync,
  openSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setImmediate } from 'node:timers/promises';
import { loadPolicy, requireThat, safeText, StewardError, validateSnapshot } from './common.mjs';
import { audit } from './steward.mjs';
import { feedbackDigest, observeFeedback } from './feedback.mjs';

const MAX_ATTEMPTS = 100;
const MAX_TRANSITIONS = 200;
const MAX_FINDINGS = 1000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_STATE_BYTES = 64 * 1024 * 1024;
const SOURCES = ['provided-snapshot', 'synthetic-fixture', 'live-github-two-pass'];
const DIGEST = /^[a-f0-9]{64}$/;
const ARTIFACT = /^artifact-[a-f0-9]{64}\.json$/;
const ownFile = /^(?:artifact-[a-f0-9]{64}|intent-[0-9]{4}|control-intent-[0-9]{4}|state)\.json$|^audit\.lock$/;
const normalized = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const sameIdentity = (a, b) => a.dev === b.dev && a.ino === b.ino && a.birthtimeMs === b.birthtimeMs;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const canonicalJson = value => Array.isArray(value) ? `[${value.map(canonicalJson).join(',')}]`
  : value !== null && typeof value === 'object'
    ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
    : JSON.stringify(value);
// Match native JSON serialization of optional fields before ordering keys. The
// existing auditor may include undefined optional metadata in its JS objects.
const canonical = value => canonicalJson(JSON.parse(JSON.stringify(value)));
const encode = value => Buffer.from(`${canonical(value)}\n`, 'utf8');
const digest = value => sha(encode(value));
const checkedTime = value => {
  const now = value === undefined ? new Date() : new Date(value);
  requireThat(Number.isFinite(now.getTime()), 'CLOCK', 'A valid audit time is required.');
  return now;
};
const pinSource = value => requireThat(typeof value === 'string' && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value), 'SOURCE_PIN', 'An exact 40- or 64-character source commit is required.');

function implementation() {
  return Object.fromEntries(['recurring-audit.mjs', 'common.mjs', 'steward.mjs', 'feedback.mjs', '../policy.json'].map(name => {
    const file = fileURLToPath(new URL(name, import.meta.url));
    return [name, sha(readFileSync(file))];
  }));
}

function directoryChain(directory, create = false) {
  requireThat(typeof directory === 'string' && path.isAbsolute(directory), 'STATE_PATH', 'State directory must be an explicit absolute path.');
  const absolute = path.resolve(directory), volume = path.parse(absolute).root;
  let current = volume;
  for (const component of path.relative(volume, absolute).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    if (!existsSync(current)) {
      requireThat(create, 'STATE_MISSING', 'Audit state does not exist.');
      try { mkdirSync(current, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    const info = lstatSync(current);
    requireThat(info.isDirectory() && !info.isSymbolicLink(), 'STATE_REDIRECT', 'State directory cannot contain symbolic links or redirected directories.');
    requireThat(normalized(realpathSync(current)) === normalized(current), 'STATE_REDIRECT', 'State directory resolved outside its declared path.');
  }
  return { directory: absolute, identity: lstatSync(absolute) };
}

function assertDirectory(context) {
  const current = directoryChain(context.directory);
  requireThat(sameIdentity(context.identity, current.identity), 'STATE_REPLACED', 'Audit state directory identity changed.');
}

function readOrdinary(context, name) {
  assertDirectory(context);
  requireThat(ownFile.test(name), 'STATE_FILE', 'Unexpected audit state filename.');
  const file = path.join(context.directory, name);
  requireThat(existsSync(file), 'STATE_INTEGRITY', 'A required audit history file is missing.');
  const before = lstatSync(file);
  requireThat(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && before.size <= MAX_FILE_BYTES, 'STATE_FILE', 'State must contain bounded ordinary files without links.');
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    requireThat(sameIdentity(before, fstatSync(fd)), 'STATE_REPLACED', 'State file changed during open.');
    const bytes = readFileSync(fd);
    requireThat(bytes.length <= MAX_FILE_BYTES && sameIdentity(before, lstatSync(file)), 'STATE_REPLACED', 'State file changed during read.');
    assertDirectory(context);
    return bytes;
  } finally { closeSync(fd); }
}

function storedBytes(context) {
  assertDirectory(context);
  const names = readdirSync(context.directory);
  requireThat(names.length <= 800 && names.every(name => ownFile.test(name)), 'STATE_AMBIGUOUS', 'Unknown or excessive files in the audit state directory; preserve them for reconciliation.');
  return names.reduce((total, name) => {
    const info = lstatSync(path.join(context.directory, name));
    requireThat(info.isFile() && !info.isSymbolicLink() && info.nlink === 1, 'STATE_FILE', 'Redirected or linked state file rejected.');
    return total + info.size;
  }, 0);
}

function writeExclusive(context, name, bytes) {
  assertDirectory(context);
  requireThat(ownFile.test(name) && bytes.length <= MAX_FILE_BYTES, 'OUTPUT_BOUND', 'Audit artifact exceeds its bounded file contract.');
  requireThat(storedBytes(context) + bytes.length <= MAX_STATE_BYTES, 'OUTPUT_BOUND', 'Audit state storage bound reached; retain existing evidence.');
  const destination = path.join(context.directory, name);
  const fd = openSync(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  assertDirectory(context);
  return { file: name, sha256: sha(bytes), bytes: bytes.length };
}

function artifact(context, value) {
  const bytes = encode(value), name = `artifact-${sha(bytes)}.json`;
  if (existsSync(path.join(context.directory, name))) {
    requireThat(readOrdinary(context, name).equals(bytes), 'STATE_INTEGRITY', 'Existing artifact does not match its content address.');
    return { file: name, sha256: sha(bytes), bytes: bytes.length };
  }
  return writeExclusive(context, name, bytes);
}

function readArtifact(context, reference) {
  requireThat(reference && ARTIFACT.test(reference.file) && DIGEST.test(reference.sha256) && reference.file === `artifact-${reference.sha256}.json`, 'STATE_INTEGRITY', 'Invalid content-addressed reference.');
  const bytes = readOrdinary(context, reference.file);
  requireThat(bytes.length === reference.bytes && sha(bytes) === reference.sha256, 'STATE_INTEGRITY', 'Audit artifact integrity check failed.');
  return JSON.parse(bytes);
}

function load(context, policy) {
  if (!existsSync(path.join(context.directory, 'state.json'))) return null;
  const pointer = JSON.parse(readOrdinary(context, 'state.json'));
  const cache = new Map(), implementationDigest = canonical(implementation()), policyDigest = digest(policy);
  const checked = reference => {
    const key = canonical(reference);
    if (!cache.has(key)) cache.set(key, readArtifact(context, reference));
    return cache.get(key);
  };
  const state = checked(pointer.checkpoint);
  let reference = pointer.checkpoint, child = null, traversed = 0;
  while (reference) {
    requireThat(++traversed <= MAX_TRANSITIONS + 1, 'STATE_INTEGRITY', 'Checkpoint history exceeds its bound or contains a cycle.');
    const current = checked(reference);
    requireThat(current.schema_version === 1 && current.control && ['running', 'paused', 'stopped'].includes(current.control.status), 'STATE_INTEGRITY', 'Invalid audit checkpoint.');
    pinSource(current.sourceCommit);
    requireThat(SOURCES.includes(current.source) && Number.isSafeInteger(current.attempts) && current.attempts >= 0 && current.attempts <= MAX_ATTEMPTS && Number.isSafeInteger(current.version) && current.version >= 0 && current.version <= MAX_TRANSITIONS, 'STATE_INTEGRITY', 'Invalid checkpoint bounds.');
    requireThat(current.policy_digest === policyDigest && canonical(current.implementation_digests) === implementationDigest, 'IMPLEMENTATION_DRIFT', 'Audit implementation or policy changed; start a separately reviewed state directory.');
    requireThat(current.sourceCommit === state.sourceCommit && current.source === state.source, 'STATE_INTEGRITY', 'Checkpoint source history changed.');
    if (current.latest) {
      checked(current.latest.report);
      if (current.latest.handoff) checked(current.latest.handoff);
      if (current.latest.feedback) checked(current.latest.feedback);
    }
    if (current.receipt) {
      const receipt = checked(current.receipt);
      requireThat(receipt.sourceCommit === current.sourceCommit && ['audit-cycle', 'audit-cycle-failure', 'audit-control'].includes(receipt.kind), 'STATE_INTEGRITY', 'Invalid history receipt binding.');
      const intent = readOrdinary(context, receipt.intent.file);
      requireThat(sha(intent) === receipt.intent.sha256 && intent.length === receipt.intent.bytes, 'STATE_INTEGRITY', 'Receipt intent integrity check failed.');
      requireThat(canonical(JSON.parse(intent).previous) === canonical(current.previous_checkpoint), 'STATE_INTEGRITY', 'Receipt intent does not bind its predecessor.');
      for (const key of ['report', 'handoff', 'feedback']) if (receipt[key]) checked(receipt[key]);
      requireThat(!receipt.partial_artifacts || Array.isArray(receipt.partial_artifacts) && receipt.partial_artifacts.length <= 4, 'STATE_INTEGRITY', 'Invalid partial-artifact history.');
      for (const item of receipt.partial_artifacts || []) checked(item);
    } else requireThat(current.version === 0 && current.attempts === 0 && current.previous_checkpoint === null, 'STATE_INTEGRITY', 'Only the initial checkpoint may omit a receipt.');
    if (child) {
      const childReceipt = checked(child.receipt);
      requireThat(child.version === current.version + 1 && child.attempts === current.attempts + (childReceipt.kind === 'audit-control' ? 0 : 1), 'STATE_INTEGRITY', 'Checkpoint counters are not monotonic.');
    }
    child = current; reference = current.previous_checkpoint;
  }
  requireThat(traversed === state.version + 1, 'STATE_INTEGRITY', 'Checkpoint history is incomplete.');
  const names = readdirSync(context.directory);
  const attempts = names.filter(name => /^intent-[0-9]{4}\.json$/.test(name));
  requireThat(attempts.length === state.attempts && attempts.every(name => Number(name.slice(7, 11)) >= 1 && Number(name.slice(7, 11)) <= state.attempts), 'STATE_AMBIGUOUS', 'Attempt journal and checkpoint disagree; preserve them for reconciliation.');
  requireThat(names.filter(name => /^control-intent-[0-9]{4}\.json$/.test(name)).every(name => Number(name.slice(15, 19)) <= state.version), 'STATE_AMBIGUOUS', 'An incomplete control/checkpoint write needs reconciliation.');
  return { state, checkpoint: pointer.checkpoint };
}

function checkpoint(context, state, previous = null) {
  const next = { ...state, previous_checkpoint: previous };
  const reference = artifact(context, next), bytes = encode({ schema_version: 1, checkpoint: reference });
  // The immutable checkpoint is durable first. A failed pointer replacement leaves
  // its intent and artifacts intact; callers never guess whether to replay it.
  const temporary = `control-intent-${String(9000 + state.version).padStart(4, '0')}.json`;
  writeExclusive(context, temporary, bytes);
  assertDirectory(context);
  const destination = path.join(context.directory, 'state.json');
  if (existsSync(destination)) readOrdinary(context, 'state.json');
  renameSync(path.join(context.directory, temporary), destination);
  assertDirectory(context);
  return { state: next, checkpoint: reference };
}

async function locked(stateDirectory, operation) {
  const context = directoryChain(stateDirectory, true);
  storedBytes(context);
  const lockPath = path.join(context.directory, 'audit.lock');
  const lockBytes = encode({ schema_version: 1, pid: process.pid, nonce: randomUUID(), started_at: new Date().toISOString() });
  let fd;
  try { fd = openSync(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600); }
  catch (error) { if (error.code === 'EEXIST') throw new StewardError('LOCKED', 'Audit state is locked; no automatic lock recovery or duplicate operation is attempted.'); throw error; }
  writeFileSync(fd, lockBytes); fsyncSync(fd); const identity = fstatSync(fd);
  try {
    await setImmediate(); // Permit another caller to observe the exclusive lock.
    return await operation(context);
  } finally {
    closeSync(fd);
    assertDirectory(context);
    requireThat(sameIdentity(identity, lstatSync(lockPath)) && readOrdinary(context, 'audit.lock').equals(lockBytes), 'LOCK_CHANGED', 'Audit lock changed; preserve it for reconciliation.');
    unlinkSync(lockPath);
  }
}

function initialize(context, { sourceCommit, source, policy, now }) {
  requireThat(readdirSync(context.directory).every(name => name === 'audit.lock'), 'STATE_AMBIGUOUS', 'Partial audit state exists without a checkpoint; preserve it for reconciliation.');
  return checkpoint(context, { schema_version: 1, sourceCommit, source, policy_digest: digest(policy), implementation_digests: implementation(), attempts: 0, version: 0, control: { status: 'running', reason: 'Initialized bounded audit-only state.', updated_at: now.toISOString() }, latest: null, receipt: null });
}

function sourceMatches(state, sourceCommit, source) {
  pinSource(sourceCommit);
  requireThat(state.sourceCommit === sourceCommit && (!source || state.source === source), 'SOURCE_DRIFT', 'Source identity changed; the existing audit source pin cannot be replaced.');
}

function semanticSnapshot(snapshot) {
  // Timestamp and transport counters are observation metadata. All audit-scoped
  // content, revisions, complete-coverage counts and source identities remain.
  const { captured_at: _captured, collection: _collection, ...content } = snapshot;
  return content;
}

export function readAuditState({ stateDirectory }) {
  if (!existsSync(stateDirectory)) return null;
  const context = directoryChain(stateDirectory);
  requireThat(!existsSync(path.join(context.directory, 'audit.lock')), 'LOCKED', 'An audit operation is active or needs lock reconciliation.');
  const loaded = load(context, loadPolicy());
  if (!loaded) {
    requireThat(readdirSync(context.directory).length === 0, 'STATE_AMBIGUOUS', 'Audit state is incomplete; preserve it for reconciliation.');
    return null;
  }
  return { status: loaded.state.control.status, sourceCommit: loaded.state.sourceCommit, attempts: loaded.state.attempts, checkpoint: loaded.checkpoint, control: loaded.state.control };
}

export async function setAuditControl({ stateDirectory, sourceCommit, action, reason, now }) {
  pinSource(sourceCommit); const at = checkedTime(now);
  requireThat(['pause', 'resume', 'stop'].includes(action) && typeof reason === 'string' && reason.trim() && reason.length <= 1000, 'CONTROL', 'A bounded pause, resume or stop reason is required.');
  requireThat(existsSync(stateDirectory), 'STATE_MISSING', 'Initialize an audit cycle before changing controls.');
  return locked(stateDirectory, context => {
    const loaded = load(context, loadPolicy()); requireThat(loaded, 'STATE_MISSING', 'Audit state is missing.');
    sourceMatches(loaded.state, sourceCommit);
    const status = { pause: 'paused', resume: 'running', stop: 'stopped' }[action];
    requireThat(loaded.state.control.status !== 'stopped' || status === 'stopped', 'STOPPED', 'Stopped audit state cannot be resumed.');
    if (loaded.state.control.status === status) return { status, receipt: loaded.state.receipt, checkpoint: loaded.checkpoint };
    requireThat(loaded.state.version < MAX_TRANSITIONS - (action === 'stop' ? 0 : 1), 'CONTROL_BOUND', 'Audit transition bound reached; only the reserved terminal stop may remain.');
    const version = loaded.state.version + 1;
    const intentName = `control-intent-${String(version).padStart(4, '0')}.json`;
    requireThat(!existsSync(path.join(context.directory, intentName)), 'STATE_AMBIGUOUS', 'A prior control intent needs reconciliation; it is not retried.');
    const intent = writeExclusive(context, intentName, encode({ action, sourceCommit, previous: loaded.checkpoint, at: at.toISOString() }));
    const receipt = artifact(context, { schema_version: 1, kind: 'audit-control', action, status, sourceCommit, at: at.toISOString(), reason: safeText(reason, 1000), intent, execution_authority: 'none' });
    const updated = checkpoint(context, { ...loaded.state, version, control: { status, reason: safeText(reason, 1000), updated_at: at.toISOString() }, receipt }, loaded.checkpoint);
    return { status, receipt, checkpoint: updated.checkpoint };
  });
}

export async function runAuditCycle({ stateDirectory, snapshot, sourceCommit, source = 'provided-snapshot', now, corpus = null }) {
  pinSource(sourceCommit); requireThat(SOURCES.includes(source), 'SOURCE', 'Invalid audit source label.');
  const at = checkedTime(now), policy = loadPolicy();
  return locked(stateDirectory, context => {
    let loaded = load(context, policy) || initialize(context, { sourceCommit, source, policy, now: at });
    sourceMatches(loaded.state, sourceCommit, source);
    if (loaded.state.control.status !== 'running') return { status: loaded.state.control.status, sourceCommit, attempts: loaded.state.attempts, receipt: loaded.state.receipt, checkpoint: loaded.checkpoint, newFindings: [], resolvedFindingIds: [], handoff: null };
    requireThat(loaded.state.attempts < MAX_ATTEMPTS, 'ATTEMPT_BOUND', 'The 100-attempt audit bound is exhausted; no background run is created.');
    requireThat(loaded.state.version < MAX_TRANSITIONS - 1, 'CONTROL_BOUND', 'Audit transition bound reached; stop this finite state directory.');
    const attempt = loaded.state.attempts + 1, intentName = `intent-${String(attempt).padStart(4, '0')}.json`;
    requireThat(!existsSync(path.join(context.directory, intentName)), 'STATE_AMBIGUOUS', 'A previous incomplete attempt must be reconciled; no automatic replay is allowed.');
    const intent = writeExclusive(context, intentName, encode({ schema_version: 1, kind: 'audit-attempt-intent', attempt, sourceCommit, source, at: at.toISOString(), previous: loaded.checkpoint }));
    let checkpointAttempted = false;
    const partialArtifacts = [];
    try {
      validateSnapshot(snapshot, policy);
      requireThat(snapshot.scope.source_commit === sourceCommit, 'SOURCE_DRIFT', 'Snapshot no longer matches the pinned repository source.');
      const age = at.getTime() - Date.parse(snapshot.captured_at);
      requireThat(age >= -300000 && age <= policy.max_snapshot_age_minutes * 60000, 'STALE_SNAPSHOT', 'A stale or future snapshot cannot be used by a recurring audit.');
      if (source === 'live-github-two-pass') requireThat(snapshot.collection?.authenticated_login === policy.collector_login && snapshot.collection?.writes === 0, 'SOURCE', 'Live source metadata must retain the existing read-only collector identity.');
      const evidenceDigest = digest(semanticSnapshot(snapshot)), snapshotDigest = digest(snapshot), corpusDigest = corpus === null ? null : feedbackDigest(corpus);
      const previous = loaded.state.latest;
      let noOp = previous?.evidence_digest === evidenceDigest && previous?.corpus_digest === corpusDigest;
      if (noOp && corpus !== null) {
        // Expiry can change advisory output even when corpus bytes do not change.
        const priorReport = readArtifact(context, previous.report);
        noOp = digest(observeFeedback({ corpus, report: priorReport, evidenceDigest, now: at })) === previous.feedback?.sha256;
      }
      let latest = previous, handoff = null, newFindings = [], resolvedFindingIds = [];
      if (!noOp) {
        const report = audit(snapshot, { policy, source, now: at });
        requireThat(report.findings.length <= MAX_FINDINGS, 'FINDING_BOUND', 'Audit finding bound exceeded; partial findings are not emitted.');
        const reportRef = artifact(context, report); partialArtifacts.push(reportRef);
        const findingRevisions = report.findings.map(f => ({ id: f.id, revision: f.revision, digest: digest(f) }));
        const old = new Map((previous?.finding_revisions || []).map(f => [f.id, f.digest]));
        newFindings = report.findings.filter(f => old.get(f.id) !== digest(f));
        const current = new Set(report.findings.map(f => f.id));
        resolvedFindingIds = [...old.keys()].filter(id => !current.has(id)).sort();
        const feedback = corpus === null ? null : artifact(context, observeFeedback({ corpus, report, evidenceDigest, now: at }));
        if (feedback) partialArtifacts.push(feedback);
        handoff = artifact(context, { schema_version: 1, kind: 'audit-only-handoff', scope: report.scope, sourceCommit, evidence_digest: evidenceDigest, report: reportRef, new_findings: newFindings, resolved_finding_ids: resolvedFindingIds, feedback, executable: false, executed_actions: [], execution_authority: 'none', note: 'Private advisory observations only; no task, permission grant, accepted completion or remote operation.' });
        partialArtifacts.push(handoff);
        latest = { evidence_digest: evidenceDigest, corpus_digest: corpusDigest, report: reportRef, handoff, feedback, finding_revisions: findingRevisions };
      }
      const status = noOp ? 'no-op' : 'recorded';
      const receipt = artifact(context, { schema_version: 1, kind: 'audit-cycle', status, attempt, sourceCommit, source, at: at.toISOString(), captured_at: snapshot.captured_at, snapshot_digest: snapshotDigest, evidence_digest: evidenceDigest, corpus_digest: corpusDigest, intent, report: latest.report, handoff: latest.handoff, feedback: latest.feedback, new_finding_count: newFindings.length, resolved_finding_count: resolvedFindingIds.length, github_mutations: 0, executed_actions: [], execution_authority: 'none' });
      checkpointAttempted = true;
      loaded = checkpoint(context, { ...loaded.state, attempts: attempt, version: loaded.state.version + 1, latest, receipt }, loaded.checkpoint);
      return { status, sourceCommit, attempts: loaded.state.attempts, receipt, checkpoint: loaded.checkpoint, newFindings, resolvedFindingIds, handoff };
    } catch (error) {
      if (!checkpointAttempted) {
        // Preserve failure and intent. Never retry the audit, discard evidence, or
        // reinterpret an uncertain checkpoint write as successful completion.
        const receipt = artifact(context, { schema_version: 1, kind: 'audit-cycle-failure', attempt, sourceCommit, at: at.toISOString(), intent, partial_artifacts: partialArtifacts, error: error instanceof StewardError ? error.code : 'AUDIT_FAILED', message: error instanceof StewardError ? safeText(error.message) : 'Audit failed; raw error details withheld.', executed_actions: [], execution_authority: 'none' });
        checkpoint(context, { ...loaded.state, attempts: attempt, version: loaded.state.version + 1, receipt }, loaded.checkpoint);
      }
      throw error;
    }
  });
}

export async function runAuditCycles({ snapshots, ...options }) {
  requireThat(Array.isArray(snapshots) && snapshots.length >= 1 && snapshots.length <= MAX_ATTEMPTS, 'ATTEMPT_BOUND', 'Supply between 1 and 100 snapshots for a finite local audit.');
  const results = [];
  for (const snapshot of snapshots) {
    const result = await runAuditCycle({ ...options, snapshot }); results.push(result);
    if (['paused', 'stopped'].includes(result.status)) break;
  }
  return results;
}
