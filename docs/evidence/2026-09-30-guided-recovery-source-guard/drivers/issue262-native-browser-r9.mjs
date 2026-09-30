import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { resolve, join, basename, dirname, isAbsolute } from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { admitNativeAcceptance } from './issue264-native-admission-r1.mjs'
import { exerciseRevisionCases } from './issue262-native-revision-cases-r4.mjs'
import { exerciseRecoveryCases } from './issue262-native-recovery-cases-r4.mjs'

const inputs = process.argv.slice(2), required = ['--qa-root', '--postgres-bin', '--source-receipt', '--product-root', '--source-receipt-sha256']
assert.equal(inputs.length, required.length * 2)
const args = Object.fromEntries(inputs.reduce((pairs, value, i) => i % 2 ? pairs : [...pairs, [value, inputs[i + 1]]], []))
assert.deepEqual(Object.keys(args).sort(), required.sort())
const qa = resolve(args['--qa-root']), pg = resolve(args['--postgres-bin'])
assert.ok(isAbsolute(args['--qa-root']) && basename(dirname(qa)) === 'qa' && /^pr265-run-activity-issue262-alias-20260930-r[0-9]+$/.test(basename(qa)))
const admission = await admitNativeAcceptance({ productRoot: args['--product-root'], qaRoot: qa,
  sourceReceiptPath: args['--source-receipt'], sourceReceiptSha256: args['--source-receipt-sha256'] })
const { product, ownership, sourceReceipt } = admission
const { server, web } = ownership.plan, { demo, source } = ownership
assert.equal(ownership.plan.runner_id, 'pr265-activity-qa')
assert.equal(ownership.plan.database.host, '127.0.0.1')
assert.equal(ownership.plan.database.name, 'pr265_activity')
assert.ok(ownership.issue262_codex_fixture)
for (const origin of [server, web]) assert.match(origin, /^http:\/\/127\.0\.0\.1:[1-9][0-9]{4}$/)
execFileSync('pwsh', ['-NoProfile', '-File', join(product, 'tools/qa_factory_run_activity.ps1'), '-Phase', 'Status', '-QaRoot', qa, '-PostgresBin', pg], { timeout: 30000, stdio: 'pipe', windowsHide: true })
const reportPath = join(qa, 'evidence/issue262-native-browser.json')
assert.ok(!existsSync(reportPath), 'Never repeat acceptance effects in an existing fixture')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const report = { issue: 262, status: 'accepting', started_at: new Date().toISOString(), actual_human_reviews: 0,
  scope: 'Fresh owned browser/server/PostgreSQL/native runner. Deterministic fake-process and synthetic Codex protocol, no real provider inference or GitHub effects. Browser-only cases are explicitly labeled.',
  source_receipt: args['--source-receipt'], source_receipt_sha256: hash(readFileSync(args['--source-receipt'])),
  admission: { product, head: sourceReceipt.identity.head, execution_files: admission.execution_files },
  operations: [], checks: {}, screenshots: {}, failures: [] }
const save = () => {
  report.updated_at = new Date().toISOString()
  writeFileSync(reportPath + '.tmp', JSON.stringify(report, null, 2) + '\n')
  const delay = new Int32Array(new SharedArrayBuffer(4))
  for (let i = 0; ; i++) {
    try { renameSync(reportPath + '.tmp', reportPath); return }
    catch (error) { if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || i >= 40) throw error; Atomics.wait(delay, 0, 0, 25) }
  }
}
const check = (name, value = true) => { report.checks[name] = value; save(); console.log('PASS ' + name) }
save()
const api = suffix => `/api/corps/${demo.corp_id}${suffix}`
async function rawRequest(route, body) {
  assert.ok(route.startsWith('/api/') && !route.startsWith('//'))
  const response = await fetch(server + route, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000) })
  const text = await response.text()
  let data
  try { data = JSON.parse(text) } catch { data = { message: text.slice(0, 600) } }
  return { status: response.status, body: data }
}
async function request(route, body) {
  const result = await rawRequest(route, body)
  assert.equal(result.status, 200, `${route.split('?')[0]} returned ${result.status}: ${JSON.stringify(result.body).slice(0, 900)}`)
  return result.body
}
const snapshot = (actor = demo.alice_actor_id) => request(api(`/snapshot?actor_id=${actor}`))
async function graph(mid) {
  const state = await snapshot(), s = state.snapshot, tasks = s.tasks.filter(task => task.mission_id === mid)
  return { state, mission: s.missions.find(mission => mission.id === mid), tasks,
    runs: s.runs.filter(run => tasks.some(task => task.id === run.task_id)), revisions: s.mission_contract_revisions.filter(revision => revision.mission_id === mid) }
}
async function wait(probe, label, timeout = 60000) {
  const until = Date.now() + timeout
  do { const result = await probe(); if (result) return result; await new Promise(done => setTimeout(done, 150)) } while (Date.now() < until)
  throw new Error('Timed out: ' + label)
}
function intent(name, route, body) {
  assert.ok(!report.operations.some(operation => operation.name === name))
  const operation = { name, route, request_body: body, started_at: new Date().toISOString(), completed: false }
  report.operations.push(operation); save(); return operation
}
async function effect(name, route, body) {
  const operation = intent(name, route, body), result = await request(route, body)
  operation.response = result; operation.completed = true; save(); return result
}
function contract(objective = 'Produce only the bounded acceptance output.') {
  return { objective, expected_output: 'A native verified file in the isolated assigned worktree.',
    acceptance_tests: ['The persisted native verifier passes.', 'The configured product checkout remains unchanged.'],
    allowed_tools: ['filesystem', 'shell'], prohibited_actions: ['modify the configured source checkout', 'disable verification'],
    references: ['docs/SECURITY.md', 'approved-context://issue262-guided-recovery'], write_scope: ['**'] }
}
async function create(name, overrides = {}) {
  return effect('create-' + name, api('/missions'), { requested_by: demo.alice_actor_id, preferred_adapter: 'fake-process', strategy: 'single',
    title: 'Issue262 ' + name, description: 'Owned guided contract recovery acceptance.', source, budget_tokens: 100000,
    budget_cost_microusd: 10000000, contract: contract(), verification_policy: { checks: [{ type: 'artifact', min_bytes: 1 }], manual_gate: null }, ...overrides })
}
const runtime = '<USERPROFILE>/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'
const { chromium } = await import(pathToFileURL(join(runtime, 'index.mjs')))
const { expect: baseExpect } = await import(pathToFileURL(join(runtime, 'test.mjs')))
const expect = baseExpect.configure({ timeout: 18000 })
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, reducedMotion: 'reduce' })
await context.route('**/*', route => [web + '/', server + '/', 'data:', 'blob:'].some(prefix => route.request().url().startsWith(prefix)) ? route.continue() : route.abort())
const page = await context.newPage(), pageErrors = []
page.on('pageerror', error => pageErrors.push(error.message))
const card = mid => page.locator(`[data-mission-id="${mid}"]`)
const panel = tid => page.getByTestId(`contract-revision-${tid}`)
async function showOn(activePage, mid, tid) {
  await activePage.getByRole('link', { name: 'Missions', exact: true }).click()
  const closeSetup = activePage.getByRole('button', { name: 'Close setup', exact: true })
  if (await closeSetup.isVisible()) await closeSetup.click()
  const selectedCard = activePage.locator('[data-mission-id="' + mid + '"]')
  if (!(await selectedCard.isVisible())) {
    const selector = activePage.locator('#mission-work-switch')
    await expect(selector.locator('option[value="' + mid + '"]')).toBeAttached()
    if (await selector.isVisible()) await selector.selectOption(mid)
    else {
      const record = activePage.getByRole('navigation', { name: 'Mission records', exact: true })
        .getByRole('button').filter({ has: activePage.locator('small').filter({ hasText: mid.slice(0, 8) }) })
      await expect(record).toHaveCount(1)
      await record.click()
    }
  }
  await expect(selectedCard).toBeVisible()
  if (tid) {
    const tasks = activePage.locator('#mission-tasks-' + mid)
    if (!(await tasks.evaluate(element => element.open))) await tasks.locator(':scope > summary').click()
    const task = selectedCard.locator('[data-task-id="' + tid + '"]')
    if (!(await task.evaluate(element => element.open))) await task.locator(':scope > summary').click()
  }
}
const show = (mid, tid) => showOn(page, mid, tid)

