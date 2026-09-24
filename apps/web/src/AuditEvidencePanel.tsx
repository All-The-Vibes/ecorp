import { useEffect, useState } from 'react'
import './AuditEvidencePanel.css'

type ApiClient = <T>(path: string, init?: RequestInit) => Promise<T>
type Props = { corpId: string; actorId: string; api: ApiClient }
type Destination = {
  id: string; status: string; enabled: boolean; restore_required: boolean
  verified_sequence: number; verified_digest: string | null
  input: { config: { chain_id: number; contract_address: string; stream_id: string } }
}
type BaseStatus = {
  connection_state: string
  audit: {
    destinations: Destination[]
    intents: { id: string; destination_id: string; state: string }[]
    assurance_note: string
  }
}
type ArchiveStatus = {
  receipts: {
    destination_id: string; checkpoint_digest: string; status: string
    witness: { commit?: string; archive_publication?: { index_path: string; index_sha256: string } } | null
  }[]
}
type HistoryItem = {
  id: number; kind: string; created_at: string
  evidence: {
    event?: { transaction_hash: string; block_hash: string }
    included?: { number: number }
    assurance?: string
    observations?: { provider_identity: string }[]
  }
}
const request = (actorId: string, command: object, signal: AbortSignal): RequestInit => ({
  method: 'POST', signal, body: JSON.stringify({ actor_id: actorId, command }),
})

function AuditHistory({ corpId, actorId, api, destinationId }: Props & { destinationId: string }) {
  const [items, setItems] = useState<HistoryItem[]>([])
  const [after, setAfter] = useState(0)
  const [more, setMore] = useState(false)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    void api<{ items: HistoryItem[] }>(`/api/corps/${corpId}/base-audit`,
      request(actorId, { action: 'history', destination_id: destinationId, after, limit: 50 }, controller.signal))
      .then((page) => {
        if (controller.signal.aborted) return
        setItems((previous) => after === 0 ? page.items : [...previous, ...page.items])
        setMore(page.items.length === 50)
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Audit history unavailable.')
      })
      .finally(() => { if (!controller.signal.aborted) setBusy(false) })
    return () => controller.abort()
  }, [api, corpId, actorId, destinationId, after])
  return <div aria-label="Immutable Base history">
    <h3>Immutable history</h3>
    {error ? <p role="alert">{error}</p> : null}
    <ol>{items.map((item) => <li key={item.id} data-audit-history-kind={item.kind}>
      <strong>{item.kind}</strong> <time>{item.created_at}</time>
      {item.evidence.event ? <dl>
        <dt>Transaction</dt><dd><code>{item.evidence.event.transaction_hash}</code></dd>
        <dt>Block hash</dt><dd><code>{item.evidence.event.block_hash}</code></dd>
        {item.evidence.included ? <><dt>Block number</dt><dd>{item.evidence.included.number}</dd></> : null}
        {item.evidence.assurance ? <><dt>Assurance</dt><dd>{item.evidence.assurance}</dd></> : null}
        {item.evidence.observations ? <><dt>Provider observations</dt>
          <dd>{item.evidence.observations.map((observation) => observation.provider_identity).join(', ')}</dd></> : null}
      </dl> : null}
    </li>)}</ol>
    {busy ? <p role="status">Loading history...</p> : null}
    {more && !error ? <button className="button button-secondary" type="button" disabled={busy}
      onClick={() => {
        setBusy(true)
        setError('')
        setAfter(items.at(-1)?.id ?? 0)
      }}>Load more history</button> : null}
  </div>
}

