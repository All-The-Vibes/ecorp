import { execFile } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { hash, integer, loadPolicy, requireThat, ROOT, safeData, sameRepo, SCOPE, StewardError, validateSnapshot } from './common.mjs';
import { collectorPolicy } from './collector-profile.mjs';

const execute = promisify(execFile);
const page = 'totalCount pageInfo { hasNextPage endCursor }';
const repoIdentity = 'id nameWithOwner defaultBranchRef { name target { oid } }';
const limits = 'rateLimit { remaining resetAt }';
const queries = Object.freeze({
  project: `query($owner:String!,$number:Int!,$cursor:String) { organization(login:$owner) { projectV2(number:$number) { id number title url updatedAt views(first:100) { ${page} nodes { name filter } } items(first:50,after:$cursor) { ${page} nodes { id isArchived fieldValueByName(name:"Status") { ... on ProjectV2ItemFieldSingleSelectValue { name } } content { __typename ... on Issue { number repository { nameWithOwner } } ... on PullRequest { number repository { nameWithOwner } } ... on DraftIssue { title } } } } } } ${limits} }`,
  issues: `query($owner:String!,$name:String!,$cursor:String) { repository(owner:$owner,name:$name) { ${repoIdentity} issues(first:50,after:$cursor,orderBy:{field:CREATED_AT,direction:ASC}) { ${page} nodes { number title body url state stateReason updatedAt closedAt labels(first:100) { ${page} nodes { name } } assignees(first:100) { ${page} nodes { login } } blockedBy(first:100) { ${page} nodes { number repository { nameWithOwner } } } parent { number repository { nameWithOwner } } subIssues(first:100) { ${page} nodes { number repository { nameWithOwner } } } } } } ${limits} }`,
  prs: `query($owner:String!,$name:String!,$cursor:String) { repository(owner:$owner,name:$name) { ${repoIdentity} pullRequests(first:50,after:$cursor,orderBy:{field:CREATED_AT,direction:ASC}) { ${page} nodes { number title body url updatedAt state isDraft baseRefName headRefOid mergedAt author { login } closingIssuesReferences(first:100) { ${page} nodes { number repository { nameWithOwner } } } reviews(first:100) { ${page} nodes { state submittedAt author { login __typename } commit { oid } } } commits(last:1) { nodes { commit { oid statusCheckRollup { contexts(first:100) { ${page} nodes { __typename ... on CheckRun { name status conclusion } ... on StatusContext { context state } } } } } } } } } } ${limits} }`,
});

export function nativeGhPath() {
  const basename = process.platform === 'win32' ? 'gh.exe' : 'gh';
  const checkout = path.resolve(fileURLToPath(ROOT), '../..');
  const candidates = process.platform === 'win32'
    ? [path.join(process.env.ProgramFiles || 'C:\\Program Files', 'GitHub CLI', basename)]
    : ['/usr/bin/gh', '/usr/local/bin/gh', '/opt/homebrew/bin/gh'];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const real = realpathSync(candidate);
    const relative = path.relative(checkout, real);
    requireThat(relative.startsWith('..') || path.isAbsolute(relative), 'GH_PATH', 'GitHub CLI must not resolve inside the contribution checkout.');
    requireThat(statSync(real).isFile(), 'GH_PATH', 'GitHub CLI must be a regular installed executable.');
    return real;
  }
  throw new StewardError('GH_MISSING', 'Install GitHub CLI in a supported native installation location. No software was installed.');
}

