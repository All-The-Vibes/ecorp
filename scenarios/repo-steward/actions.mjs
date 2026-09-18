import { closeSync, constants, fstatSync, lstatSync, openSync, realpathSync, writeSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { collectSnapshot } from './lib/github.mjs';
import { audit } from './lib/steward.mjs';
import { fixtureSnapshot } from './fixtures/demo.mjs';
import { integer, issueUrl, prUrl, requireThat, SCOPE, StewardError, validTime } from './lib/common.mjs';

// Publication allowlist, not a second audit engine. New rules need an explicit
// output review before their names or references can enter a public job summary.
export const PUBLIC_RULES = Object.freeze([
  'STALE_SNAPSHOT', 'WORKSTREAM_UNTAGGED', 'UNKNOWN_WORKSTREAM',
  'DEPENDENCY_MISMATCH', 'DEPENDENCY_UNRESOLVED', 'DEPENDENCY_OUTSIDE_SCOPE',
  'ACCEPTANCE_REVIEW', 'PARENT_LINK_MISMATCH', 'DEPENDENCY_CYCLE', 'PARENT_CYCLE',
  'PR_CLOSURE_CONFLICT', 'UNMERGED_PR_OPEN_ISSUE', 'MERGED_PR_OPEN_ISSUE',
  'PR_ISSUE_LINK_REVIEW', 'PR_STALE_HEAD_DESCRIPTION', 'PR_REVIEW_NEEDED',
  'PR_CHANGES_REQUESTED', 'PR_CHECK_FAILED', 'PR_CHECKS_UNVERIFIED',
  'PROJECT_CONTENT_UNAVAILABLE', 'PROJECT_STATUS_REVIEW',
  'OPEN_ISSUE_MARKED_DONE', 'CLOSED_ISSUE_NOT_DONE', 'VIEW_FILTER_MISMATCH',
  'MAIN_UPDATE_LOCK',
]);
const approvedRules = new Set(PUBLIC_RULES);
const MODES = new Set(['--dry-run', '--fixture', '--live']);

export function parseActionArgs(args) {
  requireThat(args.length <= 1 && (!args.length || MODES.has(args[0])), 'ACTION_ARGUMENT', 'Use --dry-run, --fixture, or --live.');
  return args[0] || '--dry-run';
}

export function assertLiveContext(env) {
  requireThat(env.GITHUB_ACTIONS === 'true' && env.GITHUB_EVENT_NAME === 'workflow_dispatch', 'ACTION_EVENT', 'Live hosted audits require an explicit workflow_dispatch.');
  requireThat(env.GITHUB_REPOSITORY === SCOPE.repository && env.GITHUB_REF === 'refs/heads/main', 'ACTION_SCOPE', 'Live hosted audits require the approved repository main branch.');
  requireThat(env.GITHUB_ACTOR === SCOPE.collector_login && env.GITHUB_TRIGGERING_ACTOR === SCOPE.collector_login, 'ACTION_ACTOR', 'Only the approved Bakar404 operator may start or rerun this pilot.');
  requireThat(/^[a-f0-9]{40,64}$/.test(env.GITHUB_SHA || ''), 'ACTION_COMMIT', 'The workflow source commit is required.');
  requireThat(env.ECORP_STEWARD_ACTIONS_ENABLED === 'true', 'ACTION_NOT_ENABLED', 'The protected environment has not enabled hosted live audits.');
  requireThat(env.ECORP_STEWARD_PUBLIC_SUMMARY === 'true', 'ACTION_PUBLICATION', 'Approve the limited PUBLIC job summary before requesting live data.');
  requireThat(typeof env.GH_TOKEN === 'string' && env.GH_TOKEN.trim().length > 0, 'ACTION_CREDENTIAL', 'An approved Project-readable Bakar404 credential is required. GITHUB_TOKEN is not a substitute.');
  requireThat(env.ECORP_STEWARD_ALLOW_WRITES === undefined || env.ECORP_STEWARD_ALLOW_WRITES === 'false', 'ACTION_READ_ONLY', 'The hosted steward remains audit-only.');
}

export function renderActionSummary(report) {
  requireThat(report?.mode === 'audit-only' && report.github_mutations === 0 && report.assignment_changes === 0 && Array.isArray(report.executed_actions) && report.executed_actions.length === 0, 'ACTION_REPORT', 'Only a zero-mutation audit can produce a summary.');
  requireThat(report.scope?.repository === SCOPE.repository && report.scope.project_id === SCOPE.project_id && report.scope.ecorp_execution_authority === 'none', 'ACTION_REPORT_SCOPE', 'Report scope does not match the approved pilot.');
  requireThat(['synthetic-fixture', 'live-github-two-pass'].includes(report.source) && validTime(report.captured_at), 'ACTION_REPORT_SOURCE', 'A verified source and snapshot time are required.');
  requireThat(/^[a-f0-9]{40,64}$/.test(report.scope.source_commit || ''), 'ACTION_REPORT_SOURCE', 'The repository source commit is required.');
  const counts = report.summary;
  for (const key of ['issues', 'pull_requests', 'project_items', 'errors', 'warnings', 'informational']) {
    requireThat(integer(counts?.[key], 0), 'ACTION_REPORT_COUNTS', 'Invalid summary count.');
  }
  requireThat(Array.isArray(report.findings) && report.findings.length <= 30000, 'ACTION_REPORT_BOUND', 'Finding count exceeds the public-summary bound.');
  for (const finding of report.findings) {
    requireThat(approvedRules.has(finding.rule) && ['error', 'warning', 'info'].includes(finding.severity) && /^F-[a-f0-9]{16}$/.test(finding.id), 'ACTION_REPORT_RULE', 'An unreviewed rule or identifier cannot be published.');
    requireThat(Array.isArray(finding.references) && finding.references.length <= 1000, 'ACTION_REPORT_REFERENCES', 'Invalid finding references.');
    for (const reference of finding.references) {
      requireThat(['issue', 'pr'].includes(reference.kind) && integer(reference.number), 'ACTION_REPORT_REFERENCES', 'Invalid reference identity.');
      const canonical = reference.kind === 'issue' ? issueUrl(reference.number) : prUrl(reference.number);
      requireThat(reference.url === canonical, 'ACTION_REPORT_REFERENCES', 'Only canonical in-scope repository links can be published.');
    }
  }
  const total = counts.errors + counts.warnings + counts.informational;
  requireThat(total === report.findings.length, 'ACTION_REPORT_COUNTS', 'Finding totals do not match.');
  const lines = [
    '# ECorp Repo Steward',
    '',
    report.source === 'synthetic-fixture' ? '**Synthetic fixture - not a live repository result.**' : '**Live, read-only GitHub audit.**',
    '',
    'Repository: https://github.com/' + SCOPE.repository,
    'Snapshot: ' + new Date(report.captured_at).toISOString(),
    'Repository source commit: ' + report.scope.source_commit,
    '',
    counts.issues + ' issues; ' + counts.pull_requests + ' PRs; ' + counts.project_items + ' Project items.',
    counts.errors + ' errors; ' + counts.warnings + ' warnings; ' + counts.informational + ' informational findings.',
    '',
    'No issue, label, assignment, Project, PR or ruleset changes were made. These findings do not authorize closure or merge.',
    'Unassigned issues are informational, not automatically violations.',
    '',
    'This limited index excludes titles, bodies, assignee names, evidence payloads, proposals and raw snapshots.',
    'Finding codes and references may still reveal board-derived information; live publication requires explicit approval.',
    '',
    '| Severity | Rule | Finding | Repository references |',
    '| --- | --- | --- | --- |',
  ];
  for (const finding of report.findings.slice(0, 50)) {
    const links = finding.references.slice(0, 4).map(reference => '[' + (reference.kind === 'pr' ? 'PR' : 'Issue') + ' #' + reference.number + '](' + reference.url + ')');
    if (finding.references.length > 4) links.push('Additional references withheld');
    lines.push('| ' + finding.severity + ' | ' + finding.rule + ' | ' + finding.id + ' | ' + (links.join(' / ') || 'Repository or board check') + ' |');
  }
  lines.push('', 'Showing ' + Math.min(report.findings.length, 50) + ' of ' + report.findings.length + ' findings. Use the local steward for detailed inspection.', '');
  const summary = lines.join('\n');
  requireThat(Buffer.byteLength(summary) <= 65536, 'ACTION_REPORT_BOUND', 'Public summary exceeds its byte bound.');
  return summary;
}

export async function runAction(args = [], { env = process.env, collect = collectSnapshot, now = () => new Date() } = {}) {
  const mode = parseActionArgs(args);
  if (env.GITHUB_ACTIONS === 'true' && env.ECORP_STEWARD_REQUESTED_MODE !== undefined) {
    requireThat(['preview', 'fixture', 'live'].includes(env.ECORP_STEWARD_REQUESTED_MODE), 'ACTION_ARGUMENT', 'Invalid workflow mode.');
  }
  if (mode === '--dry-run') return {
    result: { mode: 'preview', dry_run: true, repository: SCOPE.repository, project: SCOPE.project_owner + '/' + SCOPE.project_number, collector_login: SCOPE.collector_login, live_reads: false, summary_written: false, github_mutations: 0, teams_access: false },
    summary: null,
  };
  if (mode === '--live') assertLiveContext(env);
  const snapshot = mode === '--live' ? await collect() : fixtureSnapshot(now());
  const report = audit(snapshot, { now: now(), source: mode === '--live' ? 'live-github-two-pass' : 'synthetic-fixture' });
  requireThat(report.freshness === 'within-policy-window', 'ACTION_STALE', 'Collect a fresh snapshot before producing a hosted result.');
  const summary = renderActionSummary(report);
  return {
    result: { mode: mode === '--live' ? 'live-audit' : 'synthetic-fixture', captured_at: report.captured_at, issues: report.summary.issues, pull_requests: report.summary.pull_requests, errors: report.summary.errors, warnings: report.summary.warnings, informational: report.summary.informational, github_mutations: 0, teams_access: false, raw_snapshot_published: false },
    summary,
  };
}

export function appendActionSummary(summary, env = process.env) {
  requireThat(env.GITHUB_ACTIONS === 'true' && typeof summary === 'string' && Buffer.byteLength(summary) <= 65536, 'ACTION_SUMMARY', 'A bounded Actions job summary is required.');
  requireThat(path.isAbsolute(env.RUNNER_TEMP || '') && path.isAbsolute(env.GITHUB_STEP_SUMMARY || ''), 'ACTION_SUMMARY_PATH', 'Native Actions summary paths are required.');
  const temp = realpathSync(env.RUNNER_TEMP);
  const stat = lstatSync(env.GITHUB_STEP_SUMMARY);
  requireThat(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, 'ACTION_SUMMARY_PATH', 'The summary destination must be a regular, unlinked native file.');
  const target = realpathSync(env.GITHUB_STEP_SUMMARY), relative = path.relative(temp, target);
  requireThat(relative !== '' && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep), 'ACTION_SUMMARY_PATH', 'The job summary must stay inside RUNNER_TEMP.');
  // Do not create or truncate a replaced destination. Check the opened file
  // before appending through that retained handle.
  const fd = openSync(target, constants.O_WRONLY | constants.O_APPEND);
  try {
    const opened = fstatSync(fd);
    requireThat(opened.isFile() && opened.nlink === 1 && opened.dev === stat.dev && opened.ino === stat.ino, 'ACTION_SUMMARY_PATH', 'The native summary file changed before opening.');
    writeSync(fd, summary, null, 'utf8');
  } finally { closeSync(fd); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runAction(process.argv.slice(2)).then(({ result, summary }) => {
    if (summary && process.env.GITHUB_ACTIONS === 'true') {
      appendActionSummary(summary);
      result.summary_written = true;
    }
    process.stdout.write(JSON.stringify(result) + '\n');
  }).catch(error => {
    const code = error instanceof StewardError && /^[A-Z_]{1,64}$/.test(error.code) ? error.code : 'ACTION_FAILED';
    // Never publish raw API responses, subprocess stderr, credentials or stack traces.
    process.stderr.write(JSON.stringify({ error: code, message: 'Steward audit stopped. No GitHub mutation was attempted; private diagnostic content is withheld.' }) + '\n');
    process.exitCode = 1;
  });
}
