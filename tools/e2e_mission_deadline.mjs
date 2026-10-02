// Explicit owned-stack browser -> server -> native runner acceptance for #298.
// Importing this module is inert. Deterministic transport is not provider proof.
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { captureOwnedTestServerManifest } from './owned_test_stack.mjs'

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const terminal = run => ['completed', 'cancelled', 'failed', 'lost'].includes(run?.status)
const timestamp = value => {
  const time = Date.parse(value)
  assert.ok(Number.isFinite(time), 'Missing or invalid recorded timestamp')
  return time
}
const inside = (root, value) => {
  assert.ok(path.isAbsolute(value), 'An absolute owned path is required')
  const relative = path.relative(root, value)
  assert.ok(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative), 'Path must be inside the owned fixture')
  return value
}
function loopback(value) {
  const url = new URL(value)
  assert.equal(url.protocol, 'http:')
  assert.equal(url.hostname, '127.0.0.1')
  assert.ok(Number(url.port) >= 10000 && !url.username && !url.password && !url.search && !url.hash)
  assert.equal(url.pathname, '/')
  return url.origin
}

export function validateDeadlineFixture(setup, optIn) {
  assert.equal(optIn, '1', 'Explicit ECORP_MISSION_DEADLINE_TEST=1 is required')
  assert.equal(setup.test_owned, true)
  assert.equal(setup.provider_fixture, 'deadline-complete-after-stop')
  for (const key of ['qa_root', 'repository', 'source']) assert.ok(path.isAbsolute(setup[key] ?? ''))
  assert.match(path.basename(setup.qa_root), /^issue224-planned-attempts-[a-zA-Z0-9-]*issue298[a-zA-Z0-9-]*$/u)
  assert.equal(path.basename(path.dirname(setup.qa_root)), 'qa')
  assert.equal(path.resolve(setup.source), path.join(path.resolve(setup.qa_root), 'source'))
  inside(setup.qa_root, setup.source)
  const productRelative = path.relative(setup.repository, setup.qa_root)
  assert.ok(productRelative.startsWith(`..${path.sep}`) || path.isAbsolute(productRelative),
    'The test source and database must be outside the product checkout')
  assert.equal(setup.source_repository, 'ecorp-fixture/planned-attempts-fixture')
  assert.match(setup.source_commit ?? '', /^[0-9a-f]{40}$/u)
  assert.match(setup.source_binding?.source_fingerprint ?? '', /^[0-9a-f]{64}$/u)
  assert.equal(setup.runner_id, 'issue224-planned-qa')
  for (const key of ['corp_id', 'alice_actor_id']) assert.match(setup.demo?.[key] ?? '', uuid)
  const server = loopback(setup.server_url), web = loopback(setup.web_url)
  assert.notEqual(server, web)
  for (const role of ['server', 'web']) {
    const owned = setup.processes?.[role]
    assert.ok(Number.isSafeInteger(owned?.pid) && owned.pid > 1)
    assert.ok(path.isAbsolute(owned.executable))
    timestamp(owned.started_utc)
  }
  return { server, web }
}

async function canonicalDirectory(value) {
  const declared = path.resolve(value)
  const info = await lstat(declared)
  assert.ok(info.isDirectory() && !info.isSymbolicLink(), 'Fixture directory must not be a link')
  const canonical = path.resolve(await realpath(declared))
  assert.equal(canonical, declared, 'Fixture directory must not use an alias or reparse path')
  return canonical
}