// Only these fixed queries and GET routes exist. No caller supplies shell text,
// arbitrary URLs, GraphQL source, extra flags, or a write operation.
export function createGithubReader({ policy = loadPolicy(), collectorProfile = null, run, clock = () => Date.now() } = {}) {
  policy = collectorPolicy(collectorProfile, policy);
  const started = clock();
  let requests = 0, bytes = 0, reserve = Infinity;
  const invoke = run || (async args => {
    const env = { ...process.env, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0', NO_COLOR: '1' };
    for (const key of ['GH_DEBUG', 'DEBUG', 'GH_PAGER', 'PAGER', 'GH_FORCE_TTY']) delete env[key];
    try {
      const result = await execute(nativeGhPath(), args, { windowsHide: true, timeout: policy.limits.request_timeout_ms, maxBuffer: 4194304, env });
      return result.stdout;
    } catch { throw new StewardError('GITHUB_READ_FAILED', 'GitHub read failed, timed out, or was denied. No write or credential change was attempted.'); }
  });
  async function request(args, graphql = false) {
    requireThat(++requests <= 150 && clock() - started < policy.limits.collection_timeout_ms, 'READ_BUDGET', 'Collection request/time bound exceeded.');
    requireThat(!graphql || reserve >= policy.limits.graphql_reserve, 'RATE_LIMIT', 'GraphQL reserve reached; wait for GitHub to reset rather than switching accounts.');
    const text = await invoke(['api', '--hostname', 'github.com', ...args]);
    requireThat(typeof text === 'string', 'GITHUB_RESPONSE', 'GitHub returned a non-text response.');
    bytes += Buffer.byteLength(text);
    requireThat(bytes <= policy.limits.max_bytes, 'INPUT_BOUND', 'Collection response byte bound exceeded.');
    let value;
    try { value = JSON.parse(text); } catch { throw new StewardError('GITHUB_RESPONSE', 'GitHub returned invalid JSON; raw output is withheld.'); }
    requireThat(!value.errors?.length, 'GITHUB_GRAPHQL', 'GraphQL reported errors; partial results are not accepted.');
    if (graphql) {
      requireThat(integer(value.data?.rateLimit?.remaining, 0) && typeof value.data.rateLimit.resetAt === 'string', 'RATE_LIMIT', 'GraphQL quota metadata is unavailable.');
      reserve = value.data.rateLimit.remaining;
    }
    return value;
  }
  return Object.freeze({
    async account() { const data = await request(['--method', 'GET', 'user']); requireThat(data.login === policy.collector_login, 'ACCOUNT', 'The active GitHub identity differs from the selected read-only collector. No account was switched.'); return data.login; },
    async graphql(kind, cursor = null) {
      requireThat(Object.hasOwn(queries, kind), 'READ_ONLY', 'Unsupported operation; this reader contains no write tools.');
      requireThat(cursor === null || typeof cursor === 'string' && cursor.length <= 2048 && !/[\r\n\u0000]/.test(cursor), 'CURSOR', 'Invalid pagination cursor.');
      const args = ['graphql', '-f', `query=${queries[kind]}`, '-f', `owner=${SCOPE.project_owner}`];
      if (kind === 'project') args.push('-F', `number=${SCOPE.project_number}`); else args.push('-f', 'name=ecorp');
      if (cursor !== null) args.push('-f', `cursor=${cursor}`);
      return (await request(args, true)).data;
    },
    async branchRules(branch) {
      requireThat(typeof branch === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/.test(branch), 'SCOPE', 'Invalid default branch.');
      return request(['--method', 'GET', `repos/${SCOPE.repository}/rules/branches/${encodeURIComponent(branch)}`]);
    },
    async ruleset(id) { requireThat(integer(id), 'RULESET', 'Invalid ruleset identity.'); return request(['--method', 'GET', `repos/${SCOPE.repository}/rulesets/${id}`]); },
    metrics() { return { requests, response_bytes: bytes, writes: 0 }; },
  });
}

export function completeConnection(connection, name) {
  requireThat(connection && Array.isArray(connection.nodes) && integer(connection.totalCount, 0) && connection.pageInfo && typeof connection.pageInfo.hasNextPage === 'boolean', 'PAGINATION', `Missing ${name} connection metadata.`);
  requireThat(!connection.pageInfo.hasNextPage && connection.totalCount === connection.nodes.length && connection.nodes.every(Boolean), 'INCOMPLETE', `Incomplete ${name} connection; no truncation is accepted.`);
  return connection.nodes;
}
const relation = row => ({ number: row.number, repository: row.repository.nameWithOwner });

async function readPass(reader, policy) {
  const rows = { project: [], issues: [], prs: [] };
  let projectMeta, repoMeta;
  for (const kind of ['project', 'issues', 'prs']) {
    let cursor = null, total = null, pages = 0;
    const seen = new Set();
    while (true) {
      requireThat(++pages <= policy.limits.max_pages, 'PAGINATION', 'Page limit exceeded.');
      const data = await reader.graphql(kind, cursor);
      const parent = kind === 'project' ? data.organization?.projectV2 : data.repository;
      requireThat(parent, 'SCOPE', 'Authorized Project or repository is unavailable.');
      if (kind === 'project') {
        requireThat(parent.id === SCOPE.project_id && parent.number === SCOPE.project_number, 'SCOPE', 'Project identity mismatch.');
        const current = { id: parent.id, title: parent.title, url: parent.url, updated_at: parent.updatedAt, views: completeConnection(parent.views, 'Project views') };
        requireThat(!projectMeta || hash(projectMeta) === hash(current), 'DRIFT', 'Project changed during pagination.'); projectMeta = current;
      } else {
        requireThat(sameRepo(parent.nameWithOwner) && parent.id === SCOPE.repository_id && parent.defaultBranchRef?.target?.oid, 'SCOPE', 'Repository identity or default branch is unavailable.');
        const current = { id: parent.id, name: parent.nameWithOwner, branch: parent.defaultBranchRef.name, sha: parent.defaultBranchRef.target.oid };
        requireThat(!repoMeta || hash(repoMeta) === hash(current), 'DRIFT', 'Repository default branch changed during collection.'); repoMeta = current;
      }
      const connection = kind === 'project' ? parent.items : kind === 'issues' ? parent.issues : parent.pullRequests;
      requireThat(connection && integer(connection.totalCount, 0, policy.limits.max_records) && Array.isArray(connection.nodes) && connection.pageInfo && typeof connection.pageInfo.hasNextPage === 'boolean', 'PAGINATION', 'Invalid top-level connection.');
      requireThat(total === null || total === connection.totalCount, 'DRIFT', 'Record count changed during pagination.'); total = connection.totalCount;
      requireThat(connection.nodes.every(Boolean), 'INCOMPLETE', 'Null record in paginated collection.');
      rows[kind].push(...connection.nodes);
      requireThat(rows[kind].length <= total, 'PAGINATION', 'Pagination returned too many records.');
      if (!connection.pageInfo.hasNextPage) { requireThat(rows[kind].length === total, 'INCOMPLETE', 'Pagination ended before the declared count.'); break; }
      const next = connection.pageInfo.endCursor;
      requireThat(typeof next === 'string' && next.length > 0 && !seen.has(next) && connection.nodes.length > 0, 'PAGINATION', 'Missing, repeated, or empty pagination advance.');
      seen.add(next); cursor = next;
    }
  }
  const issues = rows.issues.map(i => ({ number: i.number, repository: SCOPE.repository, title: i.title, body: i.body, url: i.url, state: i.state, state_reason: i.stateReason, updated_at: i.updatedAt, closed_at: i.closedAt,
    labels: completeConnection(i.labels, 'labels').map(l => l.name).sort(), assignees: completeConnection(i.assignees, 'assignees').map(a => a.login).sort(),
    blocked_by: completeConnection(i.blockedBy, 'dependencies').map(relation).sort((a, b) => a.number - b.number), parent: i.parent ? relation(i.parent) : null,
    sub_issues: completeConnection(i.subIssues, 'sub-issues').map(relation).sort((a, b) => a.number - b.number) }));
  const pull_requests = rows.prs.map(pr => {
    const commit = pr.commits?.nodes?.[0]?.commit;
    requireThat(commit?.oid === pr.headRefOid, 'DRIFT', 'PR checks do not belong to its current head.');
    return { number: pr.number, repository: SCOPE.repository, title: pr.title, body: pr.body, url: pr.url, updated_at: pr.updatedAt, state: pr.state, draft: pr.isDraft, base_ref: pr.baseRefName, head_sha: pr.headRefOid, merged_at: pr.mergedAt, author: pr.author?.login || 'unknown',
      closes: completeConnection(pr.closingIssuesReferences, 'closing issues').map(relation),
      reviews: completeConnection(pr.reviews, 'reviews').filter(r => r.submittedAt).map(r => ({ author: r.author?.login || 'unknown', author_is_bot: r.author?.__typename !== 'User', state: r.state, submitted_at: r.submittedAt, commit: r.commit?.oid || null })),
      checks: commit.statusCheckRollup ? completeConnection(commit.statusCheckRollup.contexts, 'checks').map(c => ({ name: c.name || c.context, state: c.__typename === 'CheckRun' ? c.conclusion || c.status : c.state })) : [] };
  });
  const project_items = rows.project.map(item => ({ id: item.id, archived: item.isArchived, status: item.fieldValueByName?.name || null, kind: item.content?.__typename || 'Unavailable', number: item.content?.number || null, repository: item.content?.repository?.nameWithOwner || null }));
  const branchRules = await reader.branchRules(repoMeta.branch);
  requireThat(Array.isArray(branchRules), 'RULESET', 'Default-branch rules are unavailable.');
  const ids = [...new Set(branchRules.map(r => r.ruleset_id))];
  requireThat(ids.length <= 20, 'INPUT_BOUND', 'Too many rulesets for a bounded audit.');
  const rulesets = [];
  for (const id of ids) {
    requireThat(branchRules.filter(r => r.ruleset_id === id).every(r => r.ruleset_source_type === 'Repository' && sameRepo(r.ruleset_source)), 'SCOPE', 'Inherited or external rules require a separately scoped audit.');
    const rule = await reader.ruleset(id);
    requireThat(rule.id === id && sameRepo(rule.source) && Array.isArray(rule.rules) && Array.isArray(rule.bypass_actors), 'RULESET', 'Ruleset identity or bypass data is incomplete.');
    rulesets.push({ id, enforcement: rule.enforcement, rules: rule.rules.map(r => r.type).sort(), bypass_count: rule.bypass_actors.length });
  }
  return { scope: { repository: SCOPE.repository, repository_id: repoMeta.id, project_owner: SCOPE.project_owner, project_number: SCOPE.project_number, project_id: SCOPE.project_id, default_branch: repoMeta.branch, source_commit: repoMeta.sha, ecorp_execution_authority: 'none' },
    issues: issues.sort((a, b) => a.number - b.number), pull_requests: pull_requests.sort((a, b) => a.number - b.number), project_items: project_items.sort((a, b) => a.id.localeCompare(b.id)), views: projectMeta.views, rulesets: rulesets.sort((a, b) => a.id - b.id), project_revision: projectMeta.updated_at };
}

export async function collectSnapshot({ reader, policy = loadPolicy(), collectorProfile = null, now = () => new Date() } = {}) {
  policy = collectorPolicy(collectorProfile, policy);
  reader ??= createGithubReader({ policy, collectorProfile });
  const login = await reader.account();
  requireThat(login === policy.collector_login, 'ACCOUNT', 'The read-only collector identity differs from its selected profile.');
  const first = await readPass(reader, policy);
  const second = await readPass(reader, policy);
  requireThat(await reader.account() === login, 'ACCOUNT', 'The read-only collector identity changed during collection.');
  collectorPolicy(collectorProfile); // Recheck profile bytes before accepting the observation.
  requireThat(hash(first) === hash(second), 'DRIFT', 'The board changed between collection passes. Retry later; no mixed snapshot was accepted.');
  const snapshot = safeData({ schema_version: 1, ...second, captured_at: now().toISOString(), coverage: { complete: true, issues: second.issues.length, pull_requests: second.pull_requests.length, project_items: second.project_items.length, consistency: 'two matching bounded reads; not an atomic GitHub transaction' }, collection: { ...reader.metrics(), authenticated_login: login, ...(policy.collector_profile_sha256 ? { collector_profile_sha256: policy.collector_profile_sha256 } : {}) } });
  validateSnapshot(snapshot, policy);
  return snapshot;
}
