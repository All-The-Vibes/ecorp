import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { assertCancelledDeadlineRun, validateDeadlineFixture } from './e2e_mission_deadline.mjs'

function setup() {
  const repository = path.resolve('inert-fixture-input', 'product')
  const root = path.resolve('inert-fixture-input', 'qa', 'issue224-planned-attempts-test-issue298-r1')
  const process = { pid: 123, executable: path.join(repository, 'test-binary'), started_utc: '2026-10-02T10:00:00Z' }
  return { test_owned: true, provider_fixture: 'deadline-complete-after-stop', repository,
    qa_root: root, source: path.join(root, 'source'), source_repository: 'ecorp-fixture/planned-attempts-fixture',
    source_commit: 'a'.repeat(40), source_binding: { source_fingerprint: 'b'.repeat(64) },
    server_url: 'http://127.0.0.1:19094', web_url: 'http://127.0.0.1:16094', runner_id: 'issue224-planned-qa',
    demo: { corp_id: '11111111-1111-1111-1111-111111111111', alice_actor_id: '22222222-2222-2222-2222-222222222222' },
    processes: { server: { ...process }, web: { ...process, pid: 124 } } }
}

test('imported deadline driver is inert and requires explicit owned deterministic configuration', () => {
  assert.deepEqual(validateDeadlineFixture(setup(), '1'), { server: 'http://127.0.0.1:19094', web: 'http://127.0.0.1:16094' })
  assert.throws(() => validateDeadlineFixture(setup(), undefined), /Explicit/u)
  assert.throws(() => validateDeadlineFixture({ ...setup(), provider_fixture: 'live-provider' }, '1'))
  assert.throws(() => validateDeadlineFixture({ ...setup(), test_owned: false }, '1'))
})

test('deadline driver refuses shared sources, remote endpoints and changed process receipts', () => {
  const config = setup()
  assert.throws(() => validateDeadlineFixture({ ...config, source: config.repository }, '1'))
  assert.throws(() => validateDeadlineFixture({ ...config, source_repository: 'All-The-Vibes/ecorp' }, '1'))
  for (const server_url of ['https://example.com', 'http://127.0.0.1:19094/api', 'http://user:password@127.0.0.1:19094']) {
    assert.throws(() => validateDeadlineFixture({ ...config, server_url }, '1'))
  }
  assert.throws(() => validateDeadlineFixture({ ...config, processes: { ...config.processes, server: { ...config.processes.server, pid: 0 } } }, '1'))
})

function observations() {
  const run = { status: 'cancelled', workspace_disposition: 'preserved', artifact_id: null }
  const control = (phase, detail = {}, observed_at = '2026-10-02T10:00:01Z') => ({ type: 'run.control_observed', payload: { phase, detail, observed_at } })
  const events = [
    control('adapter_received', { directive: 'stop', interrupt_grace_ms: 2000, deadline_extended: false }),
    control('interrupt_queued'), control('interrupt_written'),
    control('native_terminal', { status: 'completed', after_adapter_control: true }, '2026-10-02T10:00:01.100Z'),
    control('process_terminated', { scope: 'windows_job_object' }, '2026-10-02T10:00:01.200Z'),
    { type: 'run.session_terminated', payload: { adapter: 'codex', provider_process_alive: false } },
  ]
  return { run, events }
}

test('deadline acceptance needs late native success, committed cancellation and separate termination', () => {
  const { run, events } = observations()
  assert.equal(assertCancelledDeadlineRun(run, events).native.payload.detail.status, 'completed')
  assert.throws(() => assertCancelledDeadlineRun({ ...run, status: 'completed' }, events))
  assert.throws(() => assertCancelledDeadlineRun({ ...run, workspace_disposition: 'removed' }, events))
  assert.throws(() => assertCancelledDeadlineRun(run, events.filter(event => event.type !== 'run.session_terminated')))
  const interrupted = structuredClone(events)
  interrupted.find(event => event.payload.phase === 'native_terminal').payload.detail.status = 'interrupted'
  assert.throws(() => assertCancelledDeadlineRun(run, interrupted), /adversarial/u)
})

test('deadline acceptance rejects artifacts, false physical-stop claims and renewed stop allowance', () => {
  const { run, events } = observations()
  assert.throws(() => assertCancelledDeadlineRun({ ...run, artifact_id: 'an-artifact' }, events))
  assert.throws(() => assertCancelledDeadlineRun(run, [...events, { type: 'run.completed' }]))
  for (const [phase, key, value] of [['adapter_received', 'deadline_extended', true], ['native_terminal', 'after_adapter_control', false]]) {
    const altered = structuredClone(events)
    altered.find(event => event.payload.phase === phase).payload.detail[key] = value
    assert.throws(() => assertCancelledDeadlineRun(run, altered))
  }
  const stillAlive = structuredClone(events)
  stillAlive.find(event => event.type === 'run.session_terminated').payload.provider_process_alive = true
  assert.throws(() => assertCancelledDeadlineRun(run, stillAlive))
})