export async function validateDeadlineFixturePaths(setup) {
  // Derive identity from this module, never from a receipt's assertion alone.
  const actualRepository = await canonicalDirectory(path.resolve(import.meta.dirname, '..'))
  const repository = await canonicalDirectory(setup.repository)
  assert.equal(repository, actualRepository, 'Receipt must identify the actual product checkout')
  const qa = await canonicalDirectory(setup.qa_root)
  const source = await canonicalDirectory(setup.source)
  const contains = (root, target) => {
    const relative = path.relative(root, target)
    return !relative || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  }
  for (const fixture of [qa, source]) {
    assert.ok(!contains(repository, fixture) && !contains(fixture, repository),
      'Owned fixture and actual product checkout must be disjoint')
  }
  assert.equal(source, path.join(qa, 'source'))
  // Check the existing parent before any output directory is created. A linked
  // evidence directory must not redirect even an otherwise safe owned fixture.
  const evidence = await canonicalDirectory(path.join(qa, 'evidence'))
  inside(qa, evidence)
  const output = inside(evidence, path.join(evidence, 'mission-deadline'))
  await assert.rejects(lstat(output), { code: 'ENOENT' }, 'Each fixture requires a new output directory')
  return output
}

export function assertCancelledDeadlineRun(run, events) {
  assert.equal(run.status, 'cancelled')
  assert.equal(run.workspace_disposition, 'preserved')
  assert.equal(run.artifact_id, null)
  assert.ok(!events.some(event => ['run.artifact', 'run.artifact_upload', 'run.verification_started',
    'run.verification_passed', 'run.completed'].includes(event.type)), 'Hard stop must not accept completion evidence')
  const controls = events.filter(event => event.type === 'run.control_observed')
  const phase = name => controls.find(event => event.payload.phase === name)
  const received = controls.find(event => event.payload.phase === 'adapter_received' && event.payload.detail.directive === 'stop')
  const native = phase('native_terminal')
  const stopped = events.find(event => event.type === 'run.session_terminated')
  assert.ok(received && phase('interrupt_queued') && phase('interrupt_written'))
  assert.equal(received.payload.detail.interrupt_grace_ms, 2000)
  assert.equal(received.payload.detail.deadline_extended, false)
  assert.equal(native?.payload.detail.status, 'completed', 'The adversarial transport must actually report late success')
  assert.equal(native.payload.detail.after_adapter_control, true)
  assert.ok(timestamp(native.payload.observed_at) >= timestamp(received.payload.observed_at))
  assert.equal(stopped?.payload.provider_process_alive, false)
  assert.equal(stopped.payload.adapter, 'codex')
  assert.ok(phase('process_terminated'))
  return { received, native, terminated: phase('process_terminated') }
}

