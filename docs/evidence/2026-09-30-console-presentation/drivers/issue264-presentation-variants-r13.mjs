// Explicit synthetic UI states. All server HTTP and WebSocket traffic is intercepted.
// These cases never authorize an action or create native evidence.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { createPresentationChecks } from './issue264-presentation-browser-r12.mjs'

export async function exercisePresentationVariants({ browser, expect, qa, server, web, demo, mid, snapshot, report, save, check }) {
  const native = structuredClone(snapshot), prefix = `/api/corps/${demo.corp_id}`
  const olderId = report.native_roots[0].id, quarantineId = report.native_roots[1].id
  const newestId = report.native_source.run_id
  const nativeMission = native.snapshot.missions.find((mission) => mission.id === mid)
  const nativeItem = native.snapshot.factory_work_items.find((item) => item.mission_id === mid)
  assert.ok(nativeMission && nativeItem, 'The owned completed mission must retain its exact Factory linkage')
  assert.equal(nativeMission.corp_id, demo.corp_id); assert.equal(nativeMission.room_id, demo.room_id)
  assert.equal(nativeItem.corp_id, demo.corp_id)
  const sourceRepository = nativeItem.source_repository_owner + '/' + nativeItem.source_repository_name
  const selectionKey = 'ecorp:work-selection:v1:' + JSON.stringify([server, demo.corp_id, demo.alice_actor_id])
  const variants = report.presentation_variants = {
    scope: 'Synthetic snapshot, stale clock, production connection and transport fixtures in isolated browser contexts. Every server request is intercepted. No production authentication, native decision, signature or database change is established by these cases.',
    cases: {}, requests: [], unexpected: [], screenshots: {}, native_mutations: 0, errors: [],
    read_fixtures: {
      scope: 'Synthetic read-only metadata for this exact Corp, room, Alice actor, mission and Factory work item. Delegated operations and saved connections are empty; no publication is claimed. These fixtures establish neither native persistence nor production authorization.',
      responses: { delegated: 0, connections: 0, mission_context: 0, publication_context: 0 },
    },
  }
  const record = (name, value = true) => { variants.cases[name] = value; save(); check('synthetic_presentation_' + name, value) }
  const cors = { 'access-control-allow-origin': web, 'access-control-allow-headers': 'content-type, authorization',
    'access-control-allow-methods': 'GET, POST, OPTIONS', 'cache-control': 'no-store' }

  async function session(name, production = false) {
    const child = variants[name] = { screenshots: {} }
    const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, reducedMotion: 'reduce', serviceWorkers: 'block' })
    const state = { name, response: structuredClone(native), status: 200, holdSnapshot: false, holds: new Set() }
    await context.addInitScript(({ key, choice }) => {
      localStorage.setItem('ecorp.console.theme', 'light')
      localStorage.setItem('ecorp.console.mode', 'operations')
      sessionStorage.setItem(key, JSON.stringify(choice))
    }, { key: selectionKey, choice: { missionId: mid, taskId: report.native_source.task_id, runId: newestId } })
    await context.route('**/*', async (route) => {
      const request = route.request(), url = new URL(request.url())
      if (url.origin === web && ['GET', 'HEAD'].includes(request.method())) return route.continue()
      if (url.origin !== server) {
        variants.unexpected.push({ case: state.name, method: request.method(), origin: url.origin, path: url.pathname }); save()
        return route.abort()
      }
      // Never record headers, authorization values, bodies or ticket query parameters.
      variants.requests.push({ case: state.name, method: request.method(), path: url.pathname, intercepted: true }); save()
      const json = (status, value) => route.fulfill({ status, headers: cors, contentType: 'application/json', body: JSON.stringify(value) })
      if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
      if (url.pathname === '/health' && request.method() === 'GET') return json(200, { status: 'ok', mode: production ? 'production' : 'development' })
      if (!production && url.pathname === '/api/demo/bootstrap' && request.method() === 'POST') return json(200, demo)
      if (url.pathname === prefix + '/snapshot' && request.method() === 'GET') {
        if (state.holdSnapshot) {
          await new Promise((release) => state.holds.add(release))
          try { return await route.abort() } catch { return }
        }
        return json(state.status, state.status === 200 ? state.response : { error: 'Synthetic control-plane response unavailable' })
      }
      // Match the actual read contracts and exact owned identities. Never pass
      // these synthetic requests through to the native control plane.
      const scopedRead = request.method() === 'GET' &&
        url.searchParams.getAll('actor_id').length === 1 &&
        url.searchParams.get('actor_id') === demo.alice_actor_id &&
        [...url.searchParams.keys()].every((key) => key === 'actor_id')
      const readFixture = (kind, value) => {
        variants.read_fixtures.responses[kind]++; save()
        return json(200, value)
      }
      if (scopedRead && url.pathname === prefix + '/delegated') {
        return readFixture('delegated', { provider: 'entra', enabled: false, operations: [] })
      }
      if (scopedRead && url.pathname === prefix + `/rooms/${demo.room_id}/connections`) {
        return readFixture('connections', { connections: [], operations: [], selected_connection_id: null })
      }
      if (scopedRead && url.pathname === prefix + `/missions/${mid}/context`) {
        return readFixture('mission_context', {
          corp_id: demo.corp_id, actor_id: demo.alice_actor_id, mission_id: mid, room_id: demo.room_id,
          origin: { kind: 'factory', work_item_id: nativeItem.id, source_repository: sourceRepository,
            source_issue_number: nativeItem.source_issue_number, source_issue_url: nativeItem.source_issue_url },
        })
      }
      if (scopedRead && url.pathname === prefix + `/factory/work-items/${nativeItem.id}/publication-context`) {
        return readFixture('publication_context', {
          work_item: structuredClone(nativeItem), publication: null, source_deliverables: [],
        })
      }
      if (production && url.pathname === prefix + '/ws-ticket' && request.method() === 'POST') return json(200, { ticket: 'synthetic-unused-ticket' })
      variants.unexpected.push({ case: state.name, method: request.method(), origin: url.origin, path: url.pathname }); save()
      return json(501, { error: 'No synthetic response is defined for this request' })
    })
    await context.routeWebSocket('**/*', (socket) => {
      const url = new URL(socket.url())
      if (url.origin === server.replace(/^http/, 'ws') && url.pathname === `/ws/corps/${demo.corp_id}`) {
        socket.send(JSON.stringify({ type: 'ready', replayed_through: 0 }))
      } else if (url.origin === web.replace(/^http/, 'ws')) socket.connectToServer()
      else { variants.unexpected.push({ case: state.name, method: 'WEBSOCKET', origin: url.origin, path: url.pathname }); save(); socket.close() }
    })
    const page = await context.newPage()
    await page.clock.install()
    page.on('pageerror', (error) => { variants.errors.push({ case: state.name, error: error.message }); save() })
    const capture = async (label) => {
      const filename = `synthetic-${label}-${randomUUID().slice(0, 8)}.png`
      await page.screenshot({ path: join(qa, 'evidence', filename), fullPage: true })
      child.screenshots[label] = filename; variants.screenshots[label] = filename; save()
    }
    const presentation = createPresentationChecks({ browser, page, context, expect, qa, server, web, demo, mid,
      report: child, save, check: (label, value) => record(label, value), capture })
    child.presentation.scope = variants.scope
    const theme = async (value) => {
      await page.locator('#console-theme').selectOption(value)
      await expect(page.locator('html')).toHaveAttribute('data-theme', value)
    }
    const mode = async (value) => {
      await page.locator('#console-mode').selectOption(value)
      await expect(page.locator('html')).toHaveAttribute('data-presentation', value)
      if (!production) await expect(page.locator('.executive-dashboard')).toHaveCount(value === 'executive' ? 1 : 0)
    }
    const card = () => page.locator(`[data-mission-id="${mid}"]`)
    const executive = () => page.locator('.executive-dashboard')
    const selected = async (id) => {
      const run = state.response.snapshot.runs.find((item) => item.id === id)
      assert.ok(run)
      await expect(card()).toHaveAttribute('data-run-id', id)
      await expect(page.locator(`#mission-evidence-${mid}`)).toHaveValue(id)
      await expect.poll(() => page.evaluate((key) => JSON.parse(sessionStorage.getItem(key)), selectionKey))
        .toEqual({ missionId: mid, taskId: run.task_id, runId: id })
    }
    async function loadCase(label, change = () => {}) {
      assert.equal(state.holds.size, 0)
      state.name = label; state.response = structuredClone(native); state.status = 200; state.holdSnapshot = false
      change(state.response.snapshot)
      await page.goto(web + '/?presentation_case=' + encodeURIComponent(label) + '#missions', { waitUntil: 'networkidle' })
      if (!production) { await expect(page.locator('.live-live')).toBeVisible(); await expect(card()).toBeVisible() }
    }
    async function inspect(label, scope = '.app-shell', mobile = false) {
      await presentation.contrast(label, scope); await capture(label)
      if (mobile) await presentation.keyboardAndMobile('synthetic-' + label)
    }
    return { page, state, theme, mode, card, executive, selected, loadCase, inspect, presentation, capture,
      close: async () => { for (const release of state.holds) release(); state.holds.clear(); await context.close() } }
  }

  const development = await session('development')
  const { page, state, theme, mode, card, executive, selected, loadCase, inspect, presentation } = development
  // Native creation now leaves two additional completed missions. Synthetic
  // changes below target the original graph only; unrelated warnings are real
  // returned context and must remain visible rather than disappear from tests.
  const createdMissions = report.native_mission_creation.cases.map((item) => {
    assert.equal(item.status, 'passed')
    const mission = native.snapshot.missions.find((candidate) => candidate.id === item.mission_id)
    assert.ok(mission); assert.equal(mission.title, item.title)
    assert.notEqual(mission.id, mid)
    return mission
  })
  assert.equal(createdMissions.length, 2)
  assert.equal(native.snapshot.missions.length, 3)
  assert.equal(new Set(native.snapshot.missions.map((item) => item.title)).size, 3)
  for (const mission of native.snapshot.missions) {
    assert.equal(native.snapshot.missions.filter((item) => (item.title + ' · ').includes(mission.title + ' · ')).length, 1)
  }
  const allAlerts = () => executive().locator('.executive-attention li')
  const missionAlerts = (mission) => allAlerts().filter({ has: page.locator('strong').filter({ hasText: mission.title + ' · ' }) })
  const alerts = () => missionAlerts(nativeMission)
  const missionArticle = (mission) => executive().locator('.executive-mission').filter({
    has: page.getByRole('heading', { name: mission.title, exact: true }),
  })
  const originalArticle = () => missionArticle(nativeMission)
  async function assertUnchangedCreatedMissions() {
    await expect(executive().locator('.executive-mission')).toHaveCount(3)
    for (const mission of createdMissions) {
      const taskIds = new Set(native.snapshot.tasks.filter((task) => task.mission_id === mission.id).map((task) => task.id))
      const runs = native.snapshot.runs.filter((run) => taskIds.has(run.task_id))
      assert.equal(runs.length, 1); assert.equal(runs[0].status, 'completed')
      assert.equal(runs[0].cost_microusd, 0)
      await expect(missionArticle(mission)).toHaveCount(1)
      await expect(missionArticle(mission)).toContainText('Recorded: Completed')
      await expect(missionArticle(mission).getByRole('button', { name: 'Inspect exact run', exact: true })).toHaveCount(1)
      await expect(missionAlerts(mission).filter({ hasText: 'Cost assurance is incomplete' })).toHaveCount(1)
    }
  }
  try {
    await loadCase('older-failures-quarantine-and-exhaustion', (data) => {
      const older = data.runs.find((run) => run.id === olderId), quarantined = data.runs.find((run) => run.id === quarantineId)
      const review = data.verification_requests.find((item) => item.run_id === olderId)
      const evidence = data.verification_evidence.filter((item) => item.run_id === olderId)
      assert.ok(older && quarantined && review && evidence.length)
      older.status = 'failed'; older.verification_status = 'failed'; quarantined.workspace_disposition = 'quarantined'
      review.status = 'rejected'; review.decision_note = 'Synthetic rejected review for presentation coverage'
      evidence.forEach((item) => { item.status = 'failed'; item.summary = 'Synthetic failed check for presentation coverage' })
      const task = data.tasks.find((item) => item.id === older.task_id)
      task.status = 'verification_failed'; task.verification_status = 'failed'
      const mission = data.missions.find((item) => item.id === mid)
      assert.equal(mission.status, 'completed'); assert.equal(data.runs.find((item) => item.id === newestId).status, 'completed')
      for (const key of ['original_budget_tokens', 'budget_tokens', 'original_budget_cost_microusd', 'budget_cost_microusd']) mission[key] = 1
      data.runs.filter((run) => data.tasks.some((item) => item.id === run.task_id && item.mission_id === mid))
        .forEach((run) => { run.input_tokens = 100; run.output_tokens = 50; run.cost_microusd = 1000 })
    })
    for (const value of ['light', 'dark']) {
      await theme(value); await mode('executive')
      await expect(executive()).toContainText('Recorded: Completed')
      for (const text of ['A failed check remains in the evidence', 'A recorded decision was rejected', 'Source integrity is quarantined', 'A recorded budget ceiling is exhausted']) {
        await expect(alerts().filter({ hasText: text })).toHaveCount(1)
      }
      await inspect('critical-executive-' + value, '.app-shell', true)
      for (const [text, id] of [['A failed check remains in the evidence', olderId], ['A recorded decision was rejected', olderId], ['Source integrity is quarantined', quarantineId]]) {
        await alerts().filter({ hasText: text }).getByRole('button', { name: 'Inspect in Operations', exact: true }).click()
        await selected(id)
        await expect(card().getByTestId('run-activity-panel')).toHaveAttribute('data-run-id', id)
        await inspect('critical-operations-' + (id === olderId ? text.startsWith('A failed') ? 'failed' : 'rejected' : 'quarantined') + '-' + value)
        await mode('executive')
      }
      record('critical_alerts_and_exact_drilldowns_' + value, { older_failed_run: olderId, quarantined_run: quarantineId, newer_completed_run: newestId })
    }

    const revisionId = randomUUID()
    await loadCase('pending-review-and-budget-revision', (data) => {
      const older = data.runs.find((run) => run.id === olderId), review = data.verification_requests.find((item) => item.run_id === olderId)
      const mission = data.missions.find((item) => item.id === mid), task = data.tasks.find((item) => item.id === older.task_id)
      older.status = 'waiting_for_approval'; older.verification_status = 'pending'; task.status = 'review'; task.verification_status = 'pending'
      review.status = 'pending'; review.decided_by = null; review.decision_note = null
      mission.status = 'running'
      data.mission_budget_revisions.push({ id: revisionId, corp_id: demo.corp_id, mission_id: mid, proposed_by: demo.alice_actor_id,
        status: 'pending', version: 1, current_budget_tokens: mission.budget_tokens, current_budget_cost_microusd: mission.budget_cost_microusd,
        proposed_budget_tokens: mission.budget_tokens + 1000, proposed_budget_cost_microusd: mission.budget_cost_microusd + 1000,
        consumed_tokens_at_proposal: 0, consumed_cost_microusd_at_proposal: 0, rationale: 'Synthetic pending revision; no authority is granted',
        replacement_task_id: null, previous_contract: null, replacement_contract: null, previous_verification_policy: null,
        replacement_verification_policy: null, decided_by: null, decision_note: null, created_at: new Date().toISOString(), decided_at: null,
        updated_at: new Date().toISOString() })
    })
    for (const value of ['light', 'dark']) {
      await theme(value); await mode('executive')
      await expect(alerts().filter({ hasText: '1 budget requests need a decision' })).toHaveCount(1)
      await expect(alerts().filter({ hasText: 'Awaiting review' })).toHaveCount(1)
      await inspect('pending-executive-' + value)
      await alerts().filter({ hasText: 'Awaiting review' }).getByRole('button', { name: 'Inspect in Operations', exact: true }).click()
      await selected(olderId)
      await expect(card().getByRole('button', { name: 'Accept evidence', exact: true })).toBeDisabled()
      await expect(card().getByTestId('budget-revision-pending')).toContainText('Synthetic pending revision; no authority is granted')
      await inspect('pending-operations-' + value, '.app-shell', true)
      record('pending_decisions_without_authority_' + value, { run_id: olderId, budget_revision_id: revisionId, actual_decisions: 0 })
    }

    await loadCase('incomplete-history-and-unpriced-usage', (data) => {
      const first = data.runs.find((item) => item.id === olderId), second = data.runs.find((item) => item.id === quarantineId)
      first.input_tokens = 50; first.output_tokens = 25; first.cost_microusd = 0
      second.input_tokens = 0; second.output_tokens = 0; second.cost_microusd = 0
      data.tasks.find((item) => item.id === first.task_id).attempt_count = 12
    })
    for (const value of ['light', 'dark']) {
      await theme(value); await mode('executive')
      await expect(alerts().filter({ hasText: 'Run history or usage is incomplete' })).toHaveCount(1)
      await expect(alerts().filter({ hasText: 'Cost assurance is incomplete' })).toHaveCount(1)
      await expect(allAlerts().filter({ hasText: 'Cost assurance is incomplete' })).toHaveCount(3)
      await assertUnchangedCreatedMissions()
      await inspect('incomplete-history-executive-' + value)
      record('incomplete_and_unpriced_not_clean_' + value, {
        changed_mission: mid, unchanged_missions: createdMissions.map((mission) => mission.id),
        distinct_cost_warnings: 3,
      })
    }
    await loadCase('missing-tasks-and-team', (data) => {
      const taskIds = new Set(data.tasks.filter((item) => item.mission_id === mid).map((item) => item.id))
      const runIds = new Set(data.runs.filter((item) => taskIds.has(item.task_id)).map((item) => item.id))
      data.tasks = data.tasks.filter((item) => !taskIds.has(item.id)); data.runs = data.runs.filter((item) => !runIds.has(item.id))
      data.verification_evidence = data.verification_evidence.filter((item) => !runIds.has(item.run_id))
      data.verification_requests = data.verification_requests.filter((item) => !runIds.has(item.run_id))
      data.source_deliverables = data.source_deliverables.filter((item) => !runIds.has(item.run_id))
    })
    for (const value of ['light', 'dark']) {
      await theme(value); await mode('executive')
      await expect(executive().getByText('Task progress unavailable', { exact: false })).toBeVisible()
      const facts = originalArticle().locator('.executive-facts')
      await expect(facts.locator('div').filter({ has: page.getByText('Task progress', { exact: true }) })).toContainText('Unavailable')
      await expect(facts.locator('div').filter({ has: page.getByText('Responsible team', { exact: true }) })).toContainText('Unavailable')
      await expect(originalArticle().getByRole('button', { name: 'Inspect exact run', exact: true })).toHaveCount(0)
      await assertUnchangedCreatedMissions()
      await inspect('missing-context-executive-' + value)
      record('missing_context_not_invented_' + value)
    }

    await loadCase('failed-refresh')
    state.status = 503
    await mode('executive'); await executive().getByRole('button', { name: 'Refresh work', exact: true }).click()
    for (const value of ['light', 'dark']) {
      await theme(value)
      await expect(executive().getByText(/^Current work is unavailable\./)).toBeVisible()
      await expect(executive().locator('.executive-mission')).toHaveCount(0)
      await inspect('failed-refresh-executive-' + value)
      await mode('operations'); await expect(card()).toBeVisible()
      await expect(card().getByTestId('run-activity-panel')).toContainText('Updates unavailable')
      await inspect('failed-refresh-operations-' + value); await mode('executive')
    }
    state.status = 200; await executive().getByRole('button', { name: 'Refresh work', exact: true }).click()
    await expect(executive().getByText(/^Current work is unavailable\./)).toHaveCount(0)
    record('failed_refresh_hides_current_claims_and_recovers', { status: 503, recovered: 200 })

    await loadCase('stale-snapshot')
    await page.getByRole('link', { name: 'Control floor', exact: true }).click()
    await mode('executive')
    state.holdSnapshot = true
    await page.clock.fastForward(61_001)
    for (const value of ['light', 'dark']) {
      await theme(value)
      await expect(executive().getByText(/^Current work is unavailable\./)).toBeVisible()
      await expect(executive().locator('.executive-mission')).toHaveCount(0)
      await expect(executive().getByRole('button', { name: 'Inspect exact run', exact: true })).toHaveCount(0)
      await inspect('stale-executive-' + value)
      await mode('operations'); await inspect('stale-operations-' + value); await mode('executive')
    }
    record('expired_snapshot_withholds_current_claims', { clock_advance_ms: 61001, threshold_ms: 60000, operational_writes: 0 })
    presentation.assertContrast()
  } catch (error) {
    await development.capture('failure-' + state.name).catch(() => {})
    throw error
  } finally { await development.close() }

  for (const value of ['light', 'dark']) {
    const production = await session('production-' + value, true)
    const { page: connectionPage, state: connectionState, theme: connectionTheme, mode: connectionMode,
      loadCase: loadConnection, inspect: inspectConnection } = production
    try {
      await loadConnection('production-connect-' + value)
      await expect(connectionPage.getByRole('heading', { name: 'Connect to your Corp', exact: true })).toBeVisible()
      await connectionTheme(value)
      for (const view of ['operations', 'executive']) {
        await connectionMode(view); await inspectConnection(`production-connect-${value}-${view}`, '.loading-shell', true)
      }
      await connectionPage.locator('#production-corp').fill(demo.corp_id)
      await connectionPage.locator('#production-actor').fill(demo.alice_actor_id)
      await connectionPage.locator('#production-token').fill('synthetic-fixture-not-a-valid-token')
      connectionState.status = 401
      await connectionPage.getByRole('button', { name: 'Connect securely', exact: true }).click()
      await expect(connectionPage.locator('.production-connect .error-banner')).toBeVisible()
      assert.equal(await connectionPage.evaluate(() => sessionStorage.getItem('ecorp_access_token') === null), true)
      await connectionPage.locator('#production-token').fill('')
      await inspectConnection('production-connect-denied-' + value, '.loading-shell', true)
      record('production_connect_denial_' + value, { http_status: 401, session_token_removed: true, all_server_requests_intercepted: true })

      await connectionPage.evaluate(({ corp, actor }) => {
        sessionStorage.setItem('ecorp_corp_id', corp); sessionStorage.setItem('ecorp_actor_id', actor)
        sessionStorage.setItem('ecorp_access_token', 'synthetic-fixture-not-a-valid-token')
      }, { corp: demo.corp_id, actor: demo.alice_actor_id })
      connectionState.name = 'production-loading-' + value; connectionState.holdSnapshot = true
      await connectionPage.goto(web + '/?presentation_case=production-loading-' + value, { waitUntil: 'domcontentloaded' })
      await expect(connectionPage.getByRole('heading', { name: 'Authorizing the operations console…', exact: true })).toBeVisible()
      await expect(connectionPage.getByText('Waiting for the control plane.', { exact: true })).toBeVisible()
      await connectionTheme(value)
      for (const view of ['operations', 'executive']) {
        await connectionMode(view); await inspectConnection(`production-loading-${value}-${view}`, '.loading-shell')
      }
      await connectionPage.clock.fastForward(30_001)
      await expect(connectionPage.getByRole('button', { name: 'Retry connection', exact: true })).toBeVisible()
      await expect(connectionPage.locator('.error-banner')).toContainText('within 30 seconds')
      await inspectConnection('production-timeout-' + value, '.loading-shell', true)
      for (const release of connectionState.holds) release(); connectionState.holds.clear()
      connectionState.holdSnapshot = false; connectionState.status = 503
      await connectionPage.getByRole('button', { name: 'Retry connection', exact: true }).click()
      await expect(connectionPage.locator('.error-banner')).toContainText('Synthetic control-plane response unavailable')
      await inspectConnection('production-retry-error-' + value, '.loading-shell')
      record('production_loading_timeout_and_retry_' + value, { timeout_ms: 30000, retry_http_status: 503, provider_effects: 0 })
      production.presentation.assertContrast()
    } catch (error) {
      await production.capture('failure-' + connectionState.name).catch(() => {})
      throw error
    } finally { await production.close() }
  }
  assert.deepEqual(variants.unexpected, []); assert.deepEqual(variants.errors, [])
  for (const [kind, count] of Object.entries(variants.read_fixtures.responses)) {
    assert.ok(count > 0, 'The exact scoped synthetic read must be exercised: ' + kind)
  }
  record('exact_scoped_read_fixtures_exercised', variants.read_fixtures.responses)
  record('all_server_traffic_intercepted_no_native_mutations', { requests: variants.requests.length, unexpected: 0, page_errors: 0, native_mutations: 0 })
}
