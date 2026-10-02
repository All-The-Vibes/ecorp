// Explicit, caller-owned Windows fixture only. Reuses the planned-attempts
// supervisor's private empty stack and the existing native Codex protocol peer.
// Usage: CRONY_TOKEN_CEILING_TEST=1 node tools/e2e_token_ceiling.mjs <qa-root> <build-receipt>
// This is automated regression evidence, never an independent human decision.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { assertTestEndpoint, serverIdentity, verifyOwnedTestProcess } from './owned_test_stack.mjs'
import { readFixtureSourceIdentity } from './fixture_source_identity.mjs'
import { selectFixtureRunnerForSource, waitForControlledRunnerDispatch } from './controlled_runner_fixture.mjs'
import { sourceFingerprint } from './research_handoff_native.mjs'
import { MAX_TOKEN_BUDGET } from './test_token_ceiling.mjs'

const root = path.resolve(import.meta.dirname, '..')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const json = bytes => JSON.parse(bytes.toString().replace(/^\uFEFF/u, ''))
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const samePath = (left, right) => path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
const uuid = value => { assert.match(value, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u); return value }

export function tokenCeilingCreationTicks(iso) {
  const match = typeof iso === 'string' && iso.match(/^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)\.(\d{7})Z$/u)
  assert.ok(match, 'Require the original UTC native process timestamp, including all seven fractional digits')
  const milliseconds = Date.parse(`${match[1]}Z`)
  assert.ok(Number.isSafeInteger(milliseconds))
  return String(BigInt(milliseconds) * 10_000n + 621355968000000000n + BigInt(match[2]))
}

async function inspectProcesses(state, qa) {
  const identities = {}
  for (const role of ['server', 'runner', 'web', 'postgres']) {
    const launch = state.processes[role]
    assert.ok(launch && samePath(launch.workspace, qa), 'Process receipt belongs to another fixture')
    const server = role === 'web' ? state.plan.web : role === 'postgres'
      ? `http://127.0.0.1:${state.plan.database.port}` : state.plan.server
    const manifest = { test_owned: true, workspace: qa, server_url: server, server: launch.pid,
      server_creation: launch.started_utc,
      server_identity: { native_creation_ticks: tokenCeilingCreationTicks(launch.started_utc) } }
    await verifyOwnedTestProcess({ root: qa, server, binary: launch.executable, manifest, requireListener: role !== 'runner' })
    identities[role] = await serverIdentity(launch.pid, { root: qa, server, binary: launch.executable })
  }
  return identities
}

async function inspectBuild(file, state, actualSource) {
  const bytes = await readFile(file), build = json(bytes)
  assert.equal(build.status, 'passed', 'A successful actual native build receipt is required')
  assert.ok(samePath(build.source, root), 'Build used another source directory')
  assert.equal(build.source_before, actualSource)
  assert.equal(build.source_after, actualSource)
  const log = await readFile(build.cargo_json)
  assert.equal(sha(log), build.cargo_json_sha256, 'Cargo output changed')
  const records = log.toString('utf8').replace(/^\uFEFF/u, '').trim().split(/\r?\n/u).map(JSON.parse)
  assert.equal(records.at(-1)?.reason, 'build-finished')
  assert.equal(records.at(-1).success, true)
  const binaries = []
  for (const role of ['server', 'runner']) {
    const name = `crony-${role}`
    const found = records.filter(record => record.reason === 'compiler-artifact' && record.target?.name === name &&
      record.target.kind.includes('bin') && record.profile.test === false && record.executable &&
      samePath(record.manifest_path, path.join(root, 'crates', name, 'Cargo.toml')))
    assert.equal(found.length, 1, `Expected the actual ${name} compiler artifact`)
    const executable = await realpath(found[0].executable)
    assert.ok(samePath(executable, state.processes[role].executable), 'Running executable differs from the build')
    const recorded = build.binaries.find(binary => samePath(binary.path, executable))
    assert.ok(recorded, 'Missing retained build-time executable digest')
    assert.equal(sha(await readFile(executable)), recorded.sha256)
    binaries.push({ role, executable, sha256: recorded.sha256, compiler_fresh: found[0].fresh })
  }
  return { receipt: file, receipt_sha256: sha(bytes), cargo_json_sha256: sha(log), binaries }
}

