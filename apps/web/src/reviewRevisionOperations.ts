import { currentMissionResult, readReviewFinding } from './missionResultContext.ts'
import type { MissionResultLoad, MissionResultScope, MissionReviewFinding } from './missionResultContext.ts'

export type ReviewRevisionAction = 'authorize' | 'adopt' | 'abandon'
export type ReviewFindingDraft = {
  id: number
  kind: MissionReviewFinding['kind']
  summary: string
  source_url: string
  path: string
  line: string
}

export function reviewRevisionView(scope: MissionResultScope | null, load: MissionResultLoad | null) {
  const current = currentMissionResult(scope, load)
  if (current?.status !== 'ready' || !current.context.lineage_supported) return null
  const context = current.context
  const root = context.publication_history.find((p) => !p.publication.supersedes_publication_id)
  if (!root || root.publication.state !== 'published') return null
  const history = [root]
  for (let index = 0; index < 3; index++) {
    const next = context.publication_history.find((p) =>
      p.publication.supersedes_publication_id === history.at(-1)?.publication.id)
    if (!next) break
    history.push(next)
  }
  const latest = history.findLast((entry) => entry.publication.state === 'published')!.publication
  const pendingPublication = history.at(-1)!.publication.id === latest.id ? null : history.at(-1)!.publication
  const revision = context.review_revisions.find((r) => r.publication_id === latest.id)
  return { context, history, original: root.publication, latest, pendingPublication, revision }
}

export function findingsFromDraft(drafts: readonly ReviewFindingDraft[]): MissionReviewFinding[] {
  if (!drafts.length || drafts.length > 20) throw new Error('Record between one and twenty findings.')
  return drafts.map((draft, index) => {
    try {
      if (draft.line && !/^[1-9][0-9]*$/.test(draft.line)) throw new Error()
      return readReviewFinding({
        kind: draft.kind, summary: draft.summary.trim(), source_url: draft.source_url.trim() || null,
        path: draft.path.trim() || null, line: draft.line ? Number(draft.line) : null,
      })
    } catch {
      throw new Error(`Finding ${index + 1} needs a summary of at most 2000 bytes, an optional repository-relative path and positive line, and an optional HTTPS link without credentials.`)
    }
  })
}

/** Build only from the current authorized read. No launch, review decision or publication effect. */
export function reviewRevisionCommand(
  scope: MissionResultScope, load: MissionResultLoad | null, role: string,
  action: ReviewRevisionAction, drafts: readonly ReviewFindingDraft[], reason: string,
) {
  const view = reviewRevisionView(scope, load)
  if (!view || !['owner', 'admin', 'manager'].includes(role)) throw new Error('Refresh with correction authority before continuing.')
  const { context, latest, revision } = view
  if (!latest.source_revision) throw new Error('Refresh to confirm the publication’s source revision.')
  const prefix = `/api/corps/${encodeURIComponent(scope.corpId)}/factory/work-items/${encodeURIComponent(scope.workItemId)}/review-revisions`
  const common = {
    actor_id: scope.actorId, expected_version: context.work_item_version,
    observed_source_revision: latest.source_revision,
  }
  if (action === 'authorize') {
    if (revision || latest.state !== 'published' || context.work_item_state !== 'published' ||
      context.current_publication_id !== latest.id || context.selected_mission_id !== scope.missionId ||
      latest.mission_id !== scope.missionId || context.review_revisions.length >= 3) {
      throw new Error('This publication cannot start another correction. Refresh its current history.')
    }
    return { path: prefix, action, publication: latest, revision: null,
      body: { ...common, publication_id: latest.id, published_head_commit: latest.commit_sha,
        findings: findingsFromDraft(drafts) } }
  }
  if (!revision || revision.state !== 'pending' || context.work_item_state !== 'review_revision' ||
    ![revision.source_mission_id, revision.mission_id].includes(scope.missionId)) {
    throw new Error('Open the pending correction before settling it.')
  }
  const normalized = reason.trim()
  if (!normalized || normalized.includes('\0') || new TextEncoder().encode(normalized).length > 4000) {
    throw new Error('Record a reason of between one and 4000 bytes.')
  }
  if (action === 'adopt' && (!revision.replacement || revision.replacement_count !== 1)) {
    throw new Error('A single replacement export is required before adoption.')
  }
  return { path: `${prefix}/${encodeURIComponent(revision.id)}/${action}`, action, publication: latest, revision,
    body: { ...common, reason: normalized } }
}

type Command = ReturnType<typeof reviewRevisionCommand>
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/** Never project a mutation response as accepted evidence; refresh the authoritative reader. */
export function reviewRevisionResponseMatches(value: unknown, scope: MissionResultScope, command: Command) {
  if (!record(value) || !record(value.revision) || !record(value.work_item) || typeof value.replayed !== 'boolean') return false
  const r = value.revision, item = value.work_item
  if (item.id !== scope.workItemId || item.corp_id !== scope.corpId ||
    !Number.isSafeInteger(item.version) || (item.version as number) <= command.body.expected_version ||
    r.corp_id !== scope.corpId || r.factory_work_item_id !== scope.workItemId ||
    r.publication_id !== command.publication.id || r.source_head_commit !== command.publication.commit_sha ||
    r.source_mission_id !== command.publication.mission_id || r.source_task_id !== command.publication.task_id ||
    r.source_run_id !== command.publication.run_id || r.source_deliverable_id !== command.publication.source_deliverable_id ||
    typeof r.id !== 'string' || !r.id || typeof r.mission_id !== 'string' || !r.mission_id) return false
  if (command.action === 'authorize') {
    try {
      return r.state === 'pending' && r.authorized_by === scope.actorId &&
        item.state === 'review_revision' && item.mission_id === command.publication.mission_id &&
        r.mission_id !== command.publication.mission_id && Array.isArray(r.findings) &&
        JSON.stringify(r.findings.map(readReviewFinding)) === JSON.stringify(command.body.findings)
    } catch { return false }
  }
  return r.id === command.revision?.id && r.mission_id === command.revision.mission_id &&
    r.settled_by === scope.actorId && r.state === (command.action === 'adopt' ? 'adopted' : 'abandoned') &&
    item.mission_id === (command.action === 'adopt' ? r.mission_id : command.publication.mission_id) &&
    item.state === (command.action === 'adopt' ? 'verified' : 'published')
}
