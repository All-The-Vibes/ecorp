import { missionCollaboration } from './missionCollaboration'
import type { CollaborationInput } from './missionCollaboration'
import './MissionCollaborationPanel.css'

type Section = 'brief' | 'tasks' | 'evidence' | 'discussion'
export function MissionCollaborationPanel({
  input, onSection, onInspectRun, onViewAgent,
}: {
  input: CollaborationInput
  onSection: (section: Section) => void
  onInspectRun: (runId: string) => void
  onViewAgent: (agentId: string) => void
}) {
  const team = missionCollaboration(input)
  return (
    <section className="mission-collaboration" aria-label="Mission collaboration" data-testid="mission-collaboration">
      <header className="collaboration-heading">
        <div><span className="section-code">Shared mission</span><h4>One outcome. Clear responsibilities.</h4></div>
        <span className="collaboration-connection">{input.connection === 'connecting' ? 'Reconnecting to shared updates'
          : input.connection === 'offline' ? 'Shared updates disconnected'
            : input.snapshotFailed ? 'Last snapshot refresh failed'
              : !team.snapshotCurrent ? 'Snapshot freshness unavailable' : 'Receiving shared updates'}</span>
      </header>
      <p className="collaboration-context">Requested by <strong>{team.requester}</strong>
        <span>Viewing as <strong>{input.actor.name}</strong> · {input.actor.role}</span></p>
      <p className="collaboration-boundary">People discuss and decide. Agents execute on runners. Live control never transfers review or publication authority.</p>
      {!team.snapshotCurrent ? <p className="collaboration-warning" role="status">
        Showing recorded state. {input.connection !== 'live'
          ? 'A disconnected browser does not mean the runner stopped. Reconnect before opening live controls.'
          : 'Runner state is unconfirmed until a successful snapshot refresh. Live controls are unavailable.'}
      </p> : null}
      <nav className="collaboration-navigation" aria-label="Shared mission sections">
        <button type="button" onClick={() => onSection('brief')}>01 · Brief &amp; scope</button>
        <button type="button" onClick={() => onSection('tasks')}>02 · Tasks &amp; contracts</button>
        <button type="button" disabled={!team.rows.some((row) => row.runId)} title={!team.rows.some((row) => row.runId) ? 'Evidence is available after a run starts.' : undefined}
          onClick={() => onSection('evidence')}>03 · Evidence &amp; decisions</button>
        <button type="button" onClick={() => onSection('discussion')}>04 · Team conversation</button>
      </nav>
      <div className="collaboration-crew-heading"><h4>Who is doing what</h4><span>{team.rows.length} recorded task{team.rows.length === 1 ? '' : 's'}</span></div>
      <ul className="collaboration-crew">
        {team.rows.map((row) => <li key={row.taskId} data-collaboration-task={row.taskId}>
          <div className="collaboration-task-heading"><strong>{row.title}</strong><span>{row.status.replaceAll('_', ' ')}</span></div>
          <p><strong>{row.agentName}</strong>{row.adapter ? ` · ${row.adapter}` : ''}</p>
          <p>{row.runnerState}</p>
          <p>{row.control}</p>
          {row.runId ? <p className="collaboration-run">Run {row.runId.slice(0, 8)} · {row.runStatus?.replaceAll('_', ' ')}</p> : null}
          {row.review ? <div className="collaboration-review">
            <strong>{row.review.label}</strong><p>Eligible roles: {row.review.roles || 'Unavailable'}</p>
            {row.review.blockedReason ? <p>{row.review.blockedReason}</p> : <p>Open the exact run to inspect its evidence before deciding.</p>}
          </div> : null}
          <div className="collaboration-task-actions">
            {row.controlsAvailable && row.agentId ? <button className="button button-secondary" type="button"
              onClick={() => onViewAgent(row.agentId!)}>Open {row.agentName} controls</button> : null}
            {row.runId ? <button className="button button-secondary" type="button"
              onClick={() => onInspectRun(row.runId!)}>{row.review ? 'Inspect review evidence' : 'Inspect this run'}</button>
              : <button className="button button-secondary" type="button" onClick={() => onSection('tasks')}>Inspect task contract</button>}
          </div>
        </li>)}
      </ul>
      {!team.rows.length ? <p className="collaboration-boundary">No task assignments are available in this view.</p> : null}
      <p className="collaboration-footnote">These are recorded assignments, not a human presence roster. Runner connectivity does not tell you whether a person is online.</p>
    </section>
  )
}
