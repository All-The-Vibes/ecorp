import { useState } from 'react'
import type { OfficeAgent } from './office/officeModel'

export function AgentPinControl({ agent, canOperate, onPin }: {
  agent: OfficeAgent
  canOperate: boolean
  onPin: (agent: OfficeAgent, pinned: boolean) => Promise<void>
}) {
  const [pending, setPending] = useState(false)
  if (agent.retired_at != null) return null
  const knownVersion = Number.isSafeInteger(agent.pin_version) && (agent.pin_version ?? -1) >= 0
  return (
    <div className="agent-pin-control">
      <button type="button" className="button button-secondary"
        disabled={!canOperate || !knownVersion || pending}
        aria-label={`${agent.pinned ? 'Unpin' : 'Pin'} ${agent.name}`}
        onClick={async () => {
          setPending(true)
          try { await onPin(agent, !agent.pinned) } finally { setPending(false) }
        }}>
        {pending ? 'Saving retention…' : agent.pinned ? 'Unpin identity' : 'Pin identity'}
      </button>
      <p className="agent-inspector-help">
        {agent.pinned
          ? agent.mission_id
            ? 'Pinned: protected from automatic retirement and reusable in this room. Unpinning never stops active work or releases its obligations.'
            : 'Pinned Corp identity. Unpinning records retention preference; unpinning does not retire a Corp identity.'
          : agent.mission_id
            ? 'Unpinned: retires after terminal work and all obligations settle. Pin to keep this identity reusable in this room.'
            : 'Reusable Corp identity. Pinning records retention preference; unpinning does not retire a Corp identity.'}
        {!canOperate ? ' An operator role is required.' : !knownVersion ? ' Refresh to load the current retention version.' : ''}
      </p>
    </div>
  )
}
