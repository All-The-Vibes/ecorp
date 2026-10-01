// Synthetic public DTOs shared by reader and actual-component regressions.
// These fixtures are not native provider, reviewer or publication evidence.
const digest = 'a'.repeat(64), verification = 'b'.repeat(64);
const baseCommit = 'c'.repeat(40), headCommit = 'd'.repeat(40);

export function missionResultFixture(selected, phase = 'published') {
  const artifactId = 'artifact-a', runId = 'run-a', taskId = 'task-a', deliverableId = 'deliverable-a'
  const [owner, name] = selected.sourceRepository.split('/')
  const hasPr = ['pull_request_created', 'published'].includes(phase)
  const pr = hasPr ? {
    number: 17, node_id: 'PR_fixture', url: `https://github.com/${owner}/${name}/pull/17`,
    state: 'OPEN', draft: true, base_ref: 'main', head_sha: headCommit,
    head_repository_owner: owner, is_cross_repository: false, auto_merge: false,
    title: 'Private title is not result metadata', body: 'Private body is not result metadata',
  } : null
  return {
    work_item: {
      id: selected.workItemId, corp_id: selected.corpId, mission_id: selected.missionId,
      version: 9, source_repository_owner: owner, source_repository_name: name,
      source_issue_number: 71, source_issue_url: `https://github.com/${owner}/${name}/issues/71`,
      policy: { secret: 'not-for-result-state' },
    },
    publication: {
      id: 'publication-a', corp_id: selected.corpId, mission_id: selected.missionId,
      factory_work_item_id: selected.workItemId, source_deliverable_id: deliverableId,
      artifact_id: artifactId, task_id: taskId, run_id: runId,
      source_issue_number: 71, source_issue_url: `https://github.com/${owner}/${name}/issues/71`,
      state: phase, version: 4, target_repository: `${owner}/${name}`,
      base_ref: 'HEAD', branch: 'ecorp/result', commit_sha: headCommit,
      failure_detail: null, pull_request_number: pr?.number ?? null,
      pull_request_url: pr?.url ?? null, pull_request_state: pr?.state ?? null,
      pull_request_draft: pr?.draft ?? null, pull_request_base_ref: pr?.base_ref ?? null,
      pull_request_head_sha: pr?.head_sha ?? null,
      pull_request_head_repository_owner: pr?.head_repository_owner ?? null,
      pull_request_is_cross_repository: pr?.is_cross_repository ?? null,
      provenance: {
        schema_version: 3, factory_work_item_id: selected.workItemId, mission_id: selected.missionId,
        task_ids: ['task-handoff', taskId], run_ids: ['run-history', runId],
        verification_sha256: verification,
        deliverable: {
          id: deliverableId, artifact_id: artifactId, sha256: digest,
          base_commit: baseCommit, head_commit: headCommit, source_branch: 'crony/source',
        },
        target: { repository: `${owner}/${name}`, base_ref: 'HEAD', branch: 'ecorp/result', commit: headCommit },
        pull_request: pr,
        authorization_snapshot: { token: 'never-retain' },
      },
      publisher_token: 'never-retain', authorization_snapshot: { reason: 'Private authority' },
    },
    source_deliverables: [{
      id: deliverableId, corp_id: selected.corpId, task_id: taskId, run_id: runId,
      artifact_id: artifactId, form: 'commit_branch', file_name: 'result.bundle',
      uri: `/api/corps/${encodeURIComponent(selected.corpId)}/artifacts/${artifactId}`,
      sha256: digest, media_type: 'application/octet-stream', bytes: 1234,
      provenance_signature: 'e'.repeat(64), verification_sha256: verification,
      base_commit: baseCommit, head_commit: headCommit, branch: 'crony/source',
      integration_state: phase === 'published' ? 'published' : 'ready_for_review',
      retention_until: '2030-01-01T00:00:00Z',
      workspace_path: 'private-native-path', arbitrary_url: 'https://untrusted.invalid/',
    }],
  }
}

export function reviewRevisionFixture(scope, stage = 'pending') {
  const value = missionResultFixture(scope)
  const original = value.publication
  original.supersedes_publication_id = null
  original.provenance.source_issue = { number: 71, url: value.work_item.source_issue_url, revision: 'issue-r1' }
  value.work_item.state = stage === 'pending' ? 'review_revision' : stage === 'abandoned' || stage === 'published' ? 'published' : 'verified'
  value.publication_history = [original]
  const r = {
    id: 'revision-a', corp_id: scope.corpId, factory_work_item_id: scope.workItemId,
    publication_id: original.id, source_mission_id: scope.missionId, source_task_id: original.task_id,
    source_run_id: original.run_id, source_deliverable_id: original.source_deliverable_id,
    source_head_commit: original.commit_sha, mission_id: 'correction-a', task_id: 'correction-task',
    authorized_by: 'authorizer', findings: [{ kind: 'security', summary: 'Bound the operation.\nPreserve tenant isolation.',
      source_url: 'https://github.com/owner/repo/pull/17#discussion_r1', path: 'src/auth.rs', line: 12 }],
    state: stage === 'published' ? 'adopted' : stage, result_run_id: null, result_deliverable_id: null,
    result_commit: null, review_decision_id: null, settled_by: null,
    created_at: '2026-09-30T00:00:00Z', authority_snapshot: { secret: 'never-retain' },
  }
  const replacement = {
    ...value.source_deliverables[0], id: 'correction-deliverable', task_id: r.task_id, run_id: 'correction-run',
    artifact_id: 'correction-artifact', uri: '/api/corps/corp-a/artifacts/correction-artifact',
    head_commit: 'f'.repeat(40), integration_state: 'ready_for_review',
  }
  value.source_deliverables.push(replacement)
  value.review_revisions = [r]
  if (stage === 'abandoned') r.settled_by = 'manager'
  if (r.state === 'adopted') {
    Object.assign(r, { result_run_id: replacement.run_id, result_deliverable_id: replacement.id,
      result_commit: replacement.head_commit, review_decision_id: 'fresh-review', settled_by: 'manager' })
    value.work_item.mission_id = r.mission_id
    value.publication = null
  }
  if (stage === 'published') {
    const p = structuredClone(original)
    Object.assign(p, { id: 'publication-b', mission_id: r.mission_id, task_id: r.task_id,
      run_id: r.result_run_id, source_deliverable_id: r.result_deliverable_id, artifact_id: replacement.artifact_id,
      commit_sha: r.result_commit, branch: 'ecorp/correction', supersedes_publication_id: original.id,
      pull_request_number: 18, pull_request_url: 'https://github.com/owner/repo/pull/18', pull_request_head_sha: r.result_commit })
    Object.assign(p.provenance, {
      mission_id: r.mission_id, task_ids: [r.task_id], run_ids: [r.result_run_id],
      deliverable: { ...p.provenance.deliverable, id: replacement.id, artifact_id: replacement.artifact_id, head_commit: r.result_commit },
      target: { ...p.provenance.target, branch: p.branch, commit: r.result_commit },
      pull_request: { ...p.provenance.pull_request, number: 18, url: p.pull_request_url, head_sha: r.result_commit },
      review_revision: { ...r, supersedes_publication_id: original.id, source_pull_request: {
        number: original.pull_request_number, url: original.pull_request_url,
        repository: original.target_repository, base_ref: original.base_ref,
        branch: original.branch, head_sha: original.commit_sha,
      } },
    })
    value.publication_history.push(p)
    value.publication = p
  }
  return value
}
