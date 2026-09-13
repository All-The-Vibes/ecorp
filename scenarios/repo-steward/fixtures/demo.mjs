import { issueUrl, prUrl, SCOPE } from '../lib/common.mjs';

export function fixtureIssue(number, title, extras = {}) {
  return { number, title, body: '## Acceptance criteria\n\n- [ ] Verify the scoped outcome.\n', url: issueUrl(number), repository: SCOPE.repository,
    state: 'OPEN', state_reason: null, updated_at: '2026-09-12T20:00:00Z', closed_at: null,
    labels: [], assignees: [], blocked_by: [], sub_issues: [], parent: null, ...extras };
}
export function fixturePr(number, extras = {}) {
  return { number, title: 'Synthetic contribution', body: 'Related to #50.', url: prUrl(number), repository: SCOPE.repository,
    updated_at: '2026-09-12T20:00:00Z', state: 'OPEN', draft: false, author: 'fixture-author', base_ref: 'main', head_sha: 'b'.repeat(40),
    closes: [], reviews: [], checks: [{ name: 'fixture-check', state: 'SUCCESS' }], merged_at: null, ...extras };
}
export function fixtureSnapshot(now = new Date()) {
  const issues = [
    fixtureIssue(50, 'Budget revision and recovery', { state_reason: 'REOPENED', assignees: ['fixture-owner'] }),
    fixtureIssue(236, 'Audited budget extensions', { body: '## Outcome\nBounded budget extensions.\n\n## Acceptance criteria\n- [ ] Independent audit.\n\n## Dependencies\nBlocked by #50.' }),
    fixtureIssue(27, 'Multiplayer collaboration'),
    fixtureIssue(141, 'Improve accessibility and operations UI'),
    fixtureIssue(161, 'Shared claim authority for multi-system execution'),
    fixtureIssue(140, 'Suppress verifier caches during cleanup'),
    fixtureIssue(48, 'Mission-scoped dynamic staffing'),
    fixtureIssue(301, 'Branch protection and CI workflow governance'),
    fixtureIssue(138, 'Tenant-safe authorization and security'),
    fixtureIssue(300, 'Agent-to-agent message routing'),
    fixtureIssue(63, 'Governed dark factory automation'),
    fixtureIssue(172, 'Backend scalability and pub-sub backpressure'),
  ];
  const pull_requests = [fixturePr(237, {
    body: `Related to #50. This is a non-closing test contribution.\n\n## Source and scope\n- Head: \`${'a'.repeat(40)}\`.\n\n## Evidence\nSynthetic fixture only.`,
    closes: [{ repository: SCOPE.repository, number: 50 }],
  })];
  const project_items = issues.map(i => ({ id: `fixture-item-${i.number}`, kind: 'Issue', number: i.number, repository: SCOPE.repository, status: i.number === 50 ? 'In Progress' : 'Todo', archived: false }));
  return { schema_version: 1, scope: { repository: SCOPE.repository, repository_id: SCOPE.repository_id, project_owner: SCOPE.project_owner, project_number: SCOPE.project_number, project_id: SCOPE.project_id, default_branch: 'main', source_commit: 'a'.repeat(40), ecorp_execution_authority: 'none' },
    captured_at: now.toISOString(), issues, pull_requests, project_items,
    views: [{ name: 'In Progress', filter: '' }], rulesets: [{ id: 1, enforcement: 'active', rules: ['deletion', 'non_fast_forward', 'update'], bypass_count: 0 }],
    coverage: { complete: true, issues: issues.length, pull_requests: pull_requests.length, project_items: project_items.length, consistency: 'synthetic fixture; no live verification' } };
}
