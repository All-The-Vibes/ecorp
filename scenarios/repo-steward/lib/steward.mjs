import { hash, integer, issueUrl, prUrl, loadPolicy, markdown, requireThat, safeData, sameRepo, validateSnapshot } from './common.mjs';

export function prose(body) {
  let fence = null;
  return body.split(/\r?\n/).filter(line => {
    const marker = line.match(/^\s*(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length && line.slice(line.indexOf(marker[1]) + marker[1].length).trim() === '') fence = null;
      return false;
    }
    return !fence && !/^\s*>/.test(line);
  }).join('\n');
}

export function textDependencies(body) {
  let inSection = false;
  const numbers = new Set();
  for (const line of prose(body).split('\n')) {
    if (/^\s*#{1,6}\s+/.test(line)) { inSection = /^\s*##\s+Dependencies\s*:?[ \t]*$/i.test(line); continue; }
    if (!inSection) continue;
    const position = line.toLowerCase().indexOf('blocked by');
    if (position < 0) continue;
    for (const match of line.slice(position + 10).matchAll(/(?<![\w/])#([1-9]\d*)\b/g)) {
      const number = Number(match[1]);
      if (integer(number)) numbers.add(number);
    }
  }
  return [...numbers].sort((a, b) => a - b);
}

export function suggestWorkstreams(issue, policy = loadPolicy()) {
  const title = issue.title.toLowerCase();
  const body = prose(issue.body).toLowerCase();
  return policy.workstreams.map(stream => {
    const titleTerms = [...new Set([...stream.terms, ...stream.aliases])].filter(term => contains(title, term));
    const bodyTerms = stream.terms.filter(term => contains(body, term));
    const oldLabel = issue.labels.find(label => stream.aliases.includes(label.toLowerCase()));
    const score = titleTerms.length * 4 + Math.min(bodyTerms.length, 2) + (oldLabel ? 4 : 0);
    const evidence = [
      ...titleTerms.map(term => `Title contains '${term}'.`),
      ...(oldLabel ? [`Existing topic label '${oldLabel}'.`] : []),
      ...bodyTerms.slice(0, 2).map(term => `Description contains '${term}'.`),
    ];
    return { id: stream.id, name: stream.name, label: `workstream:${stream.id}`, score, evidence, confidence: score >= 4 ? 'candidate' : 'low', assignment_effect: 'none' };
  }).filter(row => row.score >= 4).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, 3);
}
function contains(text, term) {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`, 'i').test(text);
}

function closuresContradict(pr) {
  const text = prose(pr.body);
  const global = /\bnon[- ]closing\b|\bno issue closure\b|\bnot a closing\b/i.test(text);
  const forbidden = new Set([...text.matchAll(/(?:do not|does not|must not|will not)\s+close\s+#(\d+)/gi)].map(m => Number(m[1])));
  return pr.closes.filter(i => sameRepo(i.repository) && (global || forbidden.has(i.number)));
}

function approvalState(pr) {
  const latest = new Map();
  for (const review of [...pr.reviews].sort((a, b) => a.submitted_at.localeCompare(b.submitted_at))) {
    if (review.author_is_bot || review.author.toLowerCase() === String(pr.author).toLowerCase()) continue;
    if (['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(review.state)) latest.set(review.author.toLowerCase(), review);
  }
  const reviews = [...latest.values()];
  return { approved: reviews.some(r => r.state === 'APPROVED' && r.commit === pr.head_sha), changes: reviews.filter(r => r.state === 'CHANGES_REQUESTED').map(r => r.author) };
}

function cycles(graph) {
  const color = new Map(), stack = [], result = [], seen = new Set();
  function visit(id) {
    color.set(id, 1); stack.push(id);
    for (const next of graph.get(id) || []) {
      if (!graph.has(next)) continue;
      if (color.get(next) === 1) {
        const cycle = stack.slice(stack.indexOf(next));
        const key = [...cycle].sort((a, b) => a - b).join(',');
        if (!seen.has(key)) { seen.add(key); result.push([...cycle, next]); }
      } else if (!color.has(next)) visit(next);
    }
    stack.pop(); color.set(id, 2);
  }
  for (const id of [...graph.keys()].sort((a, b) => a - b)) if (!color.has(id)) visit(id);
  return result;
}

export function audit(snapshot, { policy = loadPolicy(), now = new Date(), source = 'provided-snapshot' } = {}) {
  validateSnapshot(snapshot, policy);
  requireThat(['provided-snapshot', 'synthetic-fixture', 'live-github-two-pass'].includes(source), 'SOURCE', 'Invalid report source.');
  const findings = [];
  const add = (rule, severity, title, detail, refs = [], facts = {}, proposal = null) => findings.push({
    id: `F-${hash({ rule, refs: refs.map(r => `${r.kind}:${r.number}`).sort() }).slice(0, 16)}`,
    revision: hash({ rule, facts }), rule, severity, title, detail,
    references: refs.map(r => ({ ...r, url: r.kind === 'issue' ? issueUrl(r.number) : prUrl(r.number) })),
    evidence: facts, proposal: proposal ? { description: proposal, requires_approval: true, executable: false } : null,
  });
  const age = (now.getTime() - Date.parse(snapshot.captured_at)) / 60000;
  requireThat(age >= -5, 'CLOCK', 'Snapshot is unexpectedly in the future.');
  if (age > policy.max_snapshot_age_minutes) add('STALE_SNAPSHOT', 'warning', 'Snapshot is stale', 'Refresh before making decisions; this report is not a current authority check.', [], { captured_at: snapshot.captured_at });
  const issues = new Map(snapshot.issues.map(i => [i.number, i]));
  const prs = new Map(snapshot.pull_requests.map(pr => [pr.number, pr]));
  const graph = new Map(), parents = new Map();
  const knownTags = new Set(policy.workstreams.map(w => `workstream:${w.id}`));
  for (const issue of snapshot.issues) {
    const refs = [{ kind: 'issue', number: issue.number }];
    const text = textDependencies(issue.body);
    const native = issue.blocked_by.filter(d => sameRepo(d.repository)).map(d => d.number).sort((a, b) => a - b);
    graph.set(issue.number, [...new Set([...text, ...native])]);
    if (issue.parent && sameRepo(issue.parent.repository)) parents.set(issue.number, [issue.parent.number]);
    else parents.set(issue.number, []);
    if (issue.state !== 'OPEN') continue;
    const tags = issue.labels.filter(label => label.startsWith('workstream:'));
    if (!tags.length) {
      const suggestions = suggestWorkstreams(issue, policy);
      add('WORKSTREAM_UNTAGGED', 'info', `Issue #${issue.number} has no workstream tag`, 'Workstream interests are not issue assignments. Candidates require confirmation.', refs,
        { issue_revision: issue.updated_at, suggestions }, suggestions.length ? `Consider ${suggestions.map(s => s.label).join(', ')}; do not change assignees.` : 'Ask for topic clarification; do not guess an owner or workstream.');
    }
    const unknownTags = tags.filter(t => !knownTags.has(t));
    if (unknownTags.length) add('UNKNOWN_WORKSTREAM', 'warning', 'Unrecognized workstream label', 'Review the vocabulary; retain current labels until approved.', refs, { labels: unknownTags });
    if (text.join(',') !== native.join(',')) add('DEPENDENCY_MISMATCH', 'warning', `Issue #${issue.number} has inconsistent dependency representations`, 'ECorp reads explicit body dependencies; GitHub native relationships currently differ.', refs,
      { textual: text, native, issue_revision: issue.updated_at }, 'Confirm the intended blockers and reconcile through a separately approved operation.');
    for (const number of graph.get(issue.number)) if (!issues.has(number)) add('DEPENDENCY_UNRESOLVED', 'warning', `Dependency #${number} is not in this snapshot`, 'Absence does not prove completion or authorization to proceed.', [...refs, { kind: 'issue', number }], { number });
    if (issue.blocked_by.some(d => !sameRepo(d.repository))) add('DEPENDENCY_OUTSIDE_SCOPE', 'info', 'Dependency is outside the approved repository', 'The steward did not read another repository or infer its completion.', refs, { outside_scope_count: issue.blocked_by.filter(d => !sameRepo(d.repository)).length });
    if (!/^##\s+Acceptance(?: criteria)?\s*:?[ \t]*$/mi.test(prose(issue.body))) add('ACCEPTANCE_REVIEW', 'info', `Check acceptance criteria for #${issue.number}`, 'No standard acceptance heading was found. This is a format hint, not proof that the issue lacks a valid outcome.', refs, { issue_revision: issue.updated_at });
    if (issue.parent && sameRepo(issue.parent.repository)) {
      const parent = issues.get(issue.parent.number);
      if (!parent || !parent.sub_issues.some(child => sameRepo(child.repository) && child.number === issue.number)) add('PARENT_LINK_MISMATCH', 'warning', 'Parent/sub-issue readback disagrees', 'Verify both ends of the relationship before changing it.', refs, { parent: issue.parent.number });
    }
  }
  for (const cycle of cycles(graph)) add('DEPENDENCY_CYCLE', 'error', 'Dependency cycle', 'The combined native/text dependency declarations form a cycle.', [...new Set(cycle)].map(number => ({ kind: 'issue', number })), { cycle });
  for (const cycle of cycles(parents)) add('PARENT_CYCLE', 'error', 'Parent hierarchy cycle', 'A parent/sub-issue hierarchy must be acyclic.', [...new Set(cycle)].map(number => ({ kind: 'issue', number })), { cycle });

  for (const pr of snapshot.pull_requests) {
    const refs = [{ kind: 'pr', number: pr.number }];
    const conflicts = closuresContradict(pr);
    if (pr.state === 'OPEN' && conflicts.length) add('PR_CLOSURE_CONFLICT', 'error', `PR #${pr.number} has conflicting closure intent`, 'The description says not to close work, but GitHub records closing relationships. A default-branch merge could close those issues.', [...refs, ...conflicts.map(i => ({ kind: 'issue', number: i.number }))],
      { head_sha: pr.head_sha, base_ref: pr.base_ref, closing_issues: conflicts.map(i => i.number) }, 'Confirm scope with a maintainer; preserve non-closing references for partial work. Do not merge or unlink automatically.');
    if (pr.state === 'CLOSED' && pr.closes.some(i => sameRepo(i.repository) && issues.get(i.number)?.state === 'OPEN')) add('UNMERGED_PR_OPEN_ISSUE', 'info', `PR #${pr.number} closed without merging`, 'An unmerged PR closure is not issue completion. Check whether remaining work has another delivery path.', refs, { open_issues: pr.closes.filter(i => sameRepo(i.repository) && issues.get(i.number)?.state === 'OPEN').map(i => i.number) });
    if (pr.state === 'MERGED') for (const link of pr.closes.filter(i => sameRepo(i.repository))) {
      const issue = issues.get(link.number);
      if (issue?.state === 'OPEN' && issue.state_reason !== 'REOPENED') add('MERGED_PR_OPEN_ISSUE', 'info', `Merged PR #${pr.number} links to open issue #${issue.number}`, 'Review closure intent and subsequent history; an open issue can be legitimate. No automatic closure is proposed.', [...refs, { kind: 'issue', number: issue.number }], { merged_at: pr.merged_at, issue_revision: issue.updated_at });
    }
    if (pr.state !== 'OPEN') continue;
    if (!pr.closes.length && !/\b(?:related to|part of|tracked by|addresses)\s+(?:[\w.-]+\/[\w.-]+)?#\d+/i.test(prose(pr.body))) add('PR_ISSUE_LINK_REVIEW', 'info', `Review issue linkage for PR #${pr.number}`, 'No recognized closing or non-closing issue relationship was found. This hint does not authorize adding a closing link.', refs, { head_sha: pr.head_sha });
    const sourceSection = prose(pr.body).match(/^##\s+(?:Source and scope|Exact source and write scope)[^\n]*\n([\s\S]*?)(?=^##\s|(?![\s\S]))/mi)?.[1] || '';
    const statedHead = sourceSection.match(/^\s*-?\s*(?:Current )?Head:\s*`?([a-f0-9]{40,64})/mi)?.[1];
    if (statedHead && statedHead !== pr.head_sha) add('PR_STALE_HEAD_DESCRIPTION', 'warning', `PR #${pr.number} describes an older head`, 'Refresh source and validation context after reviewing the actual current commit.', refs, { stated_head: statedHead, actual_head: pr.head_sha });
    const approval = approvalState(pr);
    if (!pr.draft && !approval.approved) add('PR_REVIEW_NEEDED', 'warning', `PR #${pr.number} needs current independent review`, 'No independent human approval of this exact head was found. This is a review recommendation, not a claim that GitHub enforces a review rule.', refs, { head_sha: pr.head_sha });
    if (approval.changes.length) add('PR_CHANGES_REQUESTED', 'warning', `Changes requested on PR #${pr.number}`, 'An independent reviewer has an outstanding changes-requested decision.', refs, { reviewers: approval.changes });
    const failed = pr.checks.filter(c => ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(c.state));
    if (failed.length) add('PR_CHECK_FAILED', 'error', `PR #${pr.number} has unsuccessful checks`, 'Investigate the exact head checks; do not weaken assertions or bypass them.', refs, { head_sha: pr.head_sha, checks: failed });
    if (!pr.checks.length && !pr.draft) add('PR_CHECKS_UNVERIFIED', 'warning', `CI evidence is unavailable for PR #${pr.number}`, 'No checks were returned; missing telemetry is not a pass.', refs, { head_sha: pr.head_sha });
  }
  for (const item of snapshot.project_items.filter(i => !i.archived)) {
    if (item.kind === 'Unavailable') { add('PROJECT_CONTENT_UNAVAILABLE', 'warning', 'Project item content is unavailable', 'Do not treat hidden or deleted content as completed work.', [], { item_id: item.id }); continue; }
    if (!['Todo', 'In Progress', 'In Review', 'Done'].includes(item.status)) add('PROJECT_STATUS_REVIEW', 'info', 'Project item needs status review', 'Missing or nonstandard status requires inspection, not automatic movement.', [], { item_id: item.id, status: item.status });
    if (item.kind !== 'Issue') continue;
    const issue = issues.get(item.number), refs = [{ kind: 'issue', number: item.number }];
    if (issue.state === 'OPEN' && item.status === 'Done') add('OPEN_ISSUE_MARKED_DONE', 'warning', `Open issue #${issue.number} is marked Done`, 'Reconcile the issue and board history before moving it.', refs, { item_id: item.id, issue_revision: issue.updated_at });
    if (issue.state === 'CLOSED' && item.status !== 'Done') add('CLOSED_ISSUE_NOT_DONE', 'info', `Closed issue #${issue.number} is not marked Done`, 'Check its resolution reason and the board workflow. Closure need not mean implementation completed.', refs, { item_id: item.id, reason: issue.state_reason, status: item.status });
  }
  for (const view of snapshot.views) if (view.name === 'In Progress' && !String(view.filter || '').trim()) add('VIEW_FILTER_MISMATCH', 'info', 'In Progress view is not filtered', 'The view name suggests a status filter, but the filter is empty.', [], { name: view.name });
  for (const ruleset of snapshot.rulesets) if (ruleset.enforcement === 'active' && ruleset.rules.includes('update') && ruleset.bypass_count === 0) add('MAIN_UPDATE_LOCK', 'error', 'Default branch restricts all updates', 'An active update restriction has no bypass actors. CLI merge is not a workaround; a repository policy decision needs separate authorization.', [], { ruleset_id: ruleset.id, default_branch: snapshot.scope.default_branch });
  findings.sort((a, b) => ({ error: 0, warning: 1, info: 2 }[a.severity] - { error: 0, warning: 1, info: 2 }[b.severity]) || a.id.localeCompare(b.id));
  return safeData({ schema_version: 1, agent: policy.name, mode: 'audit-only', scope: snapshot.scope, source, captured_at: snapshot.captured_at, generated_at: now.toISOString(),
    freshness: age <= policy.max_snapshot_age_minutes ? 'within-policy-window' : 'stale', consistency: snapshot.coverage.consistency || 'provided data; not independently verified',
    summary: { issues: issues.size, open_issues: snapshot.issues.filter(i => i.state === 'OPEN').length, pull_requests: prs.size, project_items: snapshot.project_items.length,
      unassigned_open_issues: snapshot.issues.filter(i => i.state === 'OPEN' && !i.assignees.length).length, unassigned_is_violation: false,
      errors: findings.filter(f => f.severity === 'error').length, warnings: findings.filter(f => f.severity === 'warning').length, informational: findings.filter(f => f.severity === 'info').length },
    findings, executed_actions: [], github_mutations: 0, assignment_changes: 0, completion_claim: 'Audit only; no issue completion, accepted ECorp outcome, deployment, or permission grant.' });
}

export function renderReport(report) {
  const rows = [`# ${markdown(report.agent)}`, '', `Mode: **audit-only**. Source: ${markdown(report.source)}. Snapshot: ${markdown(report.captured_at)}.`, '',
    `${report.summary.issues} issues; ${report.summary.pull_requests} PRs; ${report.summary.errors} errors, ${report.summary.warnings} warnings, ${report.summary.informational} informational findings.`, '',
    'Unassigned issues are informational; workstream interests never assign people. No GitHub changes were made.', ''];
  for (const finding of report.findings) {
    rows.push(`## ${markdown(finding.severity.toUpperCase())}: ${markdown(finding.title)}`, '', markdown(finding.detail), '', `Rule: ${finding.rule}; finding: ${finding.id}.`);
    if (finding.references.length) rows.push('', finding.references.map(r => `[${r.kind === 'pr' ? 'PR' : 'Issue'} #${r.number}](${r.url})`).join(' · '));
    if (finding.proposal) rows.push('', `Proposal only: ${markdown(finding.proposal.description)}`);
    rows.push('');
  }
  return rows.join('\n');
}

export function createSteward(snapshot, options = {}) {
  const report = audit(snapshot, options), policy = options.policy || loadPolicy();
  const prefix = `Snapshot ${snapshot.captured_at} (${report.freshness}; ${report.source}). `;
  const answer = (text, references = [], extra = {}) => safeData({ agent: policy.name, mode: 'audit-only', text: prefix + text, references, executed_actions: [], ...extra });
  const ref = (kind, number) => ({ kind, number, url: kind === 'issue' ? issueUrl(number) : prUrl(number) });
  return Object.freeze({
    report,
    ask(question) {
      requireThat(typeof question === 'string' && question.length > 0 && question.length <= 2000, 'QUESTION', 'A question must contain 1-2000 characters.');
      const q = question.trim();
      if (/^(?:(?:can|could|would|will) you\s+)?(?:please\s+)?(?:assign|reassign|tag|label|close|reopen|merge|delete|remove|edit|change|enable|disable|deploy|start|apply|approve|grant)\b/i.test(q)) return answer('I cannot make that change. I can inspect the current evidence and propose a correction for approval.', [], { refused: true });
      const number = Number(q.match(/(?:#|\b(?:issue|pr|pull request)\s+#?)([1-9]\d*)\b/i)?.[1]);
      if (number && /blocked by|depend(?:s|ent)? on/i.test(q)) {
        const dependents = snapshot.issues.filter(i => textDependencies(i.body).includes(number) || i.blocked_by.some(d => sameRepo(d.repository) && d.number === number));
        return answer(dependents.length ? `Issues depending on #${number}: ${dependents.map(i => `#${i.number} ${i.title}`).join('; ')}.` : `No in-scope dependency on #${number} is recorded in this snapshot.`, dependents.map(i => ref('issue', i.number)));
      }
      if (number) {
        const preferPr = /\b(?:pr|pull request)\s*#?\d+/i.test(q);
        const entity = preferPr ? snapshot.pull_requests.find(i => i.number === number) : snapshot.issues.find(i => i.number === number) || snapshot.pull_requests.find(i => i.number === number);
        if (!entity) return answer(`#${number} is not available in this approved snapshot. I will not infer that it does not exist.`, [], { unknown: true });
        const kind = Object.hasOwn(entity, 'head_sha') ? 'pr' : 'issue';
        const findings = report.findings.filter(f => f.references.some(r => r.kind === kind && r.number === number));
        let detail = `${kind === 'pr' ? 'PR' : 'Issue'} #${number}: ${entity.title}. State: ${entity.state}. `;
        if (kind === 'issue') {
          detail += `GitHub assignees: ${entity.assignees.length ? entity.assignees.join(', ') : 'none recorded; no assignment is inferred'}. `;
          const deps = [...new Set([...textDependencies(entity.body), ...entity.blocked_by.filter(d => sameRepo(d.repository)).map(d => d.number)])];
          detail += `Declared blockers: ${deps.length ? deps.map(n => `#${n} (${snapshot.issues.find(i => i.number === n)?.state || 'unverified'})`).join(', ') : 'none recorded'}. `;
          detail += `Workstream candidates (not applied): ${suggestWorkstreams(entity, policy).map(w => w.name).join(', ') || 'needs clarification'}. `;
        } else detail += `Head: ${entity.head_sha}. Base: ${entity.base_ref}. Draft: ${entity.draft}. Closing links: ${entity.closes.map(i => `${i.repository}#${i.number}`).join(', ') || 'none'}. `;
        detail += findings.length ? `Findings: ${findings.map(f => `${f.rule}: ${f.detail}`).join(' ')}` : 'No configured rule flagged this item; that is not a completion or merge authorization.';
        return answer(detail, [ref(kind, number)], { findings: findings.map(f => f.id) });
      }
      const stream = policy.workstreams.find(w => [w.name, w.id, ...w.aliases].some(term => contains(q.toLowerCase(), term.toLowerCase())));
      if (stream) {
        const matches = snapshot.issues.filter(i => i.state === 'OPEN' && (i.labels.includes(`workstream:${stream.id}`) || suggestWorkstreams(i, policy).some(w => w.id === stream.id)));
        return answer(`${stream.name}: ${matches.length} open tagged or candidate issues. Candidates are topic suggestions, not assignments. ${matches.map(i => `#${i.number} ${i.title}`).join('; ')}`, matches.map(i => ref('issue', i.number)));
      }
      if (/workstreams|categories|topics/i.test(q)) return answer(`Workstreams: ${policy.workstreams.map(w => w.name).join('; ')}. These do not assign people.`);
      if (/audit|health|status|summary|wrong|problems|findings|blockers|blocked/i.test(q)) {
        const selected = report.findings.filter(f => f.severity !== 'info').slice(0, 8);
        return answer(`${report.summary.open_issues} open issues. ${report.summary.errors} errors and ${report.summary.warnings} warnings. ${selected.map(f => `${f.title}: ${f.detail}`).join(' ') || 'No configured rule found an error or warning.'}`, selected.flatMap(f => f.references), { finding_ids: selected.map(f => f.id) });
      }
      return answer('I can explain an issue or PR number, list a workstream, show recorded blockers, or summarize the audit. Which item or topic should I inspect?', [], { clarification_needed: true });
    },
  });
}
