import { missionOriginScope } from './missionOriginContext.ts'
import type { MissionOriginApi, MissionOriginScope } from './missionOriginContext.ts'

export type MissionResultScope = MissionOriginScope & Readonly<{
  workItemId: string
  sourceRepository: string
}>

export type MissionResultPublication = Readonly<{
  id: string
  mission_id: string
  source_revision: string | null
  supersedes_publication_id: string | null
  state: 'requested' | 'publishing' | 'branch_pushed' | 'pull_request_created' | 'published'
  version: number
  task_id: string
  run_id: string
  source_deliverable_id: string
  artifact_id: string
  target_repository: string
  base_ref: string
  branch: string
  commit_sha: string
  pull_request_number: number | null
  pull_request_url: string | null
  pull_request_state: 'open' | 'closed' | 'merged' | null
  pull_request_draft: boolean | null
  failed: boolean
}>

// Compatible with the existing source-download callback. No workspace path,
// provider output, authorization snapshot or credential is retained.
export type MissionResultDeliverable = Readonly<{
  id: string
  task_id: string
  run_id: string
  artifact_id: string
  form: 'commit_branch'
  file_name: string
  uri: string
  sha256: string
  media_type: string
  bytes: number
  provenance_signature: string
  verification_sha256: string
  base_commit: string
  head_commit: string
  branch: string
  integration_state: 'not_applicable' | 'ready_for_review' | 'published' | 'integrated'
  retention_until: string
}>

export type MissionResultContext = Readonly<{
  corp_id: string
  mission_id: string
  work_item_id: string
  work_item_version: number
  source_repository: string
  selected_mission_id: string
  work_item_state: string | null
  lineage_supported: boolean
  current_publication_id: string | null
  publication_history: readonly MissionPublishedResult[]
  review_revisions: readonly MissionReviewRevision[]
  publication: MissionResultPublication | null
  deliverable: MissionResultDeliverable | null
}>

export type MissionPublishedResult = Readonly<{
  publication: MissionResultPublication
  deliverable: MissionResultDeliverable
}>

export type MissionReviewFinding = Readonly<{
  kind: 'correctness' | 'security' | 'verification' | 'product_contract'
  summary: string
  source_url: string | null
  path: string | null
  line: number | null
}>

export type MissionReviewRevision = Readonly<{
  id: string
  publication_id: string
  source_mission_id: string
  source_task_id: string
  source_run_id: string
  source_deliverable_id: string
  source_head_commit: string
  mission_id: string
  task_id: string
  authorized_by: string
  findings: readonly MissionReviewFinding[]
  state: 'pending' | 'adopted' | 'abandoned'
  result_run_id: string | null
  result_deliverable_id: string | null
  result_commit: string | null
  review_decision_id: string | null
  settled_by: string | null
  created_at: string
  replacement: MissionResultDeliverable | null
  replacement_count: number
}>

export type MissionResultLoad =
  | { scope: MissionResultScope; status: 'pending' | 'unavailable'; context: null }
  | { scope: MissionResultScope; status: 'ready'; context: MissionResultContext }

export type MissionResultRun = Readonly<{
  id: string
  task_id?: string
  verification_sha256?: string | null
  deliverable_sha256?: string | null
}>

export type MissionResultPresentation = {
  state: 'loading' | 'unavailable' | 'none' | 'mismatch' | 'pending' | 'failed' | 'pr_created' | 'published'
  publication: MissionResultPublication | null
  deliverable: MissionResultDeliverable | null
  pullRequestUrl: string | null
  resultRunId: string | null
}

function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 &&
    !/[^!-~]/.test(value) && value !== '.' && value !== '..'
}

function text(value: unknown, max = 500): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max &&
    value.trim() === value && [...value].every((character) => {
      const code = character.charCodeAt(0)
      return code > 0x1f && (code < 0x7f || code > 0x9f)
    })
}

function repository(value: unknown): value is string {
  return text(value, 240) &&
    /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9_.-]+$/.test(value) &&
    !value.endsWith('/.') && !value.endsWith('/..')
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function hash(value: unknown, commit = false): string | null {
  return typeof value === 'string' && (value.length === 64 || (commit && value.length === 40)) &&
    !/[^a-fA-F0-9]/.test(value) ? value.toLowerCase() : null
}

