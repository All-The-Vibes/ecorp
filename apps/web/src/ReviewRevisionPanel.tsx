import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { MissionOriginApi } from './missionOriginContext'
import { currentMissionResult } from './missionResultContext'
import type { MissionResultDeliverable, MissionResultLoad, MissionResultScope } from './missionResultContext'
import { reviewRevisionCommand, reviewRevisionResponseMatches, reviewRevisionView } from './reviewRevisionOperations'
import type { ReviewFindingDraft, ReviewRevisionAction } from './reviewRevisionOperations'
import { WorkResultCard } from './WorkResultCard'
import './ReviewRevisionPanel.css'

type Props = {
  scope: MissionResultScope | null
  load: MissionResultLoad | null
  server: string
  actorRole: string
  actors: readonly { id: string; name: string }[]
  api: MissionOriginApi
  busy?: boolean
  operationKey: (storageKey: string, payload: string) => string
  clearOperation: (storageKey: string, expectedKey?: string) => void
  onRefresh: () => void
  onChanged: () => Promise<unknown>
  onOpenMission: (missionId: string, runId?: string) => void
  onDownload: (deliverable: MissionResultDeliverable) => void
}

export function ReviewRevisionPanel(props: Props) {
  const current = currentMissionResult(props.scope, props.load)
  if (!props.scope || current?.status !== 'ready' || !current.context.publication_history.length) return null
  if (!current.context.lineage_supported) return <p className="work-result-notice">Refresh result to load correction history. Correction controls require a current delivery record.</p>
  return <RevisionDetails key={JSON.stringify([props.server, props.scope.key, props.actorRole, current.context.work_item_version])}
    {...props} scope={props.scope} load={current} />
}

const newFinding = (id: number): ReviewFindingDraft => ({ id, kind: 'correctness', summary: '', path: '', line: '', source_url: '' })
const kindLabels = { correctness: 'Correctness', security: 'Security', verification: 'Verification', product_contract: 'Product contract' }

