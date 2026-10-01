// Opt-in browser -> server -> native runner acceptance against one owned stack.
// Retains failed attempts. Deterministic transports never claim provider coverage.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

assert.equal(process.env.CRONY_CODEX_STOP_TEST, '1', 'Explicit acceptance opt-in required')
assert.ok(path.isAbsolute(process.env.CRONY_CODEX_STOP_FIXTURE ?? ''))
const fixture = JSON.parse(await readFile(process.env.CRONY_CODEX_STOP_FIXTURE, 'utf8'))
assert.equal(fixture.test_owned, true)
assert.ok(['fixture-suspend', 'fixture-stop', 'provider-stop'].includes(fixture.scenario))
assert.ok(path.isAbsolute(fixture.qa_root) && path.isAbsolute(fixture.output))
assert.notEqual(path.resolve(fixture.source), path.resolve(fixture.product_root))
function ownedPath(value) {
  const relative = path.relative(fixture.qa_root, value)
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'Path is outside the owned fixture')
  return value
}
ownedPath(fixture.source)
function loopbackOrigin(value) {
  const url = new URL(value)
  assert.equal(url.protocol, 'http:')
  assert.equal(url.hostname, '127.0.0.1')
  assert.ok(url.port && !url.username && !url.password && !url.search && !url.hash)
  assert.equal(url.pathname, '/')
  return url.origin
}
const server = loopbackOrigin(fixture.server_url)
const web = loopbackOrigin(fixture.web_url)
const demo = fixture.demo
const api = suffix => `/api/corps/${demo.corp_id}${suffix}`
const report = {
  schema_version: 1, scenario: fixture.scenario, started_at: new Date().toISOString(),
  status: 'running', historical_incident_reproduced: false, assertions: [], http_results: [],
  server, web, corp_id: demo.corp_id, runner_id: fixture.runner_id,
  assurance: fixture.scenario === 'provider-stop'
    ? 'Real Codex app-server in a fresh local development stack and owned synthetic source; no historical incident or production claim.'
    : 'Explicit deterministic Codex transport fixture in the real browser/server/runner stack; no provider inference.',
}
const reportPath = path.join(fixture.output, 'browser.json')
const save = () => writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
function verify(name, test) {
  try { test(); report.assertions.push({ name, passed: true }) }
  catch (error) { report.assertions.push({ name, passed: false, error: error.message }); throw error }
}
async function request(route, body, expected = 200) {
  const response = await fetch(`${server}${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'error', signal: AbortSignal.timeout(10_000),
  })
  if (body !== undefined || response.status !== expected) {
    const detail = response.status === expected ? undefined : (await response.clone().text()).slice(0, 4000)
    report.http_results.push({ route, method: body === undefined ? 'GET' : 'POST', status: response.status, expected, detail })
  }
  assert.equal(response.status, expected, `${route}: unexpected HTTP status`)
  return expected === 204 ? null : response.json()
}
let lastState
const snapshot = async () => (lastState = await request(api(`/snapshot?actor_id=${demo.alice_actor_id}`)))
const runView = state => state.snapshot.runs.find(run => run.id === report.run_id)
const runEvents = state => state.snapshot.events.filter(event => event.aggregate_id === report.run_id)
async function waitFor(predicate, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const state = await snapshot()
    const run = runView(state)
    if (await predicate(run, state)) return { run, state }
    await delay(100)
  }
  throw new Error('Owned run did not reach the required persisted acceptance state before its deadline')
}
const terminal = run => run && ['completed', 'failed', 'cancelled', 'lost'].includes(run.status)
const requireTime = value => {
  const result = Date.parse(value)
  assert.ok(Number.isFinite(result), 'Missing or invalid observation time')
  return result
}
let browser
let page
const pageErrors = []
try {
  await save()
  if (fixture.scenario === 'fixture-suspend') {
    await request(api('/budget-policy'), {
      actor_id: demo.alice_actor_id, actor_tokens_per_24h: 100,
      actor_cost_microusd_per_24h: 10_000_000, corp_tokens_per_24h: 100_000,
      corp_cost_microusd_per_24h: 10_000_000, no_progress_event_limit: 100,
      repeated_tool_limit: 100,
    }, 204)
  }
  report.title = `Codex stop acceptance ${fixture.scenario} ${randomUUID()}`
  const created = await request(api('/missions'), {
    requested_by: demo.alice_actor_id, preferred_adapter: 'codex', strategy: 'single',
    title: report.title,
    description: fixture.scenario === 'provider-stop'
      ? 'Owned bounded stop regression. In this task worktree, use the native shell tool once to write stop-ready.txt containing ready, then immediately wait 45 seconds in that same shell command with PowerShell Start-Sleep. Do not do other work, read credentials, contact external services, commit or publish. An operator will stop this turn while that shell command is waiting.'
      : 'Owned deterministic Codex control and delayed-usage regression. Wait for an explicit stop or a budget directive; no external effects.',
    source: { repository: 'all-the-vibes/ecorp', base_ref: 'main', base_commit: fixture.source_head },
    budget_tokens: 100_000, budget_cost_microusd: 10_000_000,
  })
  report.mission_id = created.mission_id
  await save()
  const require = createRequire(import.meta.url)
  const { chromium } = require(process.env.CRONY_PLAYWRIGHT_MODULE || 'playwright')
  browser = await chromium.launch({ channel: 'chrome', headless: true })
  page = await browser.newPage({ viewport: { width: 1440, height: 1050 }, reducedMotion: 'reduce' })
  page.setDefaultTimeout(20_000)
  page.on('pageerror', () => pageErrors.push('Browser pageerror'))
  await page.goto(`${web}/#missions`, { waitUntil: 'networkidle' })
  await page.locator('.live-indicator.live-live').waitFor()
  await page.getByRole('button').filter({ hasText: report.title }).click()
  const card = page.locator(`[data-mission-id="${report.mission_id}"]`)
  const launchResponse = page.waitForResponse(response =>
    response.url() === `${server}${api(`/missions/${report.mission_id}/launch`)}` && response.request().method() === 'POST')
  report.browser_launch_at = new Date().toISOString()
  await card.getByTestId('work-result-card').getByRole('button', { name: 'Start mission', exact: true }).click()
  const launch = await launchResponse
  verify('Browser launch reached the real server', () => assert.equal(launch.status(), 200))
  report.run_id = (await launch.json()).run_id
  await save()
  const started = await waitFor(run => {
    assert.ok(!terminal(run), 'Run terminated before the control test could start')
    return run?.provider_session_id && run.status === 'running' && run.workspace_path
  })
  report.agent_id = started.run.agent_id
  report.provider_session_id = started.run.provider_session_id
  report.workspace_path = ownedPath(started.run.workspace_path)
  verify('Runner uses an isolated worktree', () => assert.notEqual(path.resolve(report.workspace_path), path.resolve(fixture.source)))
  await save()
  if (fixture.scenario !== 'fixture-suspend') {
    if (fixture.scenario === 'provider-stop') {
      await waitFor(async run => {
        assert.ok(!terminal(run), 'Provider finished before a running native tool was observed')
        try { return (await readFile(path.join(report.workspace_path, 'stop-ready.txt'), 'utf8')).trim() === 'ready' }
        catch (error) { if (error.code === 'ENOENT') return false; throw error }
      }, 90_000)
      report.provider_tool_observed_at = new Date().toISOString()
      verify('Real provider executed the bounded native shell operation', () => assert.ok(report.provider_tool_observed_at))
      // The native tool can start before its model response reports usage. Keep
      // it running until a real baseline arrives; never invent zero-token proof.
      const baseline = await waitFor((run, state) => {
        assert.ok(!terminal(run), 'Provider finished before reporting its usage baseline')
        return runEvents(state).some(event => event.type === 'run.control_observed' &&
          event.payload.phase === 'usage_observed')
      }, 15_000)
      report.provider_usage_baseline = {
        input_tokens: baseline.run.input_tokens, output_tokens: baseline.run.output_tokens,
        observed_at: new Date().toISOString(),
      }
      verify('Real provider reported usage before the stop', () =>
        assert.ok(baseline.run.input_tokens + baseline.run.output_tokens > 0))
    }
    const state = await snapshot()
    const agent = state.snapshot.agents.find(item => item.id === report.agent_id)
    assert.ok(agent && agent.current_run_id === report.run_id, 'Stop must target the exact owned active run')
    await page.goto(`${web}/#floor`, { waitUntil: 'networkidle' })
    await page.locator('.live-indicator.live-live').waitFor()
    await page.getByTestId(`agent-${agent.name}`).click()
    await page.screenshot({ path: path.join(fixture.output, 'browser-before-stop.png'), fullPage: true })
    page.once('dialog', dialog => dialog.accept(`Owned ${fixture.scenario} regression; stop the exact test run.`))
    const stopResponse = page.waitForResponse(response =>
      response.url() === `${server}${api(`/agents/${report.agent_id}/emergency-stop`)}` && response.request().method() === 'POST')
    report.browser_stop_at = new Date().toISOString()
    await page.getByRole('button', { name: 'Emergency stop', exact: true }).click()
    const stopped = await stopResponse
    verify('Browser stop reached the role-gated server endpoint', () => assert.equal(stopped.status(), 200))
    report.stop_response = await stopped.json()
    verify('Server accepted the stop request', () => assert.equal(report.stop_response.requested, true))
  }
  const settled = await waitFor((run, state) => terminal(run) && run.workspace_disposition === 'preserved' &&
    runEvents(state).some(event => event.type === 'run.session_terminated') &&
    runEvents(state).some(event => event.type === 'runner.command_acknowledged'), 30_000)
  // Give the asynchronous socket-send observer time to persist its own receipt.
  await waitFor((_, state) => runEvents(state).some(event => event.type === 'runner.command_socket_sent'), 10_000)
  const finalState = await snapshot()
  const run = runView(finalState)
  const events = runEvents(finalState)
  const controls = events.filter(event => event.type === 'run.control_observed')
  const phase = name => controls.find(event => event.payload.phase === name)
  const expectedStage = fixture.scenario === 'fixture-suspend' ? 'suspend' : 'stop'
  const received = controls.find(event => event.payload.phase === 'adapter_received' &&
    event.payload.detail.directive === expectedStage)
  const terminated = phase('process_terminated')
  const sessionTerminated = events.find(event => event.type === 'run.session_terminated')
  const usage = controls.filter(event => event.payload.phase === 'usage_observed')
  verify('Hard control cancels the run and preserves its source', () => {
    assert.equal(run.status, 'cancelled')
    assert.equal(run.breaker_stage, expectedStage)
    assert.equal(run.workspace_disposition, 'preserved')
    assert.equal(run.workspace_path, report.workspace_path)
  })
  verify('Hard control never accepts an artifact or completion', () => {
    assert.equal(run.artifact_id, null)
    assert.ok(!events.some(event => ['run.artifact', 'run.artifact_upload', 'run.verification_started',
      'run.verification_passed', 'run.completed'].includes(event.type)))
    assert.equal(finalState.snapshot.runs.filter(item => item.task_id === run.task_id).length, 1)
  })
  verify('Native process termination is a separate persisted receipt', () => {
    assert.equal(sessionTerminated.payload.provider_process_alive, false)
    assert.equal(sessionTerminated.payload.adapter, 'codex')
    assert.equal(terminated?.payload.detail.scope, 'windows_job_object')
    assert.equal(received?.payload.detail.directive, expectedStage)
  })
  verify('Runner observation clocks stay distinct from server recording clocks', () => {
    for (const event of controls) {
      requireTime(event.payload.observed_at)
      requireTime(event.payload.server_recorded_at)
      assert.equal(event.payload.clock_authority, 'runner_observation_only')
    }
    assert.ok(phase('interrupt_queued') && phase('interrupt_written'))
  })
  report.adapter_to_termination_ms = requireTime(terminated.payload.observed_at) - requireTime(received.payload.observed_at)
  verify('Control-to-termination stays within native cleanup allowance', () => {
    assert.ok(report.adapter_to_termination_ms >= 0 && report.adapter_to_termination_ms <= 10_000,
      `Observed latency ${report.adapter_to_termination_ms}ms exceeded 2s protocol + 350ms teardown + 5s verification + scheduling allowance`)
    assert.equal(received.payload.detail.interrupt_grace_ms, 2000)
    assert.equal(received.payload.detail.deadline_extended, false)
  })
  if (fixture.scenario !== 'provider-stop') {
    verify('Missing native terminal forces the fixed interrupt deadline', () => {
      assert.ok(phase('interrupt_responded'))
      assert.ok(phase('interrupt_deadline'))
      assert.ok(!phase('native_terminal'))
      const latency = requireTime(phase('interrupt_deadline').payload.observed_at) - requireTime(received.payload.observed_at)
      assert.ok(latency >= 1900 && latency <= 3500, `Interrupt deadline observation was ${latency}ms`)
    })
  }
  const stages = fixture.scenario === 'fixture-suspend' ? ['constrain', 'suspend'] : ['stop']
  for (const stage of stages) {
    verify(`Durable ${stage} dispatch and authenticated acknowledgment`, () => {
      const sent = events.find(event => event.type === 'runner.command_socket_sent' && event.payload.stage === stage)
      const acknowledged = events.find(event => event.type === 'runner.command_acknowledged' && event.payload.stage === stage)
      assert.ok(sent && acknowledged)
      assert.equal(sent.payload.command_id, acknowledged.payload.command_id)
      assert.equal(sent.payload.runner_receipt_confirmed, false)
      assert.equal(acknowledged.payload.receipt.provider_termination_confirmed, false)
      assert.equal(acknowledged.payload.receipt.runner_timestamp_valid, true)
      requireTime(sent.payload.socket_sent_at)
      requireTime(acknowledged.payload.receipt.runner_received_at)
      requireTime(acknowledged.payload.receipt.server_acknowledged_at)
    })
  }
  verify('Usage observations never claim provider generation time', () => {
    assert.ok(usage.length, 'No native usage observation was retained')
    assert.ok(usage.every(event => event.payload.detail.generation_time_known === false))
    assert.equal(requireTime(terminated.payload.detail.last_usage_observed_at), requireTime(usage.at(-1).payload.observed_at))
  })
  verify('Charged usage respects the database cutoff', () => {
    const accountingEvents = events.filter(item => ['run.usage', 'run.usage_observed'].includes(item.type))
    assert.ok(accountingEvents.length, 'No authoritative usage accounting event was recorded')
    for (const event of accountingEvents) {
      const accounting = event.payload.accounting
      assert.equal(accounting.grace_seconds, 5)
      assert.equal(accounting.generation_time_known, false)
      if (accounting.charged && accounting.cutoff_at) assert.ok(requireTime(accounting.admitted_at) < requireTime(accounting.cutoff_at))
      if (event.type === 'run.usage_observed') assert.equal(accounting.charged, false)
    }
  })
  if (fixture.scenario === 'fixture-suspend') {
    verify('Replayed cumulative reports cannot re-charge or escalate suspend to stop', () => {
      assert.equal(run.input_tokens, 90)
      assert.equal(run.output_tokens, 18)
      assert.ok(usage.some(event => event.payload.detail.after_adapter_control && !event.payload.detail.monotonic_report))
      assert.ok(!events.some(event => event.type === 'run.breaker_transition' && event.payload.stage === 'stop'))
    })
  } else if (fixture.scenario === 'fixture-stop') {
    verify('Late transport reports remain observable after the directive', () =>
      assert.ok(usage.some(event => event.payload.detail.after_adapter_control)))
  }
  report.run = run
  report.events = events
  report.final_usage = { input_tokens: run.input_tokens, output_tokens: run.output_tokens,
    last_observed_at: terminated.payload.detail.last_usage_observed_at }
  report.settled_observed_at = settled.run.updated_at
  await page.goto(`${web}/#missions`, { waitUntil: 'networkidle' })
  await page.locator('.live-indicator.live-live').waitFor()
  await page.getByRole('button').filter({ hasText: report.title }).click()
  await page.locator(`[data-mission-id="${report.mission_id}"]`).waitFor()
  await page.screenshot({ path: path.join(fixture.output, 'browser-after-control.png'), fullPage: true })
  verify('Browser has no page errors', () => assert.deepEqual(pageErrors, []))
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'
  report.failure = error.message
  if (page) await page.screenshot({ path: path.join(fixture.output, 'browser-failure.png'), fullPage: true }).catch(() => {})
  // Failure may happen before the browser stop. Bound this owned run explicitly.
  if (report.run_id) {
    try {
      const state = await snapshot()
      const run = runView(state)
      if (run && !terminal(run)) {
        report.failure_stop = await request(api(`/agents/${run.agent_id}/emergency-stop`), {
          actor_id: demo.alice_actor_id, reason: 'Owned acceptance failed; terminate this exact fixture run.',
        })
        await waitFor(terminal, 20_000)
      }
    } catch (cleanupError) { report.failure_stop_error = cleanupError.message }
  }
} finally {
  if (lastState && report.run_id) {
    report.run ??= runView(lastState)
    report.events ??= runEvents(lastState)
  }
  if (browser) await browser.close().catch(error => { report.status = 'failed'; report.browser_close_error = error.message })
  report.finished_at = new Date().toISOString()
  report.counts = { passed: report.assertions.filter(item => item.passed).length,
    failed: report.assertions.filter(item => !item.passed).length }
  await save()
  console.log(JSON.stringify({ scenario: report.scenario, status: report.status, counts: report.counts,
    run_id: report.run_id, adapter_to_termination_ms: report.adapter_to_termination_ms, failure: report.failure }))
  process.exitCode = report.status === 'passed' ? 0 : 1
}
