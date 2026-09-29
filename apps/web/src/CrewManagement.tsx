import { useEffect, useRef, useState } from 'react'
import type { OfficeAgent } from './office/officeModel'
import {
  crewLifecycle, MAX_CLEAR_CREW_TARGETS, prepareRetirementOperation, readRetirementOperations,
  recordRetirementResponse, retirementBlockers,
} from './crewRetirement'
import type { RetirementMode, RetirementOperation, RetirementScope } from './crewRetirement'
import './CrewManagement.css'

export function CrewManagement({ scope, agents, runs, canOperate, snapshotCurrent, onRequest, onRefresh, onMission }: {
  scope: RetirementScope
  agents: readonly OfficeAgent[]
  runs: readonly { id: string; status: string }[]
  canOperate: boolean
  snapshotCurrent: boolean
  onRequest: (operation: RetirementOperation) => Promise<unknown>
  onRefresh: () => Promise<void>
  onMission: (missionId: string) => void
}) {
  // The parent keys this component by server/Corp/actor. Pending responses cannot
  // repaint a different principal's crew or refresh that principal's snapshot.
  const mounted = useRef(true)
  const sending = useRef(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const [loaded] = useState(() => {
    try {
      const storage = window.sessionStorage
      return { storage, operations: readRetirementOperations(storage, scope), error: null }
    } catch (caught) {
      return { storage: null, operations: [], error: caught instanceof Error ? caught.message : String(caught) }
    }
  })
  const [operations, setOperations] = useState<RetirementOperation[]>(loaded.operations)
  const [error, setError] = useState<string | null>(loaded.error)
  const [busy, setBusy] = useState(false)
  const current = agents.filter((agent) => agent.retired_at == null)
  const retired = agents.filter((agent) => agent.retired_at != null)
  const pending = operations.filter((operation) => !operation.response)
  const pendingTargets = new Set(pending.flatMap((operation) => operation.targets.map((target) => target.agent_id.toLowerCase())))
  const lastResult = operations.findLast((operation) => operation.response)
  const versionsKnown = current.every((agent) => Number.isSafeInteger(agent.pin_version) && (agent.pin_version ?? -1) >= 0)
  const canStart = canOperate && snapshotCurrent && !busy && loaded.storage !== null
  const overlapsPending = (targets: readonly OfficeAgent[]) => targets.some((agent) => pendingTargets.has(agent.id.toLowerCase()))
  const identityName = (id: string) => agents.find((agent) => agent.id === id)?.name ?? id

  async function send(request: { mode: RetirementMode; targets: readonly OfficeAgent[] } | { retryKey: string }) {
    if (!mounted.current || sending.current || !canOperate || !loaded.storage) return
    sending.current = true
    setBusy(true)
    setError(null)
    try {
      // A retry always reloads the original bytes. Roster changes, Pin updates
      // and WebSocket delivery never substitute a new target set or key.
      let saved: RetirementOperation | undefined
      if ('mode' in request) {
        if (!snapshotCurrent) throw new Error('Refresh the crew before making a new request.')
        saved = prepareRetirementOperation(loaded.storage, scope, request.mode, request.targets, crypto.randomUUID())
      } else {
        saved = readRetirementOperations(loaded.storage, scope).find((operation) => operation.idempotency_key === request.retryKey)
      }
      if (!saved || saved.response) throw new Error('There is no pending retirement request to retry.')
      setOperations(readRetirementOperations(loaded.storage, scope))
      const response = await onRequest(saved)
      recordRetirementResponse(loaded.storage, saved, response)
      if (!mounted.current) return
      setOperations(readRetirementOperations(loaded.storage, scope))
      try { await onRefresh() }
      catch { if (mounted.current) setError('The request was recorded, but the crew refresh failed. Refresh to see current state.') }
    } catch (caught) {
      if (mounted.current) {
        setError(caught instanceof Error ? caught.message : String(caught))
        try { setOperations(readRetirementOperations(loaded.storage, scope)) } catch { /* Preserve every displayed request. */ }
      }
    } finally {
      sending.current = false
      if (mounted.current) setBusy(false)
    }
  }

  const identity = (agent: OfficeAgent) => (
    <div className="crew-identity" key={agent.id}>
      <div className="crew-identity-label">
        <strong>{agent.name}</strong>
        <span>{agent.role} · {crewLifecycle(agent, runs.find((run) => run.id === agent.current_run_id)?.status)}{agent.pinned ? ' · Pinned' : ''}</span>
        <small>{agent.id}</small>
      </div>
      <div className="crew-identity-actions">
        {agent.mission_id && <button type="button" className="button button-quiet"
          aria-label={`View mission for ${agent.name}`} onClick={() => onMission(agent.mission_id!)}>View mission</button>}
        {agent.retired_at == null && <button type="button" className="button button-secondary"
          aria-label={`Retire ${agent.name}`} disabled={!canStart || overlapsPending([agent]) || !Number.isSafeInteger(agent.pin_version) || (agent.pin_version ?? -1) < 0}
          onClick={() => void send({ mode: 'retire', targets: [agent] })}>Retire</button>}
      </div>
    </div>
  )

  return (
    <section className="crew-management" aria-labelledby="crew-management-heading" aria-busy={busy}>
      <div className="crew-management-heading">
        <div>
          <h3 id="crew-management-heading" tabIndex={-1}>Crew</h3>
          <p>{current.length} current · {retired.length} retired</p>
        </div>
        <div className="crew-identity-actions">
          <button type="button" className="button button-secondary"
            disabled={!canStart || overlapsPending(current) || !versionsKnown || current.length === 0 || current.length > MAX_CLEAR_CREW_TARGETS}
            onClick={() => void send({ mode: 'clear', targets: current })}>Clear crew</button>
          <button type="button" className="button button-quiet" disabled={busy}
            onClick={() => void onRefresh().catch((caught) => {
              if (mounted.current) setError(caught instanceof Error ? caught.message : String(caught))
            })}>Refresh crew</button>
        </div>
      </div>
      <p className="crew-help">Clear crew checks every current identity below and retires eligible unpinned workers. Retire also allows an inactive pinned identity. Active work and history are preserved.</p>
      {!canOperate && <p className="crew-help">An operator role is required to manage the crew.</p>}
      {!snapshotCurrent && <p className="crew-help">Crew state is unconfirmed. Reconnect and refresh before a new request.</p>}
      {!versionsKnown && <p className="crew-help">Refresh to load each worker’s retention version.</p>}
      {current.length > MAX_CLEAR_CREW_TARGETS && <p className="crew-help">Clear crew supports at most {MAX_CLEAR_CREW_TARGETS} identities per request. Retire workers individually; no identities have been omitted from the roster.</p>}
      {current.length === 0 && <p className="crew-empty">Your crew is empty. A mission provisions the workers it needs.</p>}
      {current.length > 0 && <details className="crew-roster">
        <summary>Current identities ({current.length})</summary>
        <div className="crew-roster-list">{current.map(identity)}</div>
      </details>}
      {retired.length > 0 && <details className="crew-roster">
        <summary>Retired history ({retired.length})</summary>
        <p className="crew-help">These identities remain attached to their missions, runs and evidence.</p>
        <div className="crew-roster-list">{retired.map(identity)}</div>
      </details>}
      {pending.map((operation, index) => <div className="crew-pending" role="status" key={operation.idempotency_key}>
        <p>This {operation.mode === 'clear' ? 'Clear crew' : 'Retire'} request has no confirmed outcome. Retry its original {operation.targets.length} {operation.targets.length === 1 ? 'identity' : 'identities'} before making another request for them. Other identities remain available. A denied retry does not prove an earlier attempt had no effect.</p>
        <ul>{operation.targets.map((target) => <li key={target.agent_id}>{identityName(target.agent_id)}</li>)}</ul>
        <button type="button" className="button button-secondary" disabled={busy || !canOperate}
          aria-label={pending.length === 1 ? 'Retry saved request' : `Retry saved request ${index + 1}`}
          onClick={() => void send({ retryKey: operation.idempotency_key })}>Retry saved request{pending.length > 1 ? ` ${index + 1}` : ''}</button>
      </div>)}
      {pending.length > 0 && overlapsPending(current) && <p className="crew-help">Clear crew includes every current identity. Reconcile the saved requests for identities in this roster before clearing it.</p>}
      {error && <p className="crew-error" role="alert">{error}</p>}
      {lastResult?.response && <section className="crew-outcomes" aria-label="Last retirement results">
        <p role="status">Last request: {lastResult.response.results.filter((result) => result.status === 'retired').length} retired, {lastResult.response.results.filter((result) => result.status === 'blocked').length} blocked, {lastResult.response.results.filter((result) => result.status === 'already_retired').length} already retired.{lastResult.response.replayed ? ' Saved outcome recovered.' : ''}</p>
        <p className="crew-help">These are the recorded outcomes of that request. Refresh the crew for current state.</p>
        <ul>{lastResult.response.results.map((result) => <li key={result.agent_id}>
          <strong>{identityName(result.agent_id)}: </strong>
          {result.status === 'blocked' ? result.blockers.map((blocker) => retirementBlockers[blocker]).join(' ')
            : result.status === 'retired' ? 'Retired; history preserved.' : 'Already retired; history preserved.'}
        </li>)}</ul>
      </section>}
    </section>
  )
}