function RevisionDetails({
  scope, load, server, actorRole, actors, api, busy = false, operationKey, clearOperation,
  onRefresh, onChanged, onOpenMission, onDownload,
}: Props & { scope: MissionResultScope; load: MissionResultLoad }) {
  const formId = useId()
  const [drafts, setDrafts] = useState<ReviewFindingDraft[]>([newFinding(1)])
  const nextFinding = useRef(2)
  const [reason, setReason] = useState('')
  const identity = useMemo(() => ({ scope, server, api, actorRole }), [scope, server, api, actorRole])
  const [operation, setOperation] = useState<{ identity: typeof identity; pending: boolean; message: string } | null>(null)
  // A new view, including A -> B -> A and explicit refresh, retires every old
  // callback. The synchronous lock also fences clicks before React rerenders.
  const activeView = useRef<typeof identity | null>(null)
  const activeRequest = useRef<{ identity: typeof identity; controller: AbortController } | null>(null)
  useLayoutEffect(() => {
    activeView.current = identity
    return () => {
      if (activeView.current === identity) activeView.current = null
      if (activeRequest.current?.identity === identity) {
        activeRequest.current.controller.abort()
        activeRequest.current = null
      }
    }
  }, [identity])
  const isCurrent = () => activeView.current === identity
  const view = reviewRevisionView(scope, load)
  if (!view) return null
  const { context, original, latest, pendingPublication, history, revision } = view
  const pending = operation?.identity === identity && operation.pending
  const message = operation?.identity === identity ? operation.message : ''
  const canManage = ['owner', 'admin', 'manager'].includes(actorRole)
  const ownsView = [latest.mission_id, revision?.mission_id].includes(scope.missionId)
  const canAuthorize = canManage && ownsView && !revision && latest.state === 'published' &&
    context.work_item_state === 'published' && context.current_publication_id === latest.id &&
    scope.missionId === latest.mission_id && context.review_revisions.length < 3 && Boolean(latest.source_revision)
  const canSettle = canManage && ownsView && revision?.state === 'pending' &&
    context.work_item_state === 'review_revision' && Boolean(latest.source_revision)
  const locked = busy || pending
  const actorLabel = (id: string) => actors.find((actor) => actor.id === id)?.name ?? id
  const openMission = (missionId: string, runId?: string) => {
    if (isCurrent()) onOpenMission(missionId, runId)
  }
  const updateDraft = (id: number, field: keyof Omit<ReviewFindingDraft, 'id'>, value: string) =>
    setDrafts((current) => current.map((draft) => draft.id === id ? { ...draft, [field]: value } : draft))
  const removeDraft = (id: number) => {
    const index = drafts.findIndex((draft) => draft.id === id)
    const remaining = drafts.filter((draft) => draft.id !== id)
    if (!remaining.length) return
    setDrafts(remaining)
    const focus = remaining[Math.min(index, remaining.length - 1)]
    window.requestAnimationFrame(() => {
      if (isCurrent()) document.getElementById(`${formId}-finding-${focus.id}`)?.focus()
    })
  }
  const mutate = async (action: ReviewRevisionAction) => {
    if (!isCurrent() || activeRequest.current || busy) return
    let command: ReturnType<typeof reviewRevisionCommand>
    let storageKey: string, key: string
    try {
      command = reviewRevisionCommand(scope, load, actorRole, action, drafts, reason)
      storageKey = JSON.stringify(['ecorp-review-revision', server, scope.corpId, scope.actorId,
        scope.workItemId, command.publication.id, command.revision?.id ?? '', action])
      key = operationKey(storageKey, JSON.stringify(command.body))
    } catch (error) {
      setOperation({ identity, pending: false, message: error instanceof Error ? error.message : 'Check the correction inputs.' })
      return
    }
    const controller = new AbortController()
    activeRequest.current = { identity, controller }
    setOperation({ identity, pending: true, message: '' })
    const timeout = globalThis.setTimeout(() => controller.abort(), 30_000)
    const aborted = new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(new Error('Unconfirmed decision')), { once: true })
    })
    try {
      const response = await Promise.race([aborted, api(command.path, { method: 'POST', signal: controller.signal,
        body: JSON.stringify({ ...command.body, idempotency_key: key }) })])
      if (!isCurrent()) return
      if (!reviewRevisionResponseMatches(response, scope, command)) throw new Error('Unconfirmed response')
      clearOperation(storageKey, key)
      setOperation({ identity, pending: false, message: 'Correction decision recorded. Refreshing its history.' })
      onRefresh()
      // Snapshot refresh keeps ordinary launch, review and navigation current.
      // Its failure cannot turn a confirmed decision into an unconfirmed one.
      void onChanged().catch(() => {})
    } catch {
      if (isCurrent()) setOperation({ identity, pending: false,
        message: 'The decision could not be confirmed. Refresh the correction history and current authority before retrying. An unchanged request keeps its retry key.' })
    } finally {
      globalThis.clearTimeout(timeout)
      if (activeRequest.current?.controller === controller) activeRequest.current = null
    }
  }
  const currentStatus = pendingPublication?.failed ? 'Publication needs attention'
    : pendingPublication ? 'Publication in progress'
      : revision?.state === 'pending' ? 'Correction in progress'
    : revision?.state === 'adopted' ? 'Awaiting publication'
      : revision?.state === 'abandoned' ? 'Correction abandoned' : 'Published'
  return <div className="review-revision-panel" data-testid="review-revision-panel">
    <WorkResultCard heading="Review corrections" status={currentStatus}
      tone={revision?.state === 'pending' ? 'attention' : 'neutral'} pending={pending}
      description="Corrections preserve the original result, rerun its saved checks and require a fresh independent review. Authorizing a correction creates a separate mission; starting it is a separate action."
      facts={[
        { label: 'Original publication', value: <><a href={original.pull_request_url ?? undefined} target="_blank" rel="noopener noreferrer">PR #{original.pull_request_number}</a><br /><code>{original.commit_sha}</code></> },
        { label: 'Last recorded review head', value: <><a href={latest.pull_request_url ?? undefined} target="_blank" rel="noopener noreferrer">PR #{latest.pull_request_number}</a><br /><code>{latest.commit_sha}</code></> },
      ]}
      actions={<>
        <button type="button" className="button button-secondary" disabled={locked} onClick={() => { if (isCurrent()) onRefresh() }}>Refresh correction history</button>
        {scope.missionId !== (revision?.mission_id ?? latest.mission_id) ? <button type="button" className="button button-secondary"
          onClick={() => openMission(revision?.mission_id ?? latest.mission_id)}>Open {revision ? 'correction' : 'current review'} mission</button> : null}
      </>}>
      {context.review_revisions.map((entry) => <article className="review-revision-entry" key={entry.id} aria-label={`Correction ${entry.id}`}>
        <h5>Correction · {entry.state === 'pending' ? 'Pending' : entry.state === 'adopted' ? 'Adopted' : 'Abandoned'}</h5>
        <p>Findings submitted by {actorLabel(entry.authorized_by)}. <small>Actor: {entry.authorized_by}</small></p>
        <ol className="review-revision-findings">{entry.findings.map((finding, index) => <li key={index}>
          <strong>{kindLabels[finding.kind]}</strong><p>{finding.summary}</p>
          {finding.path ? <code>{finding.path}{finding.line ? `:${finding.line}` : ''}</code> : null}
          {finding.source_url ? <a href={finding.source_url} target="_blank" rel="noopener noreferrer">Finding evidence</a> : null}
        </li>)}</ol>
        <div className="work-result-actions">
          <button type="button" className="button button-secondary" onClick={() => openMission(entry.mission_id)}>Open correction mission</button>
          {entry.replacement ? <button type="button" className="button button-secondary"
            onClick={() => openMission(entry.mission_id, entry.replacement!.run_id)}>Inspect correction run</button> : null}
          {entry.replacement ? <button type="button" className="button button-secondary" disabled={locked}
            onClick={() => isCurrent() && entry.replacement && onDownload(entry.replacement)}>
            Download {entry.state === 'adopted' ? 'adopted replacement' : 'unadopted source'}
          </button> : null}
        </div>
        <p>{entry.state === 'adopted' ? 'Adopted replacement' : 'Unadopted correction source'}: {entry.replacement
          ? <code>{entry.replacement.head_commit}</code>
          : entry.replacement_count ? 'Multiple exports; no replacement selected.' : 'No source export recorded yet.'}</p>
        {entry.state === 'pending' ? <p className="work-result-notice">An export alone does not establish acceptance. Adoption rechecks completed verification and the fresh independent review.</p> : null}
        {entry.review_decision_id ? <p>Independent review record: <code>{entry.review_decision_id}</code></p> : null}
        {entry.settled_by ? <p>{entry.state === 'adopted' ? 'Adopted' : 'Abandoned'} by {actorLabel(entry.settled_by)}.</p> : null}
      </article>)}
      {history.length > 1 ? <details className="work-result-details"><summary>Publication history</summary>
        <ol>{history.map(({ publication }) => <li key={publication.id}>
          {publication.pull_request_url ? <a href={publication.pull_request_url} target="_blank" rel="noopener noreferrer">PR #{publication.pull_request_number}</a>
            : <span>No PR recorded yet</span>}
          {publication.supersedes_publication_id ? ' · Superseding publication' : ' · Original publication'}
          {publication.state !== 'published' ? ` · ${publication.failed ? 'Needs attention' : 'Publication incomplete'}` : null}
          <p><code>{publication.commit_sha}</code></p>
          <button type="button" className="button button-secondary" onClick={() => openMission(publication.mission_id, publication.run_id)}>Inspect publication run</button>
        </li>)}</ol>
      </details> : null}
      {revision?.state === 'adopted' ? <p className="work-result-notice">{pendingPublication
        ? 'The superseding publication has not finished.' : 'The adopted correction awaits an explicit superseding publication.'} The recorded PR head above remains the last published head.</p> : null}
      {canAuthorize ? <form className="review-revision-form" onSubmit={(event) => { event.preventDefault(); void mutate('authorize') }}>
        <h5>Authorize bounded corrections</h5>
        <p>These findings will be attributed to {actorLabel(scope.actorId)}. The correction keeps the published repository, base, write and tool scope, and uses only remaining budget and attempts.</p>
        <fieldset disabled={locked}>
          <legend>Review findings</legend>
          {drafts.map((draft, index) => <div className="review-revision-draft" key={draft.id}>
            <label>Finding {index + 1} kind<select value={draft.kind} onChange={(event) => updateDraft(draft.id, 'kind', event.target.value)}>
              {Object.entries(kindLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select></label>
            <label htmlFor={`${formId}-finding-${draft.id}`}>Finding {index + 1} summary</label>
            <textarea id={`${formId}-finding-${draft.id}`} required maxLength={2000} rows={3} value={draft.summary}
              onChange={(event) => updateDraft(draft.id, 'summary', event.target.value)} />
            <label>Repository path (optional)<input value={draft.path} maxLength={500} onChange={(event) => updateDraft(draft.id, 'path', event.target.value)} /></label>
            <label>Line (optional)<input type="number" min={1} max={4294967295} step={1} value={draft.line} onChange={(event) => updateDraft(draft.id, 'line', event.target.value)} /></label>
            <label>HTTPS evidence link (optional)<input type="url" value={draft.source_url} maxLength={2000} onChange={(event) => updateDraft(draft.id, 'source_url', event.target.value)} /></label>
            <button type="button" className="button button-secondary" disabled={drafts.length === 1} onClick={() => removeDraft(draft.id)}>Remove finding {index + 1}</button>
          </div>)}
          <button type="button" className="button button-secondary" disabled={drafts.length >= 20}
            onClick={() => setDrafts((current) => [...current, newFinding(nextFinding.current++)])}>Add finding</button>
        </fieldset>
        <button type="submit" className="button button-primary" disabled={locked}>{pending ? 'Recording correction…' : 'Authorize correction'}</button>
      </form> : null}
      {canSettle ? <form className="review-revision-form" onSubmit={(event) => { event.preventDefault(); void mutate('adopt') }}>
        <label htmlFor={`${formId}-reason`}>Adoption or abandonment reason</label>
        <textarea id={`${formId}-reason`} value={reason} required maxLength={4000} rows={3} disabled={locked} onChange={(event) => setReason(event.target.value)} />
        <div className="work-result-actions">
          <button type="submit" className="button button-primary" disabled={locked || !revision?.replacement || revision.replacement_count !== 1}>Adopt verified correction</button>
          <button type="button" className="button button-secondary" disabled={locked} onClick={() => void mutate('abandon')}>Abandon correction</button>
        </div>
        <p className="work-result-notice">Abandonment requires every correction run to be stopped. Use the existing mission controls to stop active work first.</p>
      </form> : null}
      {!canManage ? <p className="work-result-notice">An owner, admin or manager can authorize and settle corrections.</p> : null}
      {context.review_revisions.length >= 3 && !canSettle ? <p className="work-result-notice">The three-correction limit has been reached.</p> : null}
      {message ? <p className="work-result-notice" role="status">{message}</p> : null}
    </WorkResultCard>
  </div>
}