function sameRepository(left: unknown, right: string): boolean {
  return repository(left) && left.toLowerCase() === right.toLowerCase()
}

function githubUrl(value: unknown, source: string, kind: 'issues' | 'pull', number: unknown): string | null {
  // Native publication accepts trailing PR slash runs. Match that suffix
  // directly without normalizing the URL or changing the issue-link contract.
  const pattern = kind === 'pull'
    ? /^https:\/\/github\.com\/([A-Za-z0-9-]+\/[A-Za-z0-9_.-]+)\/(pull)\/([1-9][0-9]*)\/*$/
    : /^https:\/\/github\.com\/([A-Za-z0-9-]+\/[A-Za-z0-9_.-]+)\/(issues|pull)\/([1-9][0-9]*)$/
  const match = typeof value === 'string' ? pattern.exec(value) : null
  return match && match[0] === value && sameRepository(match[1], source) &&
    match[2] === kind && positiveInteger(number) && match[3] === String(number) ? match[0] : null
}

function containsIdentity(value: unknown, id: string): boolean {
  return Array.isArray(value) && value.every(identifier) &&
    new Set(value).size === value.length && value.includes(id)
}

/** Recreate on view/identity/API/role changes or an explicit retry, including A -> B -> A. */
export function missionResultScope(input: {
  corpId: string | null | undefined
  actorId: string | null | undefined
  missionId: string | null | undefined
  roomId: string | null | undefined
  workItemId: string | null | undefined
  sourceRepository: string | null | undefined
}): MissionResultScope {
  const origin = missionOriginScope(input.corpId, input.actorId, input.missionId, input.roomId)
  if (![origin.corpId, origin.actorId, origin.missionId, origin.roomId, input.workItemId].every(identifier) ||
    !identifier(input.workItemId) || !repository(input.sourceRepository)) {
    throw new Error('Result context requires an explicit operator, mission, room, work item and repository.')
  }
  return Object.freeze({
    ...origin, workItemId: input.workItemId, sourceRepository: input.sourceRepository,
    key: JSON.stringify([origin.key, input.workItemId, input.sourceRepository]),
  })
}

export function currentMissionResult(scope: MissionResultScope | null, load: MissionResultLoad | null) {
  // Scope object identity is the view-generation fence, not merely equal ID strings.
  return scope && load?.scope === scope ? load : null
}

function readDeliverable(d: unknown, scope: MissionResultScope): MissionResultDeliverable {
  if (!record(d) || d.corp_id !== scope.corpId ||
    ![d.id, d.task_id, d.run_id, d.artifact_id].every(identifier) ||
    !identifier(d.id) || !identifier(d.task_id) || !identifier(d.run_id) || !identifier(d.artifact_id)) {
    throw new Error('Invalid source identity')
  }
  const uri = `/api/corps/${encodeURIComponent(scope.corpId)}/artifacts/${encodeURIComponent(d.artifact_id)}`
  const sha = hash(d.sha256), verification = hash(d.verification_sha256)
  const base = hash(d.base_commit, true), head = hash(d.head_commit, true)
  const signature = hash(d.provenance_signature)
  if (d.form !== 'commit_branch' || d.uri !== uri || !sha || !verification || !base || !head || !signature ||
    !text(d.branch) || !text(d.file_name, 255) || /[\\/:]/.test(d.file_name) || ['.', '..'].includes(d.file_name) ||
    !text(d.media_type, 128) || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(d.media_type) ||
    !positiveInteger(d.bytes) || typeof d.integration_state !== 'string' ||
    !['not_applicable', 'ready_for_review', 'published', 'integrated'].includes(d.integration_state) ||
    !text(d.retention_until, 64) || !Number.isFinite(Date.parse(d.retention_until))) {
    throw new Error('Invalid source evidence')
  }
  return {
    id: d.id, task_id: d.task_id, run_id: d.run_id, artifact_id: d.artifact_id,
    form: 'commit_branch', file_name: d.file_name, uri, sha256: sha, media_type: d.media_type,
    bytes: d.bytes, provenance_signature: signature, verification_sha256: verification,
    base_commit: base, head_commit: head, branch: d.branch,
    integration_state: d.integration_state as MissionResultDeliverable['integration_state'],
    retention_until: d.retention_until,
  }
}

function readPublication(
  p: unknown, item: Record<string, unknown>, sourceDeliverables: unknown[],
  scope: MissionResultScope, missionId: string,
): MissionPublishedResult {
  if (!record(p) || p.corp_id !== scope.corpId || p.mission_id !== missionId ||
    p.factory_work_item_id !== scope.workItemId ||
    !identifier(p.id) || !identifier(p.run_id) || !identifier(p.task_id) ||
    !identifier(p.source_deliverable_id) || !identifier(p.artifact_id) ||
    !positiveInteger(p.version) || !sameRepository(p.target_repository, scope.sourceRepository) ||
    p.source_issue_number !== item.source_issue_number ||
    !githubUrl(p.source_issue_url, scope.sourceRepository, 'issues', item.source_issue_number) ||
    !text(p.base_ref) || !text(p.branch) ||
    typeof p.state !== 'string' ||
    !['requested', 'publishing', 'branch_pushed', 'pull_request_created', 'published'].includes(p.state) ||
    !(p.failure_detail === null || typeof p.failure_detail === 'string') || !record(p.provenance) ||
    !(p.supersedes_publication_id == null || identifier(p.supersedes_publication_id))) {
    throw new Error('Invalid publication')
  }
  const matches = sourceDeliverables.filter((entry) =>
    record(entry) && entry.id === p.source_deliverable_id)
  if (matches.length !== 1) throw new Error('Missing or ambiguous published deliverable')
  const d = readDeliverable(matches[0], scope)
  const proof = p.provenance
  const dp = proof.deliverable
  const target = proof.target
  const sourceIssue = proof.source_issue
  const commit = hash(p.commit_sha, true)
  if (d.run_id !== p.run_id || d.task_id !== p.task_id || d.artifact_id !== p.artifact_id ||
    !commit || d.head_commit !== commit ||
    ![1, 2, 3].includes(Number(proof.schema_version)) || typeof proof.schema_version !== 'number' ||
    proof.factory_work_item_id !== scope.workItemId || proof.mission_id !== missionId ||
    (sourceIssue !== undefined && (!record(sourceIssue) || sourceIssue.number !== item.source_issue_number ||
      !githubUrl(sourceIssue.url, scope.sourceRepository, 'issues', item.source_issue_number))) ||
    !containsIdentity(proof.task_ids, p.task_id) || !containsIdentity(proof.run_ids, p.run_id) ||
    hash(proof.verification_sha256) !== d.verification_sha256 ||
    !record(dp) || dp.id !== d.id || dp.artifact_id !== d.artifact_id ||
    hash(dp.sha256) !== d.sha256 || hash(dp.head_commit, true) !== commit ||
    hash(dp.base_commit, true) !== d.base_commit || dp.source_branch !== d.branch ||
    !record(target) || !sameRepository(target.repository, scope.sourceRepository) ||
    target.base_ref !== p.base_ref || target.branch !== p.branch || hash(target.commit, true) !== commit) {
    throw new Error('Inconsistent publication evidence')
  }
  const hasPr = p.state === 'pull_request_created' || p.state === 'published'
  let prUrl: string | null = null
  let prNumber: number | null = null
  let prState: MissionResultPublication['pull_request_state'] = null
  let prDraft: boolean | null = null
  if (hasPr) {
    const url = githubUrl(p.pull_request_url, scope.sourceRepository, 'pull', p.pull_request_number)
    const pr = proof.pull_request
    const state = typeof p.pull_request_state === 'string' ? p.pull_request_state.toLowerCase() : ''
    if (!url || !positiveInteger(p.pull_request_number) ||
      !['open', 'closed', 'merged'].includes(state) || typeof p.pull_request_draft !== 'boolean' ||
      hash(p.pull_request_head_sha, true) !== commit || p.pull_request_is_cross_repository !== false ||
      typeof p.pull_request_head_repository_owner !== 'string' ||
      p.pull_request_head_repository_owner.toLowerCase() !== scope.sourceRepository.split('/')[0].toLowerCase() ||
      !text(p.pull_request_base_ref) || !record(pr) ||
      pr.url !== p.pull_request_url || pr.number !== p.pull_request_number ||
      pr.state !== p.pull_request_state || pr.draft !== p.pull_request_draft ||
      hash(pr.head_sha, true) !== commit || pr.base_ref !== p.pull_request_base_ref ||
      pr.head_repository_owner !== p.pull_request_head_repository_owner || pr.is_cross_repository !== false) {
      throw new Error('Inconsistent pull request')
    }
    prUrl = url
    prNumber = p.pull_request_number
    prState = state as NonNullable<MissionResultPublication['pull_request_state']>
    prDraft = p.pull_request_draft
  } else if (p.pull_request_url !== null || p.pull_request_number !== null || proof.pull_request !== null) {
    throw new Error('Premature pull request')
  }
  // Binding/format checks are not signature verification, renewed publication
  // authority, remote PR liveness, application hosting or provider completion.
  return {
    publication: {
      id: p.id, mission_id: missionId,
      source_revision: record(sourceIssue) && text(sourceIssue.revision, 200) ? sourceIssue.revision : null,
      supersedes_publication_id: p.supersedes_publication_id as string | null | undefined ?? null,
      state: p.state as MissionResultPublication['state'], version: p.version,
      task_id: p.task_id, run_id: p.run_id, source_deliverable_id: p.source_deliverable_id,
      artifact_id: p.artifact_id, target_repository: p.target_repository as string,
      base_ref: p.base_ref, branch: p.branch, commit_sha: commit,
      pull_request_number: prNumber, pull_request_url: prUrl,
      pull_request_state: prState, pull_request_draft: prDraft,
      failed: typeof p.failure_detail === 'string' && p.failure_detail.trim().length > 0,
    },
    deliverable: d,
  }
}

export function readReviewFinding(value: unknown): MissionReviewFinding {
  if (!record(value) || typeof value.kind !== 'string' ||
    !['correctness', 'security', 'verification', 'product_contract'].includes(value.kind) ||
    typeof value.summary !== 'string' || !value.summary.trim() || value.summary.includes('\0') ||
    new TextEncoder().encode(value.summary).length > 2000) throw new Error('Invalid finding')
  if (value.path !== null && (typeof value.path !== 'string' || !value.path ||
    new TextEncoder().encode(value.path).length > 500 || value.path.trim() !== value.path ||
    /[\\:]/.test(value.path) || [...value.path].some((char) => /\p{Cc}/u.test(char)) ||
    value.path.split('/').some((part) => ['', '.', '..'].includes(part)))) throw new Error('Invalid finding location')
  if (value.line !== null && (!positiveInteger(value.line) || value.line > 0xffff_ffff || value.path === null)) {
    throw new Error('Invalid finding line')
  }
  if (value.source_url !== null) {
    if (!text(value.source_url, 2000) || !value.source_url.startsWith('https://') ||
      new TextEncoder().encode(value.source_url).length > 2000) throw new Error('Invalid finding link')
    const url = new URL(value.source_url)
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Invalid finding link')
  }
  return {
    kind: value.kind as MissionReviewFinding['kind'], summary: value.summary,
    source_url: value.source_url as string | null, path: value.path as string | null,
    line: value.line as number | null,
  }
}

function readRevision(
  value: unknown, history: readonly MissionPublishedResult[], sourceDeliverables: unknown[], scope: MissionResultScope,
): MissionReviewRevision {
  if (!record(value) || value.corp_id !== scope.corpId || value.factory_work_item_id !== scope.workItemId ||
    !identifier(value.id) || !identifier(value.mission_id) || !identifier(value.task_id) ||
    !identifier(value.authorized_by) || !identifier(value.publication_id) ||
    !['pending', 'adopted', 'abandoned'].includes(String(value.state)) ||
    !text(value.created_at, 64) || !Number.isFinite(Date.parse(value.created_at)) ||
    !Array.isArray(value.findings) || value.findings.length === 0 || value.findings.length > 20) {
    throw new Error('Invalid correction')
  }
  const source = history.find(({ publication }) => publication.id === value.publication_id)?.publication
  if (!source || source.state !== 'published' || value.source_mission_id !== source.mission_id ||
    value.source_task_id !== source.task_id || value.source_run_id !== source.run_id ||
    value.source_deliverable_id !== source.source_deliverable_id ||
    hash(value.source_head_commit, true) !== source.commit_sha ||
    value.mission_id === source.mission_id || value.task_id === source.task_id) throw new Error('Invalid correction source')
  const candidates = sourceDeliverables.filter((d) => record(d) && d.task_id === value.task_id)
    .map((d) => readDeliverable(d, scope))
  if (new Set(candidates.map((d) => d.id)).size !== candidates.length) throw new Error('Duplicate correction source')
  let replacement: MissionResultDeliverable | null = null
  const adopted = value.state === 'adopted'
  if (adopted) {
    if (!identifier(value.result_run_id) || !identifier(value.result_deliverable_id) ||
      !identifier(value.review_decision_id) || !identifier(value.settled_by) || !hash(value.result_commit, true)) {
      throw new Error('Missing adoption evidence')
    }
    replacement = candidates.find((d) => d.id === value.result_deliverable_id) ?? null
    if (!replacement || replacement.run_id !== value.result_run_id ||
      replacement.head_commit !== hash(value.result_commit, true) || replacement.head_commit === source.commit_sha) {
      throw new Error('Inconsistent adopted source')
    }
  } else {
    if (value.result_run_id !== null || value.result_deliverable_id !== null || value.result_commit !== null ||
      value.review_decision_id !== null || (value.state === 'pending' ? value.settled_by !== null : !identifier(value.settled_by))) {
      throw new Error('Premature adoption evidence')
    }
    // A pending export is never an accepted replacement. Ambiguous exports are
    // left unselected; the server alone determines what can be adopted.
    replacement = candidates.length === 1 ? candidates[0] : null
  }
  return {
    id: value.id, publication_id: source.id, source_mission_id: source.mission_id,
    source_task_id: source.task_id, source_run_id: source.run_id, source_deliverable_id: source.source_deliverable_id,
    source_head_commit: source.commit_sha, mission_id: value.mission_id, task_id: value.task_id,
    authorized_by: value.authorized_by, findings: value.findings.map(readReviewFinding),
    state: value.state as MissionReviewRevision['state'],
    result_run_id: adopted ? value.result_run_id as string : null,
    result_deliverable_id: adopted ? value.result_deliverable_id as string : null,
    result_commit: adopted ? hash(value.result_commit, true) : null,
    review_decision_id: adopted ? value.review_decision_id as string : null,
    settled_by: value.settled_by as string | null, created_at: value.created_at,
    replacement, replacement_count: candidates.length,
  }
}

function readContext(value: unknown, scope: MissionResultScope): MissionResultContext {
  if (!record(value) || !record(value.work_item) || !Array.isArray(value.source_deliverables)) {
    throw new Error('Invalid result context')
  }
  const item = value.work_item
  if (item.id !== scope.workItemId || item.corp_id !== scope.corpId || !identifier(item.mission_id) ||
    !positiveInteger(item.version) || typeof item.source_repository_owner !== 'string' ||
    typeof item.source_repository_name !== 'string' ||
    !sameRepository(`${item.source_repository_owner}/${item.source_repository_name}`, scope.sourceRepository) ||
    !githubUrl(item.source_issue_url, scope.sourceRepository, 'issues', item.source_issue_number)) {
    throw new Error('Mismatched result context')
  }
  const identity = {
    corp_id: scope.corpId, mission_id: scope.missionId, work_item_id: scope.workItemId,
    work_item_version: item.version, source_repository: scope.sourceRepository,
    selected_mission_id: item.mission_id, work_item_state: text(item.state, 40) ? item.state : null,
  }
  // Both fields must be absent for a legacy response. Legacy reads can show an
  // exact result, but never establish authority for correction mutations.
  const legacy = !Object.hasOwn(value, 'publication_history') && !Object.hasOwn(value, 'review_revisions')
  if (legacy) {
    if (item.mission_id !== scope.missionId) throw new Error('Mismatched legacy mission')
    const result = value.publication === null ? null
      : readPublication(value.publication, item, value.source_deliverables, scope, item.mission_id)
    return { ...identity, lineage_supported: false, current_publication_id: result?.publication.id ?? null,
      publication_history: result ? [result] : [], review_revisions: [],
      publication: result?.publication ?? null, deliverable: result?.deliverable ?? null }
  }
  if (!Array.isArray(value.publication_history) || value.publication_history.length > 4 ||
    !Array.isArray(value.review_revisions) || value.review_revisions.length > 3) throw new Error('Invalid result history')
  const history = value.publication_history.map((p) => {
    if (!record(p) || !identifier(p.mission_id)) throw new Error('Missing historical mission')
    return readPublication(p, item, value.source_deliverables as unknown[], scope, p.mission_id)
  })
  for (const key of ['id', 'mission_id', 'source_deliverable_id'] as const) {
    if (new Set(history.map(({ publication }) => publication[key])).size !== history.length) throw new Error('Ambiguous result history')
  }
  const revisions = value.review_revisions.map((r) => readRevision(r, history, value.source_deliverables as unknown[], scope))
  for (const key of ['id', 'mission_id', 'task_id', 'publication_id'] as const) {
    if (new Set(revisions.map((r) => r[key])).size !== revisions.length) throw new Error('Ambiguous correction history')
  }
  const current = value.publication === null ? null
    : readPublication(value.publication, item, value.source_deliverables, scope, item.mission_id)
  const selected = history.find(({ publication }) => publication.mission_id === item.mission_id)
  if (JSON.stringify(current) !== JSON.stringify(selected ?? null)) throw new Error('Inconsistent current publication')
  if (history.length) {
    const roots = history.filter(({ publication }) => !publication.supersedes_publication_id)
    if (roots.length !== 1) throw new Error('Invalid publication root')
    let previous = roots[0].publication
    const seen = new Set([previous.id])
    for (;;) {
      const successors = history.filter(({ publication }) => publication.supersedes_publication_id === previous.id)
      if (!successors.length) break
      if (successors.length !== 1) throw new Error('Forked publication history')
      const next = successors[0].publication
      const revision = revisions.find((r) => r.publication_id === previous.id)
      const raw = value.publication_history.find((p) => record(p) && p.id === next.id) as Record<string, unknown>
      const proof = record(raw.provenance) ? raw.provenance.review_revision : null
      const predecessorPr = record(proof) ? proof.source_pull_request : null
      if (seen.has(next.id) || !revision || revision.state !== 'adopted' ||
        next.mission_id !== revision.mission_id || next.task_id !== revision.task_id ||
        next.run_id !== revision.result_run_id || next.source_deliverable_id !== revision.result_deliverable_id ||
        next.commit_sha !== revision.result_commit || next.base_ref !== previous.base_ref || next.branch === previous.branch ||
        !record(proof) || proof.id !== revision.id || proof.supersedes_publication_id !== previous.id ||
        proof.authorized_by !== revision.authorized_by || proof.review_decision_id !== revision.review_decision_id ||
        proof.source_mission_id !== previous.mission_id || proof.source_run_id !== previous.run_id ||
        proof.source_deliverable_id !== previous.source_deliverable_id || hash(proof.source_head_commit, true) !== previous.commit_sha ||
        !record(predecessorPr) || predecessorPr.number !== previous.pull_request_number ||
        predecessorPr.url !== previous.pull_request_url || !sameRepository(predecessorPr.repository, previous.target_repository) ||
        predecessorPr.base_ref !== previous.base_ref || predecessorPr.branch !== previous.branch ||
        hash(predecessorPr.head_sha, true) !== previous.commit_sha ||
        proof.mission_id !== next.mission_id || proof.task_id !== next.task_id || proof.result_run_id !== next.run_id ||
        proof.result_deliverable_id !== next.source_deliverable_id || hash(proof.result_commit, true) !== next.commit_sha) {
        throw new Error('Unbound successor publication')
      }
      seen.add(next.id)
      previous = next
    }
    if (seen.size !== history.length) throw new Error('Disconnected publication history')
    const latestRevision = revisions.find((r) => r.publication_id === previous.id)
    const expectedMission = latestRevision?.state === 'adopted' ? latestRevision.mission_id : previous.mission_id
    if (item.mission_id !== expectedMission ||
      revisions.some((r) => r.state === 'pending' && r.publication_id !== previous.id) ||
      (item.state === 'review_revision') !== (latestRevision?.state === 'pending')) throw new Error('Invalid Factory selection')
  } else if (revisions.length || current) throw new Error('Missing publication history')
  if (scope.missionId !== item.mission_id &&
    !history.some(({ publication }) => publication.mission_id === scope.missionId) &&
    !revisions.some((r) => r.mission_id === scope.missionId)) throw new Error('Unrelated mission')
  const viewed = history.find(({ publication }) => publication.mission_id === scope.missionId)
  return { ...identity, lineage_supported: true, current_publication_id: current?.publication.id ?? null,
    publication_history: history, review_revisions: revisions,
    publication: viewed?.publication ?? null, deliverable: viewed?.deliverable ?? null }
}

type Timer = ReturnType<typeof globalThis.setTimeout>
type ResultTimers = {
  setTimeout: (callback: () => void, delay: number) => Timer
  clearTimeout: (timer: Timer) => void
}
const nativeTimers: ResultTimers = {
  setTimeout: (callback, delay) => globalThis.setTimeout(callback, delay),
  clearTimeout: (timer) => globalThis.clearTimeout(timer),
}

/** One read only: no retries, credentials, provider access or publication mutation. */
export function startMissionResultRead(
  scope: MissionResultScope,
  get: MissionOriginApi,
  publish: (load: MissionResultLoad) => void,
  timers: ResultTimers = nativeTimers,
) {
  const controller = new AbortController()
  let active = true
  const finish = (load: MissionResultLoad) => {
    if (!active) return
    active = false
    timers.clearTimeout(timeout)
    publish(load)
  }
  publish({ scope, status: 'pending', context: null })
  const timeout = timers.setTimeout(() => {
    if (!active) return
    finish({ scope, status: 'unavailable', context: null })
    controller.abort()
  }, 15_000)
  void Promise.resolve().then(() => {
    if (!active) return undefined
    return get(
      `/api/corps/${encodeURIComponent(scope.corpId)}/factory/work-items/${encodeURIComponent(scope.workItemId)}/publication-context?actor_id=${encodeURIComponent(scope.actorId)}`,
      { method: 'GET', cache: 'no-store', signal: controller.signal },
    )
  }).then((value) => {
    if (!active) return
    finish({ scope, status: 'ready', context: readContext(value, scope) })
  }).catch(() => {
    // Missing endpoints, denied access and malformed data never become absence.
    // In particular, do not retain or render raw server/transport errors.
    finish({ scope, status: 'unavailable', context: null })
  })
  return () => {
    active = false
    timers.clearTimeout(timeout)
    controller.abort()
  }
}

/** Omit selectedRun for a mission-level result; supply even just its ID for a pinned historical view. */
export function missionResultPresentation(
  scope: MissionResultScope | null,
  load: MissionResultLoad | null,
  selectedRun?: MissionResultRun | null,
): MissionResultPresentation {
  const empty = (state: MissionResultPresentation['state'], resultRunId: string | null = null) => ({
    state, publication: null, deliverable: null, pullRequestUrl: null, resultRunId,
  })
  if (!scope) return empty('unavailable')
  if (!load) return empty('loading')
  const current = currentMissionResult(scope, load)
  if (!current) return empty('unavailable')
  if (current.status !== 'ready') return empty(current.status === 'pending' ? 'loading' : 'unavailable')
  const { publication, deliverable } = current.context
  if (!publication) return empty('none')
  if (!deliverable) return empty('unavailable')
  if (selectedRun !== undefined && selectedRun !== null) {
    if (!record(selectedRun) || !identifier(selectedRun.id)) return empty('unavailable')
    if (selectedRun.id !== publication.run_id) return empty('mismatch', publication.run_id)
    // A conflicting tuple for the same run is inconsistent data, not an older
    // review selection. Do not offer navigation as a way around that conflict.
    if ((selectedRun.task_id !== undefined && selectedRun.task_id !== publication.task_id) ||
      (selectedRun.verification_sha256 !== undefined && hash(selectedRun.verification_sha256) !== deliverable.verification_sha256) ||
      (selectedRun.deliverable_sha256 !== undefined && hash(selectedRun.deliverable_sha256) !== deliverable.sha256)) {
      return empty('unavailable')
    }
  }
  const state = publication.failed ? 'failed'
    : publication.state === 'published' ? 'published'
    : publication.state === 'pull_request_created' ? 'pr_created' : 'pending'
  return { state, publication, deliverable, pullRequestUrl: publication.pull_request_url, resultRunId: publication.run_id }
}
