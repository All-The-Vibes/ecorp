// Explicit, owned browser/server/runner acceptance for completion/stop ordering.
// The loopback gate delays real protocol messages; it never invents a receipt.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

assert.equal(process.env.CRONY_CODEX_STOP_TEST, '1', 'Explicit acceptance opt-in required')
assert.ok(path.isAbsolute(process.env.CRONY_CODEX_STOP_FIXTURE ?? ''))
const fixture = JSON.parse(await readFile(process.env.CRONY_CODEX_STOP_FIXTURE, 'utf8'))
assert.equal(fixture.test_owned, true)
assert.ok(['fixture-completion-stop', 'fixture-completion-accepted',
  'fixture-completion-lost', 'fixture-completion-legacy'].includes(fixture.scenario))
assert.ok(path.isAbsolute(fixture.qa_root) && path.isAbsolute(fixture.output))
function ownedPath(value) {
  const relative = path.relative(fixture.qa_root, value)
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'Path outside owned fixture')
  return value
}
ownedPath(fixture.source)
assert.notEqual(path.resolve(fixture.source), path.resolve(fixture.product_root))
function loopback(value) {
  const url = new URL(value)
  assert.equal(url.protocol, 'http:')
  assert.equal(url.hostname, '127.0.0.1')
  assert.equal(url.pathname, '/')
  assert.ok(url.port && !url.username && !url.password && !url.search && !url.hash)
  return url.origin
}
const server = loopback(fixture.server_url)
const web = loopback(fixture.web_url)
const gate = loopback(fixture.gate_url)
const demo = fixture.demo
const api = suffix => `/api/corps/${demo.corp_id}${suffix}`
const report = { schema_version: 1, scenario: fixture.scenario, status: 'running',
  started_at: new Date().toISOString(), assertions: [], http_results: [], historical_incident_reproduced: false,
  assurance: 'Deterministic Codex transport in the real owned browser/server/runner/PostgreSQL stack; no provider inference or mixed-version binary claim.' }
