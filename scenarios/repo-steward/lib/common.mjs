import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';

export const ROOT = new URL('../', import.meta.url);
export const SCOPE = Object.freeze({ repository: 'All-The-Vibes/ecorp', repository_id: 'R_kgDOUIQ-ng', project_owner: 'All-The-Vibes', project_number: 5, project_id: 'PVT_kwDODYQm6s4BjN3y', collector_login: 'Bakar404' });

export class StewardError extends Error {
  constructor(code, message) { super(message); this.name = 'StewardError'; this.code = code; }
}
export function requireThat(test, code, message) { if (!test) throw new StewardError(code, message); }
export function hash(value) { return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex'); }
export function sameRepo(value) { return typeof value === 'string' && value.toLowerCase() === SCOPE.repository.toLowerCase(); }
export function issueUrl(number) { return `https://github.com/${SCOPE.repository}/issues/${number}`; }
export function prUrl(number) { return `https://github.com/${SCOPE.repository}/pull/${number}`; }
export function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
export function integer(value, min = 1, max = 100000000) { return Number.isSafeInteger(value) && value >= min && value <= max; }
export function validTime(value) { return typeof value === 'string' && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value)); }

// An output scrubber is defense in depth, not permission to ingest credentials.
export function safeText(value, limit = 1000) {
  return String(value ?? '')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}|sk-[A-Za-z0-9_-]{12,})\b/g, '[REDACTED]')
    .replace(/\b(?:postgres(?:ql)?|mysql|redis):\/\/[^\s<>"']+/gi, '[REDACTED_CONNECTION]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '')
    .slice(0, limit);
}
export function safeData(value) {
  if (typeof value === 'string') return safeText(value, 65536);
  if (Array.isArray(value)) return value.map(safeData);
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, safeData(item)]));
  return value;
}
export function markdown(value) { return safeText(value, 2000).replace(/[\\`*_{}[\]()<>#|!]/g, '\\$&').replace(/\r?\n/g, ' '); }

export function loadPolicy() {
  const policy = JSON.parse(readFileSync(new URL('policy.json', ROOT), 'utf8'));
  requireThat(policy.mode === 'audit-only' && policy.schema_version === 1, 'POLICY', 'Only audit-only policy version 1 is supported.');
  for (const [key, value] of Object.entries(SCOPE)) requireThat(policy[key] === value, 'POLICY_SCOPE', `Policy ${key} differs from the approved scope.`);
  requireThat(policy.require_assignee === false, 'POLICY_ASSIGNMENT', 'The steward must not infer or require issue assignments from interests.');
  requireThat(policy.workstreams.length === 10 && new Set(policy.workstreams.map(w => w.id)).size === 10, 'POLICY', 'Ten unique workstreams are required.');
  return policy;
}
export function readJson(path, maxBytes = 16777216) {
  const stat = statSync(path);
  requireThat(stat.isFile() && stat.size <= maxBytes, 'INPUT_BOUND', 'Input must be a bounded regular JSON file.');
  return JSON.parse(readFileSync(path, 'utf8'));
}

function array(value, name, max = 1000) { requireThat(Array.isArray(value) && value.length <= max, 'SNAPSHOT', `Invalid ${name}.`); }
function entity(row, kind) {
  requireThat(isObject(row) && integer(row.number) && typeof row.title === 'string' && typeof row.body === 'string', 'SNAPSHOT', `Invalid ${kind}.`);
  requireThat(Buffer.byteLength(row.body) <= 65536 && row.title.length <= 1024, 'INPUT_BOUND', `${kind} text exceeds its bound.`);
  requireThat(validTime(row.updated_at), 'SNAPSHOT', `Invalid ${kind} revision.`);
  requireThat(row.repository === undefined || sameRepo(row.repository), 'SCOPE', 'Entity is outside the approved repository.');
  requireThat(row.url === (kind === 'issue' ? issueUrl(row.number) : prUrl(row.number)), 'SCOPE', 'Entity URL does not match its identity.');
}
export function validateSnapshot(snapshot, policy = loadPolicy()) {
  requireThat(isObject(snapshot) && snapshot.schema_version === 1, 'SNAPSHOT', 'Unsupported snapshot schema.');
  const scope = snapshot.scope;
  requireThat(isObject(scope) && sameRepo(scope.repository) && scope.project_id === policy.project_id && scope.project_owner === policy.project_owner && scope.project_number === policy.project_number, 'SCOPE', 'Snapshot repository or Project differs from the approved scope.');
  requireThat(scope.repository_id === policy.repository_id && /^[a-f0-9]{40,64}$/.test(scope.source_commit || '') && scope.ecorp_execution_authority === 'none', 'SCOPE', 'Snapshot identity or authority does not match the read-only contract.');
  requireThat(typeof scope.default_branch === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/.test(scope.default_branch), 'SCOPE', 'Invalid default branch.');
  requireThat(validTime(snapshot.captured_at) && isObject(snapshot.coverage) && snapshot.coverage.complete === true, 'INCOMPLETE', 'Partial snapshots cannot produce a complete audit.');
  for (const name of ['issues', 'pull_requests', 'project_items']) {
    array(snapshot[name], name, policy.limits.max_records);
    requireThat(snapshot.coverage[name] === snapshot[name].length, 'INCOMPLETE', `Snapshot count mismatch: ${name}.`);
  }
  requireThat(Buffer.byteLength(JSON.stringify(snapshot)) <= policy.limits.max_bytes, 'INPUT_BOUND', 'Snapshot exceeds byte bound.');
  for (const issue of snapshot.issues) {
    entity(issue, 'issue');
    requireThat(['OPEN', 'CLOSED'].includes(issue.state), 'SNAPSHOT', 'Invalid issue state.');
    for (const name of ['labels', 'assignees', 'blocked_by', 'sub_issues']) array(issue[name], name, 100);
    requireThat(issue.labels.every(x => typeof x === 'string') && issue.assignees.every(x => typeof x === 'string'), 'SNAPSHOT', 'Invalid issue labels or assignees.');
    for (const dependency of [...issue.blocked_by, ...issue.sub_issues, ...(issue.parent ? [issue.parent] : [])]) requireThat(isObject(dependency) && integer(dependency.number) && typeof dependency.repository === 'string', 'SNAPSHOT', 'Invalid issue relationship.');
  }
  for (const pr of snapshot.pull_requests) {
    entity(pr, 'pull request');
    requireThat(['OPEN', 'CLOSED', 'MERGED'].includes(pr.state) && typeof pr.draft === 'boolean' && typeof pr.base_ref === 'string', 'SNAPSHOT', 'Invalid pull-request state.');
    requireThat(/^[a-f0-9]{40,64}$/.test(pr.head_sha), 'SNAPSHOT', 'Invalid PR head.');
    array(pr.closes, 'closing relationships', 100); array(pr.reviews, 'reviews', 100); array(pr.checks, 'checks', 100);
    requireThat(pr.closes.every(x => isObject(x) && integer(x.number) && typeof x.repository === 'string'), 'SNAPSHOT', 'Invalid closing relationship.');
    requireThat(pr.reviews.every(x => isObject(x) && typeof x.author === 'string' && typeof x.state === 'string' && validTime(x.submitted_at)), 'SNAPSHOT', 'Invalid review.');
    requireThat(pr.checks.every(x => isObject(x) && typeof x.name === 'string' && typeof x.state === 'string'), 'SNAPSHOT', 'Invalid check.');
  }
  for (const name of ['issues', 'pull_requests']) requireThat(new Set(snapshot[name].map(row => row.number)).size === snapshot[name].length, 'DUPLICATE', `Duplicate ${name} identity.`);
  const issueNumbers = new Set(snapshot.issues.map(i => i.number));
  const prNumbers = new Set(snapshot.pull_requests.map(i => i.number));
  const contentIds = new Set();
  for (const item of snapshot.project_items) {
    requireThat(isObject(item) && typeof item.id === 'string' && ['Issue', 'PullRequest', 'DraftIssue', 'Unavailable'].includes(item.kind) && typeof item.archived === 'boolean', 'SNAPSHOT', 'Invalid Project item.');
    if (['Issue', 'PullRequest'].includes(item.kind)) {
      requireThat(sameRepo(item.repository) && integer(item.number), 'SCOPE', 'Project contains an out-of-scope issue or PR.');
      requireThat((item.kind === 'Issue' ? issueNumbers : prNumbers).has(item.number), 'INCOMPLETE', 'Project item is missing from repository coverage.');
      const key = `${item.kind}:${item.number}`;
      requireThat(!contentIds.has(key), 'DUPLICATE', 'Duplicate Project content identity.'); contentIds.add(key);
    }
  }
  requireThat(new Set(snapshot.project_items.map(i => i.id)).size === snapshot.project_items.length, 'DUPLICATE', 'Duplicate Project item ID.');
  array(snapshot.views, 'views', 100); array(snapshot.rulesets, 'rulesets', 20);
  requireThat(snapshot.views.every(v => isObject(v) && typeof v.name === 'string' && typeof v.filter === 'string'), 'SNAPSHOT', 'Invalid view metadata.');
  requireThat(snapshot.rulesets.every(r => isObject(r) && integer(r.id) && ['active', 'disabled', 'evaluate'].includes(r.enforcement) && Array.isArray(r.rules) && r.rules.every(x => typeof x === 'string') && integer(r.bypass_count, 0)), 'SNAPSHOT', 'Invalid ruleset metadata.');
  return snapshot;
}
