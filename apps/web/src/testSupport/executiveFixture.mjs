// Synthetic, scoped protocol data for presentation tests; not native evidence.
export function executiveFixture(now = Date.now()) {
  const corp = 'corp-a', room = 'room-a', mission = 'mission-a', task = 'task-a', run = 'run-a'
  return {
    now,
    viewer: { corpId: corp, actorId: 'alice', role: 'owner' },
    stamp: { corpId: corp, actorId: 'alice', receivedAt: new Date(now).toISOString(), connection: 'live', refreshFailed: false },
    runners: [{ id: 'runner-a', corp_id: corp, connected: true, status: 'connected', last_seen_at: new Date(now).toISOString() }],
    snapshot: {
      corp: { id: corp, name: 'Authorized Corp' }, rooms: [{ id: room, corp_id: corp }],
      missions: [{ id: mission, corp_id: corp, room_id: room, title: 'Deliver the scoped search',
        description: 'An authorized outcome with exact recorded evidence.', status: 'running',
        original_budget_tokens: 1000, budget_tokens: 1000,
        original_budget_cost_microusd: 1_000_000, budget_cost_microusd: 1_000_000 }],
      tasks: [{ id: task, corp_id: corp, mission_id: mission, title: 'Search implementation',
        assigned_agent_id: 'agent-a', status: 'running', verification_status: 'pending', attempt_count: 1 }],
      runs: [{ id: run, corp_id: corp, task_id: task, agent_id: 'agent-a', runner_id: 'runner-a',
        status: 'running', execution_mode: 'provider', verification_status: 'pending', artifact_id: 'artifact-a',
        breaker_stage: null, resumed_from_run_id: null, input_tokens: 100, output_tokens: 10, cost_microusd: 2000 }],
      agents: [{ id: 'agent-a', name: 'Delivery engineer', adapter: 'github-copilot', current_run_id: run, mission_id: mission }],
      actors: [{ id: 'alice', name: 'Alice' }], leases: [],
      events: [{ id: 'event-a', seq: 1, type: 'run.started', aggregate_type: 'run', aggregate_id: run,
        created_at: new Date(now - 1000).toISOString(), payload: {}, corp_id: corp, room_id: room }],
      mission_budget_revisions: [], verification_requests: [], action_approvals: [], verification_evidence: [],
      factory_work_items: [], factory_controllers: [], pull_request_publications: [],
    },
  }
}