const save = () => writeFile(path.join(fixture.output, 'browser.json'), `${JSON.stringify(report, null, 2)}\n`)
function verify(name, test) {
  try { test(); report.assertions.push({ name, passed: true }) }
  catch (error) { report.assertions.push({ name, passed: false, error: error.message }); throw error }
}
async function request(origin, route, body, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(`${origin}${route}`, { method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'error', signal: AbortSignal.timeout(10_000) })
  if (method !== 'GET' || response.status !== 200) {
    report.http_results.push({ origin, route, method, status: response.status })
  }
  assert.equal(response.status, 200, `${route}: unexpected HTTP status`)
  return response.json()
}
let lastState
const snapshot = async () => (lastState = await request(server, api(`/snapshot?actor_id=${demo.alice_actor_id}`)))
const runView = state => state.snapshot.runs.find(run => run.id === report.run_id)
const runEvents = state => state.snapshot.events.filter(event => event.aggregate_id === report.run_id)
const terminal = run => run && ['completed', 'failed', 'cancelled', 'lost'].includes(run.status)
async function gateState() {
  const state = await request(gate, '/state')
  assert.equal(state.failure, null, 'Owned gate reported a transport failure')
  report.gate = state
  return state
}
async function waitFor(read, predicate, timeout = 45_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const state = await read()
    if (await predicate(state)) return state
    await delay(100)
  }
  throw new Error('Owned completion fixture exceeded its observation deadline')
}
function cleanWorkspace() {
  assert.equal(execFileSync('git', ['-C', report.workspace_path, 'status', '--porcelain=v1',
    '--untracked-files=all', '--ignored'], { encoding: 'utf8', windowsHide: true }).trim(), '')
  assert.equal(execFileSync('git', ['-C', report.workspace_path, 'rev-parse', 'HEAD'],
    { encoding: 'utf8', windowsHide: true }).trim(), fixture.source_head)
}
let browser
let page
const pageErrors = []
try {
  await save()
  report.title = `Completion receipt ${fixture.scenario} ${randomUUID()}`
  const created = await request(server, api('/missions'), {
    requested_by: demo.alice_actor_id, preferred_adapter: 'codex', strategy: 'single', title: report.title,
    description: 'Owned deterministic completion receipt regression. No external effects.',
    source: { repository: 'all-the-vibes/ecorp', base_ref: 'main', base_commit: fixture.source_head },
    budget_tokens: 100_000, budget_cost_microusd: 10_000_000,
  })
  report.mission_id = created.mission_id
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
  const launchResponse = page.waitForResponse(response => response.url() ===
    `${server}${api(`/missions/${report.mission_id}/launch`)}` && response.request().method() === 'POST')
  await card.getByTestId('work-result-card').getByRole('button', { name: 'Start mission', exact: true }).click()
  const launch = await launchResponse
  verify('Browser launched the mission through the real server', () => assert.equal(launch.status(), 200))
  report.run_id = (await launch.json()).run_id
  await waitFor(gateState, state => state.completion?.run_id === report.run_id)
  // Receiving a transport message precedes committing earlier server events.
  // Hold completion until the authoritative verifier result is observable.
  const waiting = await waitFor(snapshot, state =>
    runEvents(state).some(event => event.type === 'run.verification_passed'), 10_000)
  const pending = runView(waiting)
  report.verification_event_id = runEvents(waiting)
    .find(event => event.type === 'run.verification_passed').id
  report.verification_observed_at = new Date().toISOString()
  report.agent_id = pending.agent_id
  report.workspace_path = ownedPath(pending.workspace_path)
  verify('Completion is held after persisted verification while source stays clean and present', () => {
    assert.ok(!terminal(pending))
    assert.ok(runEvents(waiting).some(event => event.type === 'run.verification_passed'))
    assert.ok(!runEvents(waiting).some(event => event.type === 'run.completed'))
    assert.equal(report.gate.completion.requested, true)
    assert.equal(report.gate.receipt, null)
    assert.notEqual(path.resolve(report.workspace_path), path.resolve(fixture.source))
    cleanWorkspace()
  })
  await page.screenshot({ path: path.join(fixture.output, 'browser-completion-held.png'), fullPage: true })
  if (fixture.scenario === 'fixture-completion-stop') {
    const agent = waiting.snapshot.agents.find(item => item.id === report.agent_id)
    assert.equal(agent.current_run_id, report.run_id)
    await page.goto(`${web}/#floor`, { waitUntil: 'networkidle' })
    await page.locator('.live-indicator.live-live').waitFor()
    await page.getByTestId(`agent-${agent.name}`).click()
    page.once('dialog', dialog => dialog.accept('Owned completion race: stop this exact fixture run.'))
    const stopResponse = page.waitForResponse(response => response.url() ===
      `${server}${api(`/agents/${report.agent_id}/emergency-stop`)}` && response.request().method() === 'POST')
    await page.getByRole('button', { name: 'Emergency stop', exact: true }).click()
    const stopped = await stopResponse
    verify('Browser stop committed through the role-gated server endpoint', () => assert.equal(stopped.status(), 200))
    assert.equal((await stopped.json()).requested, true)
    await waitFor(gateState, state => state.hard_stop?.run_id === report.run_id)
  }
  report.gate = await request(gate, '/release', undefined, 'POST')
  const removal = fixture.scenario === 'fixture-completion-accepted'
  await waitFor(snapshot, state => terminal(runView(state)) &&
    runEvents(state).some(event => event.type === (removal ? 'run.workspace_removed' : 'run.workspace_preserved')), 65_000)
  await delay(1_000)
  const settled = await snapshot()
  const run = runView(settled)
  const events = runEvents(settled)
  await gateState()
  const completions = events.filter(event => event.type === 'run.completed')
  const stopped = fixture.scenario === 'fixture-completion-stop'
  verify('Authoritative run and task states converge without a fresh-workspace retry', () => {
    assert.equal(run.status, stopped ? 'cancelled' : 'completed')
    assert.equal(settled.snapshot.tasks.find(task => task.id === run.task_id).status, run.status)
    assert.equal(settled.snapshot.runs.filter(item => item.task_id === run.task_id).length, 1)
    assert.equal(run.workspace_disposition, removal ? 'removed' : 'preserved')
    assert.equal(completions.length, stopped ? 0 : 1)
    if (!stopped) assert.equal(completions[0].id, report.gate.completion.event_id)
  })
  if (stopped) {
    verify('Committed stop rejects completion and has an applied durable runner acknowledgment', () => {
      assert.equal(run.breaker_stage, 'stop')
      assert.equal(report.gate.receipt, null)
      assert.equal(report.gate.acknowledgment?.applied, true)
      assert.ok(events.some(event => event.type === 'runner.command_acknowledged' &&
        event.payload.command_id === report.gate.hard_stop.command_id))
      assert.ok(!events.some(event => event.type === 'run.workspace_removed'))
    })
  } else if (fixture.scenario === 'fixture-completion-legacy') {
    verify('Completion without an explicit receipt request emits no new server message', () => {
      assert.equal(report.gate.completion.request_forwarded, false)
      assert.equal(report.gate.receipt, null)
      assert.equal(report.gate.unconfirmed_failure?.kind, 'completion_unconfirmed')
    })
  } else {
    verify('Real server receipt matches the exact committed event and every assignment fence', () => {
      assert.equal(report.gate.receipt?.scope_matches, true)
      assert.equal(report.gate.receipt.event_id, completions[0].id)
      assert.equal(report.gate.receipt.run_id, run.id)
      assert.equal(report.gate.receipt.withheld, !removal)
    })
  }
  if (removal) {
    await assert.rejects(stat(report.workspace_path), { code: 'ENOENT' })
    verify('Accepted receipt permits clean workspace removal', () => {
      assert.equal(report.gate.unconfirmed_failure, null)
      assert.ok(events.some(event => event.type === 'run.workspace_removed'))
    })
  } else {
    await stat(report.workspace_path)
    verify('Clean retained source remains at the original commit', cleanWorkspace)
  }
  if (!stopped && !removal) {
    const elapsed = Date.parse(report.gate.unconfirmed_failure.observed_at) - Date.parse(report.gate.completion.received_at)
    report.receipt_timeout_ms = elapsed
    verify('Missing receipt is bounded and cannot undo committed completion', () => {
      assert.ok(elapsed >= 29_000 && elapsed <= 50_000)
      assert.ok(!events.some(event => event.type === 'run.failed'))
    })
  }
  report.run = { id: run.id, task_id: run.task_id, status: run.status,
    workspace_disposition: run.workspace_disposition, breaker_stage: run.breaker_stage }
  report.events = events.filter(event => ['run.verification_passed', 'run.completed', 'run.cancelled',
    'run.workspace_removed', 'run.workspace_preserved', 'runner.command_acknowledged'].includes(event.type))
    .map(event => ({ id: event.id, type: event.type, aggregate_id: event.aggregate_id }))
  await page.goto(`${web}/#missions`, { waitUntil: 'networkidle' })
  await page.locator('.live-indicator.live-live').waitFor()
  await page.getByRole('button').filter({ hasText: report.title }).click()
  await page.locator(`[data-mission-id="${report.mission_id}"]`).waitFor()
  await page.screenshot({ path: path.join(fixture.output, 'browser-completion-settled.png'), fullPage: true })
  verify('Browser has no page errors', () => assert.deepEqual(pageErrors, []))
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'
  report.failure = error.message
  if (page) await page.screenshot({ path: path.join(fixture.output, 'browser-failure.png'), fullPage: true }).catch(() => {})
  if (report.run_id) {
    try {
      const run = runView(await snapshot())
      if (run && !terminal(run)) {
        await request(server, api(`/agents/${run.agent_id}/emergency-stop`), {
          actor_id: demo.alice_actor_id, reason: 'Owned completion acceptance failed; stop this exact run.',
        })
        await waitFor(snapshot, state => terminal(runView(state)), 20_000)
      }
    } catch (cleanupError) { report.failure_stop_error = cleanupError.message }
  }
} finally {
  await gateState().catch(() => {})
  if (lastState && report.run_id) {
    const run = runView(lastState)
    report.last_observation = { status: run?.status, workspace_disposition: run?.workspace_disposition,
      events: runEvents(lastState).map(event => ({ id: event.id, type: event.type })) }
  }
  if (browser) await browser.close().catch(error => { report.status = 'failed'; report.browser_close_error = error.message })
  report.finished_at = new Date().toISOString()
  report.counts = { passed: report.assertions.filter(item => item.passed).length,
    failed: report.assertions.filter(item => !item.passed).length }
  await save()
  console.log(JSON.stringify({ scenario: report.scenario, status: report.status, counts: report.counts,
    run_id: report.run_id, failure: report.failure }))
  process.exitCode = report.status === 'passed' ? 0 : 1
}
