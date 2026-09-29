import { useState } from 'react'
import type { MissionOriginApi } from './missionOriginContext'
import type { MissionResultDeliverable, MissionResultPresentation, MissionResultScope } from './missionResultContext'
import { useHumanPublicationRequest } from './useHumanPublicationRequest'
import { WorkResultCard } from './WorkResultCard'

type Props = {
  scope: MissionResultScope | null
  result: MissionResultPresentation
  api: MissionOriginApi
  busy?: boolean
  onRefresh: () => void
  onDownload?: (source: MissionResultDeliverable) => void
}

/** Local selection/preview only; the server owns human intent and publication. */
export function PublicationRequestCard({ scope, result, api, busy = false, onRefresh, onDownload }: Props) {
  const [selection, setSelection] = useState<{ scope: MissionResultScope; source: MissionResultDeliverable } | null>(null)
  const candidates = result.state === 'available' ? result.candidates ?? [] : []
  const source = selection?.scope === scope && candidates.includes(selection.source)
    ? selection.source : candidates.length === 1 ? candidates[0] : null
  const request = useHumanPublicationRequest(scope, source, api, onRefresh)
  const { phase, preview } = request.view
  const pending = phase === 'previewing' || phase === 'submitting'
  const uncertain = phase === 'unconfirmed'
  return <WorkResultCard
    heading={phase === 'saved' ? 'Publication request saved' : preview ? 'Review the pull request target' : 'Send this result for review'}
    status={phase === 'saved' ? 'Requested' : pending ? 'Checking' : uncertain ? 'Check request' : 'Not published'}
    tone={uncertain || phase === 'unavailable' ? 'attention' : pending ? 'working' : 'neutral'}
    pending={pending}
    description={uncertain
      ? 'Request confirmation is unavailable. Your request may already be saved; refresh this result before trying again.'
      : phase === 'unavailable'
        ? 'A publication preview could not be confirmed. Refresh to recheck access, verification and source policy.'
        : phase === 'saved'
          ? 'Your request is saved. A trusted publisher can deliver it after you leave this page.'
          : preview
            ? 'Request a GitHub pull request for this exact result. This action does not merge or deploy it.'
            : 'Review the selected source, then check its publication target. A trusted publisher handles GitHub delivery.'}
    actions={<>
      {phase === 'ready' ? <button type="button" className="button button-primary"
        disabled={busy || !source} onClick={request.submit}>Request pull request</button>
        : !uncertain && phase !== 'saved' ? <button type="button" className="button button-primary"
          disabled={busy || pending || !source} onClick={request.preview}>
          {phase === 'previewing' ? 'Checking publication…' : phase === 'submitting' ? 'Saving request…' : 'Preview pull request'}
        </button> : null}
      {source && onDownload ? <button type="button" className="button button-secondary"
        disabled={busy || pending} onClick={() => onDownload(source)}>Download source bundle</button> : null}
      <button type="button" className="button button-secondary" disabled={pending}
        onClick={onRefresh}>Refresh result</button>
    </>}
    facts={source ? [
      { label: 'Repository', value: preview ? `${preview.plan.target_repository} · ${preview.plan.base_ref}` : scope?.sourceRepository },
      { label: 'Selected commit', value: <code>{source.head_commit}</code> },
      { label: 'Selected run', value: <code>{source.run_id}</code> },
      ...(preview ? [{ label: 'Delivery branch', value: <code>{preview.plan.branch}</code> }] : []),
    ] : undefined}
    details={preview ? <>
      <p><strong>Pull request title</strong><br />{preview.plan.title}</p>
      <p className="publication-request-body"><strong>Pull request description</strong><br />{preview.plan.body}</p>
    </> : undefined}
  >
    {candidates.length > 1 ? <label className="publication-source-select">
      Source result
      <select aria-label="Source result for publication" value={source?.id ?? ''} disabled={busy || pending}
        onChange={(event) => {
          const selected = candidates.find((candidate) => candidate.id === event.target.value)
          setSelection(scope && selected ? { scope, source: selected } : null)
        }}>
        <option value="">Choose the exact result</option>
        {candidates.map((candidate) => <option key={candidate.id} value={candidate.id}>
          {candidate.head_commit.slice(0, 12)} · run {candidate.run_id}
        </option>)}
      </select>
    </label> : null}
  </WorkResultCard>
}