async function inspectServedApp(response) {
  assert.equal(response.status(), 200)
  const bytes = await response.body()
  const map = bytes.toString('utf8').match(/\/\/# sourceMappingURL=data:application\/json;base64,([A-Za-z0-9+/=]+)\s*$/u)
  assert.ok(map, 'Actual served App.tsx must provide its original source map')
  const original = json(Buffer.from(map[1], 'base64'))
  assert.equal(original.sourcesContent.length, 1)
  const physical = await readFile(path.join(root, 'apps/web/src/App.tsx'))
  assert.equal(original.sourcesContent[0], physical.toString('utf8'), 'The browser received another App.tsx revision')
  return { url: response.url(), served_sha256: sha(bytes), original_sha256: sha(physical),
    binding: 'Actual browser response source-map bytes equal the physical reviewed source' }
}

export async function runTokenCeilingE2E(args) {
  assert.equal(process.platform, 'win32', 'This fixture consumes the existing Windows supervisor receipts')
  assert.equal(process.env.CRONY_TOKEN_CEILING_TEST, '1', 'Explicit owned-fixture opt-in required')
  assert.equal(args.length, 2, 'Expected an owned QA root and native build receipt')
  assert.ok(args.every(path.isAbsolute), 'Use absolute fixture and receipt paths')
  const qa = await realpath(args[0])
  assert.equal(path.basename(path.dirname(qa)), 'qa')
  assert.match(path.basename(qa), /^issue224-planned-attempts-[a-zA-Z0-9-]+$/u)
  const ownershipBytes = await readFile(path.join(qa, 'ownership.json')), state = json(ownershipBytes)
  assert.equal(state.test_owned, true)
  assert.equal(state.purpose, 'issue224-planned-attempts')
  assert.ok(samePath(state.workspace, qa) && samePath(state.plan.product, root))
  assert.equal(state.plan.database.fresh, true)
  assert.equal(state.plan.github_effects, false)
  assert.equal(state.plan.factory_watcher, false)
  assert.equal(state.database_authentication.wrong_password_rejected, true)
  const server = assertTestEndpoint(state.plan.server).origin, web = assertTestEndpoint(state.plan.web).origin
  assert.notEqual(server, web)
  const output = path.join(qa, 'evidence', 'token-ceiling')
  await mkdir(output) // A failed or completed run is never overwritten or adopted.
  const report = { schema_version: 1, issue: 291, status: 'running', source: root, qa_root: qa,
    started_at: new Date().toISOString(), cases: [],
    scope: 'Real browser, server, PostgreSQL and runner with the existing synthetic Codex protocol peer. No vendor inference, independent human review, Factory acceptance, publication or merge claim.' }
  const save = () => writeFile(path.join(output, 'receipt.json'), `${JSON.stringify(report, null, 2)}\n`)
  let browser, page
  const pageErrors = []
  try {
    report.source_before = await sourceFingerprint(root)
    report.ownership_sha256 = sha(ownershipBytes)
    report.build = await inspectBuild(args[1], state, report.source_before)
    report.processes_before = await inspectProcesses(state, qa)
    const sourceRoot = path.join(qa, 'source')
    const source = { repository: readFixtureSourceIdentity(sourceRoot).repository, base_ref: 'main',
      base_commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8', windowsHide: true }).trim() }
    assert.deepEqual(source, state.source)
    assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: sourceRoot, encoding: 'utf8', windowsHide: true }), '')
    report.fixture_source = source
    const demo = state.demo, corp = uuid(demo.corp_id), actor = uuid(demo.alice_actor_id)
    const prefix = `/api/corps/${corp}`
    const request = async (route, options = {}) => {
      const response = await fetch(`${server}${route}`, { ...options, redirect: 'error', signal: AbortSignal.timeout(15_000) })
      const text = await response.text()
      let body
      try { body = text ? JSON.parse(text) : null } catch { body = { error: text.slice(0, 2000) } }
      return { response, body }
    }
    const post = (route, value) => request(route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) })
    const snapshot = async () => {
      const result = await request(`${prefix}/snapshot?actor_id=${actor}`)
      assert.equal(result.response.status, 200)
      return result.body
    }
    const runner = { ...selectFixtureRunnerForSource(await snapshot(), demo, source), adapter: 'codex' }
    assert.equal(runner.runnerId, state.plan.runner_id)
    await waitForControlledRunnerDispatch({ request, demo, runner })
    // Read only, using this supervisor's private passfile. No database URL or
    // credential is copied to evidence, arguments, source or the runner.
    const pg = path.dirname(state.processes.postgres.executable)
    const sql = statement => {
      const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^PG/iu.test(key) && key !== 'DATABASE_URL'))
      const result = execFileSync(path.join(pg, 'psql.exe'), ['-X', '-w', '-A', '-t', '-v', 'ON_ERROR_STOP=1',
        '-h', '127.0.0.1', '-p', String(state.plan.database.port), '-U', 'issue224_qa', '-d', state.plan.database.name,
        '-c', statement], { encoding: 'utf8', windowsHide: true, timeout: 15_000, maxBuffer: 8 * 1024 * 1024,
        env: { ...clean, PGPASSFILE: path.join(qa, 'credentials/pgpass.conf') } })
      return json(result.trim())
    }
    const policyFields = ['actor_tokens_per_24h', 'actor_cost_microusd_per_24h', 'corp_tokens_per_24h',
      'corp_cost_microusd_per_24h', 'no_progress_event_limit', 'repeated_tool_limit']
    const defaults = sql("SELECT jsonb_object_agg(column_name,column_default) FROM information_schema.columns WHERE table_schema='public' AND table_name='corp_budget_policies' AND column_default IS NOT NULL")
    const policy = Object.fromEntries(policyFields.map(field => {
      const match = defaults[field]?.match(/^'?(\d+)'?(?:::(?:bigint|integer))?$/u)
      assert.ok(match, `Inspect the actual SQL default for ${field}`)
      return [field, Number(match[1])]
    }))
    const existingPolicy = sql(`SELECT COALESCE((SELECT to_jsonb(p) FROM corp_budget_policies p WHERE corp_id='${corp}'), 'null'::jsonb)`)
    assert.equal(existingPolicy, null, 'The fixture must not contain an authored prior policy')
    assert.equal(policy.actor_tokens_per_24h, MAX_TOKEN_BUDGET)
    assert.equal(policy.corp_tokens_per_24h, MAX_TOKEN_BUDGET)
    report.original_policy_defaults = policy
    const view = (current, id) => {
      const mission = current.snapshot.missions.find(item => item.id === id)
      assert.ok(mission)
      const tasks = current.snapshot.tasks.filter(item => item.mission_id === id)
      const ids = new Set(tasks.map(task => task.id))
      return { mission, tasks, runs: current.snapshot.runs.filter(run => ids.has(run.task_id)) }
    }
    const history = id => sha(JSON.stringify(sql(`SELECT jsonb_build_object('mission',to_jsonb(m),
      'tasks',(SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM tasks t WHERE t.mission_id=m.id),
      'runs',(SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM runs r JOIN tasks t ON t.id=r.task_id WHERE t.mission_id=m.id))
      FROM missions m WHERE m.corp_id='${corp}' AND m.id='${uuid(id)}'`)))
    const inventory = () => sql(`SELECT jsonb_build_object('missions',(SELECT count(*) FROM missions WHERE corp_id='${corp}'),
      'tasks',(SELECT count(*) FROM tasks WHERE corp_id='${corp}'),'runs',(SELECT count(*) FROM runs WHERE corp_id='${corp}'))`)
    assert.deepEqual(inventory(), { missions: 0, tasks: 0, runs: 0 })
    const { chromium } = createRequire(import.meta.url)(process.env.CRONY_PLAYWRIGHT_MODULE || 'playwright')
    browser = await chromium.launch({ channel: process.env.CRONY_BROWSER_CHANNEL || 'msedge', headless: true })
    page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, reducedMotion: 'reduce' })
    page.on('pageerror', error => pageErrors.push(error.message))
    const served = page.waitForResponse(response => new URL(response.url()).pathname === '/src/App.tsx')
    await page.goto(`${web}/#missions`, { waitUntil: 'networkidle', timeout: 30_000 })
    report.served_app = await inspectServedApp(await served)
    await page.locator('.live-indicator.live-live').waitFor({ timeout: 30_000 })
    await save()
    const createMission = async label => {
      // An empty queue opens the composer automatically; later missions use
      // the toolbar control. Follow the existing native qualification flow.
      if (!(await page.locator('#mission-title').isVisible())) {
        await page.getByRole('button', { name: 'New mission', exact: true }).click()
      }
      await page.locator('#mission-title').fill(`Finite ceiling ${label}`)
      for (const field of ['#mission-description', '#mission-deliverable']) {
        const details = page.locator('details.mission-advanced-options').filter({ has: page.locator(field) })
        if (!(await details.evaluate(element => element.open))) await details.locator('summary').click()
      }
      await page.locator('#mission-description').fill('Owned native Codex protocol regression. Write base.txt and return the verified report; no real AI inference or remote effects.')
      await page.locator('#mission-repository').selectOption(JSON.stringify([source.repository, source.base_ref, source.base_commit]))
      await page.getByRole('checkbox', { name: /Confirm this target/u }).check()
      await page.locator('#mission-adapter').selectOption('codex')
      await page.locator('#mission-strategy').selectOption('single')
      assert.equal(await page.locator('#mission-budget').inputValue(), String(MAX_TOKEN_BUDGET))
      await page.locator('#mission-budget').selectOption(String(MAX_TOKEN_BUDGET))
      await page.locator('#mission-deliverable').selectOption('review_only_report')
      await page.getByRole('checkbox', { name: /Commit verified work/u }).uncheck()
      await page.getByRole('checkbox', { name: /Save without starting/u }).check()
      await page.getByRole('button', { name: 'Review and build', exact: true }).click()
      const pending = page.waitForResponse(response => response.url() === `${server}${prefix}/missions` && response.request().method() === 'POST')
      await page.getByRole('button', { name: 'Save plan', exact: true }).click()
      const response = await pending
      assert.equal(response.status(), 200)
      assert.equal(response.request().postDataJSON().budget_tokens, MAX_TOKEN_BUDGET)
      const id = uuid((await response.json()).mission_id)
      const created = view(await snapshot(), id)
      assert.equal(created.mission.budget_tokens, MAX_TOKEN_BUDGET)
      assert.equal(created.mission.original_budget_tokens, MAX_TOKEN_BUDGET)
      assert.equal(created.tasks.length, 1)
      assert.equal(created.tasks[0].contract.budget_tokens, MAX_TOKEN_BUDGET)
      assert.equal(created.tasks[0].attempt_count, 0)
      assert.equal(created.runs.length, 0)
      return { id, created }
    }
    const previous = new Map()
    const assertHistory = () => { for (const [id, digest] of previous) assert.equal(history(id), digest, 'Prior allocations, spend or history changed') }
    const setPolicy = async (actorTokens, corpTokens) => {
      const wanted = { ...policy, actor_tokens_per_24h: actorTokens, corp_tokens_per_24h: corpTokens }
      assert.equal((await post(`${prefix}/budget-policy`, { ...wanted, actor_id: actor })).response.status, 204)
      const stored = sql(`SELECT to_jsonb(p) FROM corp_budget_policies p WHERE corp_id='${corp}'`)
      for (const field of policyFields) assert.equal(stored[field], wanted[field])
      assertHistory()
    }
    let spent = 0
    for (const [label, limiter] of [['exact-ceiling', null], ['requester-remainder', 'requester'], ['corp-remainder', 'corp']]) {
      if (limiter) await setPolicy(spent + (limiter === 'requester' ? 20 : 40), spent + (limiter === 'corp' ? 20 : 40))
      const { id, created } = await createMission(label)
      const card = page.locator(`[data-mission-id="${id}"]`)
      const pending = page.waitForResponse(response => response.url() === `${server}${prefix}/missions/${id}/launch` && response.request().method() === 'POST')
      await card.getByTestId('work-result-card').getByRole('button', { name: 'Start mission', exact: true }).click()
      const launchResponse = await pending
      assert.equal(launchResponse.status(), 200)
      const launch = await launchResponse.json()
      assert.equal(launch.runner_id, runner.runnerId)
      const deadline = Date.now() + 90_000
      let completed
      while (Date.now() < deadline) {
        const current = view(await snapshot(), id)
        assert.ok(!['failed', 'cancelled'].includes(current.mission.status), `${label} failed instead of completing`)
        if (current.mission.status === 'completed' && current.runs.length === 1 &&
          ['preserved', 'removed'].includes(current.runs[0].workspace_disposition)) { completed = current; break }
        await delay(150)
      }
      assert.ok(completed, `${label} did not finish with persisted workspace disposition`)
      const run = completed.runs[0], task = completed.tasks[0]
      assert.equal(run.id, launch.run_id)
      assert.equal(run.status, 'completed')
      assert.equal(run.verification_status, 'passed')
      assert.equal(run.execution_mode, 'provider')
      assert.equal(task.attempt_count, 1)
      assert.equal(task.max_attempts, created.tasks[0].max_attempts)
      assert.deepEqual(task.contract, created.tasks[0].contract)
      const persisted = sql(`SELECT jsonb_build_object('budget_tokens_limit',budget_tokens_limit,
        'budget_cost_microusd_limit',budget_cost_microusd_limit,'input_tokens',input_tokens,'output_tokens',output_tokens)
        FROM runs WHERE id='${uuid(run.id)}' AND corp_id='${corp}'`)
      assert.equal(persisted.budget_tokens_limit, limiter ? 20 : MAX_TOKEN_BUDGET)
      assert.equal(persisted.budget_cost_microusd_limit, task.contract.budget_cost_microusd)
      const usage = persisted.input_tokens + persisted.output_tokens
      assert.equal(usage, 12, 'Require actual usage from the unchanged native Codex protocol peer')
      spent += usage
      const artifactUrl = new URL(run.artifact_uri, server)
      assert.equal(artifactUrl.origin, server)
      assert.equal(artifactUrl.pathname, `${prefix}/artifacts/${uuid(run.artifact_id)}`)
      artifactUrl.searchParams.set('actor_id', actor)
      const download = await fetch(artifactUrl, { redirect: 'error', signal: AbortSignal.timeout(15_000) })
      assert.equal(download.status, 200)
      const bytes = Buffer.from(await download.arrayBuffer())
      assert.ok(bytes.length > 0 && bytes.length <= 16 * 1024 * 1024)
      assert.equal(sha(bytes), run.artifact_sha256)
      assert.equal(download.headers.get('content-type'), run.artifact_media_type)
      assert.equal(download.headers.get('x-content-type-options'), 'nosniff')
      assert.equal(download.headers.get('x-crony-artifact-signature'), run.artifact_signature)
      await writeFile(path.join(output, `${label}-artifact.bin`), bytes, { flag: 'wx' })
      assertHistory()
      previous.set(id, history(id))
      report.cases.push({ label, mission_id: id, run_id: run.id, persisted, prior_history_unchanged: true,
        artifact: { id: run.artifact_id, bytes: bytes.length, sha256: sha(bytes) },
        verification_status: run.verification_status, max_attempts: task.max_attempts })
      await page.screenshot({ path: path.join(output, `${label}.png`), fullPage: true })
      await save()
    }
    await setPolicy(spent, spent + 20)
    const held = await createMission('zero-remainder')
    const zeroBefore = history(held.id), before = inventory()
    const rejected = await post(`${prefix}/missions/${held.id}/launch`, { requested_by: actor })
    assert.equal(rejected.response.status, 409)
    assert.match(rejected.body.error, /rolling budget has no remaining authority/u)
    assert.equal(history(held.id), zeroBefore)
    assert.deepEqual(inventory(), before)
    report.cases.push({ label: 'zero-remainder', status: rejected.response.status, attempts_consumed: 0, runs_created: 0 })
    for (const invalid of [0, -1, MAX_TOKEN_BUDGET + 1, 1.5, 'malformed', '999999999999999', 1e30]) {
      for (const endpoint of ['/missions/preview', '/missions']) {
        const result = await post(`${prefix}${endpoint}`, { requested_by: actor, preferred_adapter: 'codex', strategy: 'single',
          title: 'Invalid finite token allocation must not persist', source, budget_tokens: invalid })
        assert.ok([400, 422].includes(result.response.status), 'Malformed or unauthorized tokens were accepted')
        assert.deepEqual(inventory(), before)
        assert.equal(history(held.id), zeroBefore)
        assertHistory()
        report.cases.push({ label: 'invalid-input', endpoint, value: invalid, status: result.response.status, ledger_unchanged: true })
      }
    }
    assert.deepEqual(pageErrors, [])
    report.page_errors = pageErrors
    report.prior_history = Object.fromEntries(previous)
    report.processes_after = await inspectProcesses(state, qa)
    assert.deepEqual(report.processes_after, report.processes_before)
    assert.equal(sha(await readFile(path.join(qa, 'ownership.json'))), report.ownership_sha256)
    report.status = 'passed'
  } catch (error) {
    report.status = 'failed'
    report.failure = error.message
    if (page && !page.isClosed()) {
      try {
        await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true })
        report.failure_page = { url: page.url(), text: (await page.locator('body').innerText()).slice(0, 12000) }
      } catch (diagnosticError) { report.diagnostic_failure = diagnosticError.message }
    }
  } finally {
    report.page_errors = pageErrors
    if (browser) await browser.close()
    report.source_after = await sourceFingerprint(root)
    if (report.source_after !== report.source_before) { report.status = 'failed'; report.source_failure = 'Source changed during E2E' }
    report.finished_at = new Date().toISOString()
    await save()
  }
  return { status: report.status, receipt: path.join(output, 'receipt.json'), failure: report.failure ?? report.source_failure ?? null }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const result = await runTokenCeilingE2E(process.argv.slice(2))
    console.log(JSON.stringify(result))
    process.exitCode = result.status === 'passed' ? 0 : 1
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