export function AuditEvidencePanel({ corpId, actorId, api }: Props) {
  const [open, setOpen] = useState(false)
  const [revision, setRevision] = useState(0)
  const [data, setData] = useState<{ base: BaseStatus; archive: ArchiveStatus } | null>(null)
  const [selectedId, setSelectedId] = useState('')
  const [error, setError] = useState('')
  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    void Promise.all([
      api<BaseStatus>(`/api/corps/${corpId}/base-audit`, request(actorId, { action: 'status' }, controller.signal)),
      api<ArchiveStatus>(`/api/corps/${corpId}/state-audit`, request(actorId, { action: 'status' }, controller.signal)),
    ]).then(([base, archive]) => {
      if (!controller.signal.aborted) setData({ base, archive })
    }).catch((reason: unknown) => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Audit evidence unavailable.')
    })
    return () => controller.abort()
  }, [api, corpId, actorId, open, revision])
  const destination = data?.base.audit.destinations.find((item) => item.id === selectedId)
    ?? data?.base.audit.destinations[0]
  return <details className="panel audit-evidence-panel" data-testid="audit-evidence-panel" data-actor-id={actorId}
    onToggle={(event) => {
      setData(null)
      setError('')
      setOpen(event.currentTarget.open)
    }}>
    <summary>Audit evidence</summary>
    {open ? <div>
      <p>Read-only native checkpoint publication and Base evidence. No signing, enablement, or transaction controls.</p>
      <button className="button button-secondary" type="button" onClick={() => {
        setData(null)
        setError('')
        setRevision((value) => value + 1)
      }}>
        Refresh audit evidence
      </button>
      {error ? <p role="alert">{error}</p> : !data ? <p role="status">Loading audit evidence...</p> : <>
        <p>Worker connection: <strong>{data.base.connection_state}</strong></p>
        <p>{data.base.audit.assurance_note}</p>
        {destination ? <>
          <label>Base destination <select value={destination.id} onChange={(event) => setSelectedId(event.target.value)}>
            {data.base.audit.destinations.map((item) => <option key={item.id} value={item.id}>{item.id}</option>)}
          </select></label>
          <dl data-testid="base-destination-evidence">
            <dt>Status</dt><dd>{destination.status}</dd>
            <dt>Enabled</dt><dd>{String(destination.enabled)}</dd>
            <dt>Reconciliation required</dt><dd>{String(destination.restore_required)}</dd>
            <dt>Chain ID</dt><dd>{destination.input.config.chain_id}</dd>
            <dt>Registry</dt><dd><code>{destination.input.config.contract_address}</code></dd>
            <dt>Stream</dt><dd><code>{destination.input.config.stream_id}</code></dd>
            <dt>Verified sequence</dt><dd>{destination.verified_sequence}</dd>
            <dt>Verified checkpoint</dt><dd><code>{destination.verified_digest ?? 'Not verified'}</code></dd>
            <dt>Active intents</dt><dd>{data.base.audit.intents.filter((item) => item.destination_id === destination.id).length}</dd>
          </dl>
          <AuditHistory key={`${destination.id}:${revision}`} corpId={corpId} actorId={actorId}
            api={api} destinationId={destination.id} />
        </> : <p>No Base destination configured.</p>}
        <h3>GitHub archive receipts</h3>
        {data.archive.receipts.length ? <ul>{data.archive.receipts.map((receipt) =>
          <li key={`${receipt.destination_id}:${receipt.checkpoint_digest}`} data-testid="archive-receipt-evidence">
            <strong>{receipt.status}</strong>
            <dl>
              <dt>Checkpoint</dt><dd><code>{receipt.checkpoint_digest}</code></dd>
              <dt>Commit</dt><dd><code>{receipt.witness?.commit ?? 'No commit recorded'}</code></dd>
              <dt>Complete archive</dt><dd>{receipt.witness?.archive_publication ? 'Recorded' : 'Not recorded'}</dd>
              {receipt.witness?.archive_publication ? <>
                <dt>Index</dt><dd><code>{receipt.witness.archive_publication.index_path}</code></dd>
                <dt>Index SHA-256</dt><dd><code>{receipt.witness.archive_publication.index_sha256}</code></dd>
              </> : null}
            </dl>
          </li>)}</ul> : <p>No publication receipt recorded.</p>}
      </>}
    </div> : null}
  </details>
}
