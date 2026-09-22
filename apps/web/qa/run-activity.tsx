// Browser component fixture only. No App bootstrap, HTTP, runner or provider connection.
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import '../src/index.css'
import '../src/App.css'
import '../src/Arcade.css'
import '../src/Cabinet.css'
import '../src/World.css'
import '../src/Accessible.css'
import '../src/OperationsUx.css'
import { WorkResultCard } from '../src/WorkResultCard'
import { RunActivityDetails } from '../src/RunActivityDetails'
import { presentRunActivity } from '../src/runActivity'
import type { RunActivityInput } from '../src/runActivity'

const at = (seconds: number) => new Date(Date.UTC(2026, 8, 14, 12, 0, seconds)).toISOString()
const event = (seq: number, type: string, payload = {}) => ({
  id: `event-${seq}`, seq, type, aggregate_type: 'run', aggregate_id: 'example-run',
  created_at: at(seq), payload, corp_id: 'example-corp', room_id: 'example-room',
})
function sample(state: string): RunActivityInput {
  const input: RunActivityInput = {
    corpId: 'example-corp', mission: { id: 'example-mission', room_id: 'example-room', status: 'running' },
    run: { id: 'example-run', task_id: 'example-task', agent_id: 'example-agent', runner_id: 'example-runner',
      status: 'running', execution_mode: 'provider' },
    tasks: [{ id: 'example-task', mission_id: 'example-mission', title: 'Implement accessible invoice search' }],
    agents: [{ id: 'example-agent', name: 'Delivery engineer', adapter: 'github-copilot' }],
    runners: [{ id: 'example-runner', corp_id: 'example-corp', connected: true, status: 'connected', last_seen_at: at(25) }],
    actors: [{ id: 'example-operator', name: 'Example operator' }],
    leases: [{ agent_id: 'example-agent', actor_id: 'example-operator', expires_at: at(300) }],
    events: [event(1, 'run.started'), event(14, 'run.tool_activity', { progressed: true }), event(22, 'run.output')],
    reviews: [], approvals: [], connection: 'live', snapshotReceivedAt: at(30), factoryState: 'running',
  }
  if (state === 'blocked' && input.run) {
    input.run.status = 'cancelled'; input.run.breaker_stage = 'suspend'; input.mission.status = 'cancelled'
    input.events = [...input.events, event(24, 'run.session_terminated', { provider_process_alive: false }), event(26, 'run.cancelled')]
  }
  if (state === 'review' && input.run) {
    input.run.status = 'waiting_for_approval'; input.run.verification_status = 'passed'
    input.reviews = [{ run_id: 'example-run', task_id: 'example-task', status: 'pending' }]
    input.events = [...input.events, event(24, 'run.session_terminated', { provider_process_alive: false }), event(26, 'run.verification_passed')]
  }
  if (state === 'completed' && input.run) {
    input.run.status = 'completed'; input.mission.status = 'completed'; input.factoryState = 'verified'
    input.events = [...input.events, event(24, 'run.session_terminated', { provider_process_alive: false }), event(26, 'run.completed')]
  }
  if (state === 'offline') input.connection = 'offline'
  if (state === 'refresh-failed') input.snapshotFailed = true
  if (state === 'quarantined' && input.run) { input.run.workspace_disposition = 'quarantined'; input.run.breaker_stage = 'stop'; input.run.status = 'cancelled' }
  if (state === 'verifier-only' && input.run) input.run.execution_mode = 'verification_only'
  if (state === 'lost' && input.run) { input.run.status = 'lost'; input.runners = [] }
  return input
}
export function Fixture() {
  const [state, setState] = useState('running')
  const input = sample(state)
  const view = presentRunActivity(input)
  return <main className="app-shell view-factory">
    <header className="topbar">
      <div className="brand-lockup"><div className="brand-row"><h1><span>E</span>CORP</h1><span className="alpha-stamp">Component QA · synthetic data</span></div></div>
      <div className="operations-identity">
        <label htmlFor="fixture-state">Fixture state</label>
        <select id="fixture-state" value={state} onChange={(e) => setState(e.target.value)}>
          <option value="running">Running</option><option value="blocked">Blocked / suspended</option>
          <option value="review">Awaiting review</option><option value="completed">Completed</option>
          <option value="offline">Disconnected</option><option value="refresh-failed">Snapshot refresh failed</option>
          <option value="quarantined">Quarantined / stopped</option><option value="verifier-only">Verifier-only</option><option value="lost">Runner lost</option>
        </select>
      </div>
    </header>
    <section id="factory" className="factory-panel panel">
      <div className="panel-heading"><div><span className="section-code">Factory</span><h2>Current UI · issue #259</h2><p>Actual components and stylesheets. No server, runner or provider is connected.</p></div></div>
      <div className="factory-workbench"><article className="factory-dossier-stage">
        <div className="factory-dossier-top"><span className="factory-source">Example work item</span><span className="status-chip">Intake · {input.factoryState}</span></div>
        <h3>Make invoice search easier to use</h3>
        <WorkResultCard heading={view.heading} status={view.status} tone={view.tone} description={view.summary}
          actions={<button type="button" className="button button-primary" onClick={() => document.getElementById('fixture-note')?.focus()}>{view.status === 'Awaiting review' ? 'Review this run' : 'Open run and results'}</button>}>
          <RunActivityDetails key={state} view={view} />
        </WorkResultCard>
        <p id="fixture-note" tabIndex={-1}>Fixture only: the production button retains its existing mission-navigation callback. No operational action is sent here.</p>
      </article></div>
    </section>
  </main>
}
createRoot(document.getElementById('root')!).render(<Fixture />)