export async function runDeadlineAcceptance(setupPath, optIn) {
  assert.ok(path.isAbsolute(setupPath ?? ''), 'An explicit setup receipt is required')
  const setup = JSON.parse((await readFile(setupPath, 'utf8')).replace(/^\uFEFF/u, ''))
  const { server, web } = validateDeadlineFixture(setup, optIn)
  const output = await validateDeadlineFixturePaths(setup)
  await mkdir(output, { recursive: false }) // Failed attempts are never replaced.
  const reportPath = path.join(output, 'report.json')
  const report = { schema_version: 1, issue: 298, status: 'running', started_at: new Date().toISOString(),
    source_binding: setup.source_binding, server, web, corp_id: setup.demo.corp_id, runner_id: setup.runner_id,
    checks: [], screenshots: [], scenarios: [], http_results: [], blocked_requests: [], page_errors: [],
    scope: 'Actual Edge, owned PostgreSQL/server/runner and deterministic native Codex transport. Queue expiry, explicit reserve failure and late-success cancellation. No production authentication, real-provider inference, historical R4 reproduction or independent acceptance.' }
  const save = () => writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  const check = (name, fn, details = {}) => {
    try { fn(); report.checks.push({ name, passed: true, ...details }) }
    catch (error) { report.checks.push({ name, passed: false, error: error.message }); throw error }
  }
  const api = suffix => `/api/corps/${setup.demo.corp_id}${suffix}`
  async function request(route, body, expected = [200]) {
    assert.ok(route.startsWith(api('/')), 'Only the owned Corp API is allowed')
    const response = await fetch(server + route, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error', signal: AbortSignal.timeout(15000) })
    const result = await response.json()
    if (body !== undefined || !expected.includes(response.status)) report.http_results.push({ route,
      method: body === undefined ? 'GET' : 'POST', status: response.status, expected })
    assert.ok(expected.includes(response.status), `${route}: unexpected HTTP ${response.status}`)
    return { status: response.status, body: result }
  }
  let lastState, browser, page, currentScenario
  let phase = 'owned stack identity'
  const snapshot = async () => (lastState = (await request(api(`/snapshot?actor_id=${setup.demo.alice_actor_id}`))).body)
  const missionView = (state, scenario) => state.snapshot.missions.find(row => row.id === scenario.mission_id)
  const taskViews = (state, scenario) => state.snapshot.tasks.filter(row => row.mission_id === scenario.mission_id)
  const runViews = (state, scenario) => {
    const ids = new Set(taskViews(state, scenario).map(row => row.id))
    return state.snapshot.runs.filter(row => ids.has(row.task_id))
  }
  const missionEvents = (state, scenario) => state.snapshot.events.filter(row => row.aggregate_id === scenario.mission_id)
  async function until(label, predicate, milliseconds = 30_000) {
    const cutoff = Date.now() + milliseconds
    while (Date.now() < cutoff) {
      const state = await snapshot()
      if (await predicate(state)) return state
      await delay(200)
    }
    throw new Error(`Timed out waiting for ${label}`)
  }
  async function screenshot(name) {
    const file = path.join(output, `${name}.png`)
    await page.screenshot({ path: file, fullPage: true })
    report.screenshots.push({ file, sha256: hash(await readFile(file)) })
  }
  async function showMission(scenario) {
    await page.goto(`${web}/#missions`, { waitUntil: 'networkidle' })
    await page.locator('.live-indicator.live-live').waitFor()
    const card = page.locator(`[data-mission-id="${scenario.mission_id}"]`)
    if (!(await card.isVisible())) await page.getByRole('button').filter({ hasText: scenario.title }).click()
    await card.waitFor()
    return card
  }
  async function savePlan(strategy, allowanceSeconds, reserveSeconds = 0) {
    phase = `browser saves ${strategy} deadline plan`
    const scenario = { strategy, title: `Owned deadline ${strategy} ${randomUUID()}` }
    report.scenarios.push(scenario); currentScenario = scenario
    if (!(await page.locator('#mission-title').isVisible())) await page.getByRole('button', { name: 'New mission', exact: true }).click()
    await page.locator('#mission-title').fill(scenario.title)
    const specification = page.locator('details.mission-advanced-options').filter({ has: page.locator('#mission-description') })
    if (!(await specification.evaluate(element => element.open))) await specification.locator(':scope > summary').click()
    await page.locator('#mission-description').fill('Owned deterministic deadline cancellation acceptance. [deadline-complete-after-stop] No network or publication; retain interrupted work.')
    const target = await page.locator('#mission-repository option').evaluateAll((options, name) => options.find(option => option.textContent.includes(name))?.value, setup.source_repository)
    assert.ok(target, 'The connected runner must offer the exact owned synthetic source')
    await page.locator('#mission-repository').selectOption(target)
    await page.getByRole('checkbox', { name: /Confirm this target/u }).check()
    await page.locator('#mission-adapter').selectOption('codex')
    await page.locator('#mission-strategy').selectOption(strategy)
    const advanced = page.locator('details.mission-advanced-options').filter({ has: page.locator('#mission-budget') })
    if (!(await advanced.evaluate(element => element.open))) await advanced.locator(':scope > summary').click()
    await page.getByRole('checkbox', { name: /Save without starting/u }).check()
    // The browser context is explicitly UTC; no host timezone or DST inference.
    scenario.deadline_at = new Date(Math.ceil(Date.now() / 1000) * 1000 + allowanceSeconds * 1000).toISOString()
    scenario.reserve = reserveSeconds ? { seconds: reserveSeconds, task_keys: ['synthesis'] } : null
    scenario.task_cutoff = new Date(timestamp(scenario.deadline_at) - reserveSeconds * 1000).toISOString()
    await page.locator('#mission-deadline').fill(scenario.deadline_at.slice(0, 19))
    await page.locator('#mission-reserve-seconds').fill(reserveSeconds ? String(reserveSeconds) : '')
    await page.locator('#mission-reserve-keys').fill(reserveSeconds ? 'synthesis' : '')
    await page.getByRole('button', { name: 'Review and build', exact: true }).click()
    const preview = page.getByTestId('mission-allocation-preview')
    await until('matching server deadline preview', async () => await preview.getAttribute('data-preview-status') === 'ready')
    const confirmed = preview.getByTestId('mission-deadline-readback')
    const previewDeadline = await confirmed.getAttribute('data-mission-deadline')
    const previewState = await confirmed.getAttribute('data-deadline-state')
    check(`${strategy}: server preview echoes the declared cutoff`, () => {
      assert.equal(previewState, 'saved')
      assert.equal(timestamp(previewDeadline), timestamp(scenario.deadline_at))
    })
    const createdWait = page.waitForResponse(response => response.url() === server + api('/missions') && response.request().method() === 'POST')
    await page.getByRole('button', { name: 'Save plan', exact: true }).click()
    const createdResponse = await createdWait
    assert.equal(createdResponse.status(), 200)
    const created = await createdResponse.json()
    scenario.mission_id = created.mission_id
    assert.match(scenario.mission_id, uuid)
    scenario.browser_saved_at = new Date().toISOString()
    await save()
    const state = await until('durable saved mission', state => Boolean(missionView(state, scenario)))
    const mission = missionView(state, scenario), tasks = taskViews(state, scenario)
    check(`${strategy}: browser creation persists one immutable policy without launching`, () => {
      assert.equal(mission.status, 'ready')
      assert.equal(tasks.length, strategy === 'single' ? 1 : 3)
      assert.equal(timestamp(mission.deadline.deadline_at), timestamp(scenario.deadline_at))
      assert.deepEqual(mission.deadline.reserve ?? null, scenario.reserve)
      assert.ok(tasks.every(task => timestamp(task.contract.deadline_at) === timestamp(scenario.deadline_at)))
      assert.equal(runViews(state, scenario).length, 0)
    })
    scenario.saved_mission = mission; scenario.saved_tasks = tasks
    return scenario
  }
  async function assertReadbacks(scenario, state) {
    const card = await showMission(scenario)
    await card.locator('.mission-card-top .status-chip-failed').waitFor()
    const graph = card.locator('details').filter({ has: page.locator('.task-graph-list') }).first()
    if (!(await graph.evaluate(element => element.open))) await graph.locator(':scope > summary').click()
    for (const task of taskViews(state, scenario)) {
      const item = card.locator(`[data-task-id="${task.id}"]`)
      if (!(await item.evaluate(element => element.open))) await item.locator(':scope > summary').click()
      const readback = item.getByTestId('mission-deadline-readback')
      assert.equal(await readback.getAttribute('data-deadline-state'), 'saved')
      assert.equal(timestamp(await readback.getAttribute('data-mission-deadline')), timestamp(scenario.deadline_at))
      const cutoff = scenario.reserve && !scenario.reserve.task_keys.includes(task.plan_key) ? scenario.task_cutoff : scenario.deadline_at
      assert.equal(timestamp(await readback.getAttribute('data-task-deadline')), timestamp(cutoff))
      assert.match(await item.locator(':scope > summary').innerText(), /cancelled/iu)
    }
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 })
      await delay(150)
      const layout = await page.evaluate(() => ({ client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }))
      check(`${scenario.strategy}: persisted failed/cancelled deadline readback at ${width}`, () => {
        assert.equal(layout.client, width); assert.equal(layout.scroll, width)
      }, layout)
      await screenshot(`${scenario.strategy}-${width}`)
    }
    await page.setViewportSize({ width: 1440, height: 1000 })
  }
  try {
    await save()
    for (const [role, url] of [['server', server], ['web', web]]) {
      const owned = setup.processes[role]
      const live = await captureOwnedTestServerManifest({ root: setup.qa_root, server: url,
        binary: owned.executable, pid: owned.pid, pidPath: path.join(output, `${role}-ownership.json`) })
      assert.ok(Math.abs(timestamp(live.server_creation) - timestamp(owned.started_utc)) <= 20)
    }
    const before = await snapshot()
    assert.equal(before.snapshot.missions.length, 0); assert.equal(before.snapshot.runs.length, 0)
    const runner = before.runners.find(row => row.id === setup.runner_id && row.corp_id === setup.demo.corp_id && row.connected)
    assert.ok(runner)
    assert.ok(JSON.stringify(runner.capabilities).includes('mission-deadline-v1'))
    report.initial_state = { missions: 0, runs: 0, runner }
    const { chromium } = createRequire(import.meta.url)(process.env.CRONY_PLAYWRIGHT_MODULE || 'playwright')
    browser = await chromium.launch({ channel: 'msedge', headless: true })
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: 'UTC', reducedMotion: 'reduce', serviceWorkers: 'block' })
    await context.route('**/*', async route => {
      const req = route.request(), url = new URL(req.url()), method = req.method()
      const read = ['GET', 'HEAD', 'OPTIONS'].includes(method)
      const bootstrap = url.origin === server && url.pathname === '/api/demo/bootstrap' && method === 'POST' && url.searchParams.get('seed_crew') === 'false'
      const missionWrite = url.origin === server && method === 'POST' && currentScenario &&
        (([api('/missions'), api('/missions/preview')].includes(url.pathname) && req.postDataJSON()?.title === currentScenario.title) ||
          (currentScenario.mission_id && url.pathname === api(`/missions/${currentScenario.mission_id}/launch`)))
      if (![server, web].includes(url.origin) || (!read && !bootstrap && !missionWrite)) {
        report.blocked_requests.push({ method, origin: url.origin, path: url.pathname }); await route.abort(); return
      }
      await route.continue()
    })
    page = await context.newPage(); page.setDefaultTimeout(20_000)
    page.on('pageerror', error => report.page_errors.push(error.message.slice(0, 1000)))
    await page.goto(`${web}/#missions`, { waitUntil: 'networkidle' })
    await page.locator('.live-indicator.live-live').waitFor()
    await page.locator('#operator-actor').selectOption(setup.demo.alice_actor_id)
    const queued = await savePlan('single', 20)
    phase = 'queued plan consumes the original allowance'
    let state = await until('queued mission deadline expiry', state => missionEvents(state, queued).some(event => event.type === 'mission.deadline_expired'), 40_000)
    const expired = missionEvents(state, queued).filter(event => event.type === 'mission.deadline_expired')
    check('Queued expiry cancels tasks without creating a run or physical-stop claim', () => {
      assert.equal(missionView(state, queued).status, 'failed')
      assert.ok(taskViews(state, queued).every(task => task.status === 'cancelled'))
      assert.equal(runViews(state, queued).length, 0)
      assert.equal(expired.length, 1)
      assert.equal(expired[0].payload.physical_stop_confirmed, false)
      assert.equal(expired[0].payload.budget_reset, false)
      assert.ok(timestamp(expired[0].payload.admitted_at) >= timestamp(queued.deadline_at))
    })
    queued.expiry_event = expired[0]
    queued.expired_launch = await request(api(`/missions/${queued.mission_id}/launch`), { requested_by: setup.demo.alice_actor_id }, [400, 409])
    state = await snapshot()
    check('Expired dispatch cannot start later or renew the saved cutoff', () => {
      assert.equal(runViews(state, queued).length, 0)
      assert.equal(timestamp(missionView(state, queued).deadline.deadline_at), timestamp(queued.deadline_at))
    })
    await assertReadbacks(queued, state); await save()
    const reserved = await savePlan('parallel-specialists', 75, 30)
    phase = 'queued reserved plan retains its earlier specialist cutoff'
    await delay(4000)
    state = await snapshot()
    assert.equal(runViews(state, reserved).length, 0)
    const card = await showMission(reserved)
    const launchWait = page.waitForResponse(response => response.url() === server + api(`/missions/${reserved.mission_id}/launch`) && response.request().method() === 'POST')
    reserved.browser_launch_at = new Date().toISOString()
    await card.getByTestId('work-result-card').getByRole('button', { name: 'Start mission', exact: true }).click()
    const launch = await launchWait
    assert.equal(launch.status(), 200); reserved.launch_response = await launch.json(); await save()
    state = await until('two active isolated specialist turns', state => {
      const runs = runViews(state, reserved)
      assert.ok(!runs.some(terminal), 'A specialist terminated before the deadline scenario was established')
      return runs.length === 2 && runs.every(run => run.status === 'running' && run.provider_session_id && run.workspace_path)
    })
    reserved.started_runs = runViews(state, reserved)
    const keys = new Map(taskViews(state, reserved).map(task => [task.id, task.plan_key]))
    check('Reserved mission launches only its two parents after real queue delay', () => {
      assert.deepEqual(reserved.started_runs.map(run => keys.get(run.task_id)).sort(), ['specialist-a', 'specialist-b'])
      assert.ok(timestamp(reserved.browser_launch_at) - timestamp(reserved.browser_saved_at) >= 3900)
      assert.ok(timestamp(reserved.task_cutoff) - Date.now() >= 5000, 'Owned scenario needs enough time to observe both parents')
    })
    for (const run of reserved.started_runs) {
      inside(setup.qa_root, await realpath(run.workspace_path))
      assert.notEqual(path.resolve(run.workspace_path), path.resolve(setup.source))
      assert.equal(await readFile(path.join(run.workspace_path, 'base.txt'), 'utf8'), 'base\n')
    }
    await screenshot('parallel-running-before-cutoff'); await save()
    phase = 'deadline interrupts native turns and rejects late success'
    state = await until('cancelled runs, terminated provider sessions and expired reserve contract', state => {
      const runs = runViews(state, reserved)
      return runs.length === 2 && runs.every(run => terminal(run) && run.workspace_disposition === 'preserved' &&
        state.snapshot.events.some(event => event.aggregate_id === run.id && event.type === 'run.session_terminated')) &&
        missionEvents(state, reserved).some(event => event.type === 'mission.deadline_expired')
    }, 75_000)
    // Persist the actual observations, including any durable stop dispatch/ack.
    reserved.final_runs = runViews(state, reserved); reserved.final_tasks = taskViews(state, reserved)
    reserved.events = state.snapshot.events.filter(event => event.aggregate_id === reserved.mission_id || reserved.final_runs.some(run => run.id === event.aggregate_id))
    for (const run of reserved.final_runs) {
      const events = reserved.events.filter(event => event.aggregate_id === run.id)
      check(`${keys.get(run.task_id)}: native late success remains cancelled with no accepted completion`, () => {
        const observations = assertCancelledDeadlineRun(run, events)
        if (process.platform === 'win32') assert.equal(observations.terminated.payload.detail.scope, 'windows_job_object')
        assert.ok(timestamp(observations.received.payload.observed_at) >= timestamp(reserved.task_cutoff) - 1000)
        assert.ok(timestamp(observations.terminated.payload.observed_at) - timestamp(observations.received.payload.observed_at) <= 10_000)
      })
      assert.equal(run.workspace_path, reserved.started_runs.find(item => item.id === run.id).workspace_path)
      inside(setup.qa_root, await realpath(run.workspace_path))
      assert.equal(await readFile(path.join(run.workspace_path, 'base.txt'), 'utf8'), 'base\n')
      // The local monotonic timer may win before the sweep queues a Stop. Never
      // fabricate a dispatch receipt, or require a duplicate stop in that case.
      const requested = events.filter(event => event.type === 'run.stop_requested' && event.payload.cause === 'mission_deadline_expired')
      for (const stop of requested) {
        assert.equal(stop.payload.physical_stop_confirmed, false)
        assert.match(stop.payload.command_id, uuid)
      }
    }
    const reserveExpiry = missionEvents(state, reserved).filter(event => event.type === 'mission.deadline_expired')
    check('Unfinished parents explicitly fail the reserve contract without starting synthesis or resetting time', () => {
      assert.equal(missionView(state, reserved).status, 'failed')
      assert.ok(reserved.final_tasks.every(task => task.status === 'cancelled'))
      assert.equal(reserved.final_runs.length, 2)
      assert.ok(!reserved.final_runs.some(run => keys.get(run.task_id) === 'synthesis'))
      assert.equal(reserveExpiry.length, 1)
      assert.equal(reserveExpiry[0].payload.physical_stop_confirmed, false)
      assert.equal(reserveExpiry[0].payload.budget_reset, false)
      assert.ok(timestamp(reserveExpiry[0].payload.admitted_at) >= timestamp(reserved.task_cutoff))
      assert.ok(timestamp(reserveExpiry[0].payload.admitted_at) < timestamp(reserved.deadline_at))
      assert.deepEqual(missionView(state, reserved).deadline, reserved.saved_mission.deadline)
    })
    await assertReadbacks(reserved, state)
    state = await snapshot()
    check('The fixture created exactly its two missions and no extra runs or browser errors', () => {
      assert.equal(state.snapshot.missions.length, 2); assert.equal(state.snapshot.runs.length, 2)
      assert.deepEqual(report.page_errors, []); assert.deepEqual(report.blocked_requests, [])
    })
    report.status = 'passed'
  } catch (error) {
    report.status = 'failed'; report.failed_phase = phase; report.error = String(error.message).slice(0, 2000)
    if (page) await screenshot('failed-phase').catch(() => {})
    // Stop only a new fixture run still named by its exact agent lease. Never
    // adopt another agent's current run or reset the development database.
    report.failure_stops = []
    try {
      const state = await snapshot()
      for (const scenario of report.scenarios.filter(item => item.mission_id)) {
        for (const run of runViews(state, scenario).filter(run => !terminal(run))) {
          const fresh = await snapshot()
          if (terminal(fresh.snapshot.runs.find(row => row.id === run.id))) continue
          const agent = fresh.snapshot.agents.find(row => row.id === run.agent_id)
          if (agent?.current_run_id !== run.id) throw new Error('Owned run is no longer the current agent lease; preserve it for inspection')
          report.failure_stops.push({ run_id: run.id, result: await request(api(`/agents/${run.agent_id}/emergency-stop`), {
            actor_id: setup.demo.alice_actor_id, reason: 'Owned deadline acceptance failed; stop this exact fixture run.' }) })
        }
      }
      if (report.failure_stops.length) await until('owned failure stops', state => report.failure_stops.every(stop => {
        const run = state.snapshot.runs.find(row => row.id === stop.run_id)
        return terminal(run) && run.workspace_disposition === 'preserved'
      }), 30_000)
    } catch (cleanupError) { report.failure_stop_error = String(cleanupError.message).slice(0, 1000) }
  } finally {
    if (lastState) report.final_snapshot = lastState
    if (browser) await browser.close().catch(error => { report.status = 'failed'; report.browser_close_error = error.message })
    report.finished_at = new Date().toISOString()
    report.counts = { passed: report.checks.filter(check => check.passed).length, failed: report.checks.filter(check => !check.passed).length }
    await save()
    console.log(JSON.stringify({ status: report.status, counts: report.counts, report: reportPath, failed_phase: report.failed_phase, error: report.error }))
  }
  return report
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = await runDeadlineAcceptance(process.env.ECORP_MISSION_DEADLINE_SETUP, process.env.ECORP_MISSION_DEADLINE_TEST)
  process.exitCode = result.status === 'passed' ? 0 : 1
}