async function open(created, action = 'redispatch') {
  await show(created.mission_id, created.task_id)
  const revision = panel(created.task_id)
  const reason = revision.getByLabel('Revision reason')
  if (!(await reason.isVisible())) {
    // Native terminal state may arrive before the projected browser snapshot.
    // Waiting for the actual control avoids silently skipping a not-yet-rendered button.
    await revision.getByRole('button', {
      name: new RegExp('^(Continue revision draft|View saved revision|Revise contract for ' + action + ')$'),
    }).click()
  }
  await expect(reason).toBeVisible()
  return revision
}
async function exact(revision) {
  const details = revision.locator('.contract-exact-editor')
  if (!(await details.evaluate(element => element.open))) await details.locator('summary').click()
  return { contract: revision.getByLabel('Typed task contract · JSON'), policy: revision.getByLabel('Typed verifier policy · JSON') }
}
async function capture(name) {
  const file = `${name}-${randomUUID().slice(0, 8)}.png`
  await page.screenshot({ path: join(qa, 'evidence', file), fullPage: true })
  report.screenshots[name] = file; save()
}
async function browserPost(name, route, button) {
  const operation = intent(name, route), responsePromise = page.waitForResponse(response => response.url() === server + route && response.request().method() === 'POST')
  await button.click()
  const response = await responsePromise
  operation.request_body = response.request().postDataJSON(); operation.response_status = response.status(); operation.response = await response.json(); operation.completed = true; save()
  assert.equal(response.status(), 200, JSON.stringify(operation.response).slice(0, 900))
  return operation.response
}
const toolkit = { qa, pg, product, ownership, server, web, demo, source, report, save, check, hash, api, request, rawRequest, snapshot, graph, wait, intent, effect,
  contract, create, browser, context, page, expect, card, panel, show, showOn, open, exact, capture, browserPost }
try {
  const initial = await snapshot()
  assert.equal(initial.snapshot.tasks.length, 0); assert.equal(initial.snapshot.runs.length, 0)
  await page.goto(web + '/#missions', { waitUntil: 'networkidle' })
  await expect(page.locator('.live-live')).toBeVisible({ timeout: 25000 })
  await exerciseRevisionCases(toolkit)
  await exerciseRecoveryCases(toolkit)
  assert.deepEqual(pageErrors, [], 'No uncaught product browser errors')
  const final = await snapshot()
  writeFileSync(join(qa, 'evidence/issue262-final-snapshot.json'), JSON.stringify(final, null, 2) + '\n')
  check('native_final_snapshot_saved', { missions: final.snapshot.missions.length, tasks: final.snapshot.tasks.length, runs: final.snapshot.runs.length, revisions: final.snapshot.mission_contract_revisions.length })
  report.status = 'accepted'
} catch (error) {
  report.status = 'failed'; report.failures.push({ message: error.message, stack: error.stack })
  try { await capture('failure') } catch { /* Preserve the original failure. */ }
  throw error
} finally {
  report.finished_at = new Date().toISOString(); save(); await browser.close()
}
