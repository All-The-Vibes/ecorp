// Requires a caller-owned Windows QA stack and receipt, never the manual app.
// No fixture reset, provider inference, browser response mocks, storage seeding,
// or reviewer decisions. The caller starts/stops its services with native helpers.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { promisify } from 'node:util'
import { captureOwnedTestServerManifest } from './owned_test_stack.mjs'

assert.equal(process.env.ECORP_POLICY_TEST, '1', 'Explicit owned-stack opt-in required')
assert.ok(path.isAbsolute(process.env.ECORP_POLICY_SETUP ?? ''), 'Absolute QA setup receipt required')
const setup = JSON.parse(await readFile(process.env.ECORP_POLICY_SETUP, 'utf8'))
assert.equal(setup.test_owned, true)
assert.ok(path.isAbsolute(setup.qa_root) && path.isAbsolute(setup.output))
const forbiddenPorts = new Set(['8791', '8793', '5187', '5291', '15191', '15193', '54330'])
function origin(value) {
  const url = new URL(value)
  assert.equal(url.protocol, 'http:')
  assert.equal(url.hostname, '127.0.0.1')
  assert.ok(url.port && !forbiddenPorts.has(url.port))
  assert.equal(url.pathname, '/')
  assert.ok(!url.username && !url.password && !url.search && !url.hash)
  return url.origin
}
const server = origin(setup.server_url)
const web = origin(setup.web_url)
assert.notEqual(server, web)
const output = path.join(setup.output, `browser-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}`)
await mkdir(output, { recursive: true })
const report = {
  schema_version: 1, status: 'running', started_at: new Date().toISOString(), server, web,
  scope: 'Real browser/server/runner with deterministic fake-process; development identity, no real-provider inference or manual review decisions',
  screenshot_fixture: 'The existing fake-agent screenshot signature fixture exercises the screenshot verifier; browser screenshots below are separate real rendered captures.',
  source_commit: setup.source_commit, errors: [], blocked_requests: [], viewports: [], missions: [],
}
const save = () => writeFile(path.join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
const execute = promisify(execFile)
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let browser, page, demo

async function request(route) {
  assert.ok(route === '/health' || route.startsWith(`/api/corps/${demo.corp_id}/snapshot?`))
  const response = await fetch(`${server}${route}`, { redirect: 'error', signal: AbortSignal.timeout(15_000) })
  assert.equal(response.status, 200, `${route.split('?')[0]}: HTTP ${response.status}`)
  return response.json()
}
const snapshot = () => request(`/api/corps/${demo.corp_id}/snapshot?actor_id=${demo.alice_actor_id}`)
async function until(label, read, predicate, timeout = 90_000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const value = await read()
    if (predicate(value)) return value
    await delay(150)
  }
  throw new Error(`Timed out waiting for ${label}`)
}
function missionView(state, missionId) {
  const s = state.snapshot
  const mission = s.missions.find((row) => row.id === missionId)
  assert.ok(mission)
  const tasks = s.tasks.filter((row) => row.mission_id === missionId)
  const ids = new Set(tasks.map((row) => row.id))
  const runs = s.runs.filter((row) => ids.has(row.task_id))
  return { mission, tasks, runs, state: s }
}
async function screenshot(name) {
  const file = path.join(output, `${name}.png`)
  await page.screenshot({ path: file, fullPage: true })
  return { file, sha256: createHash('sha256').update(await readFile(file)).digest('hex') }
}
async function noOverflow(width) {
  const measured = await page.evaluate(() => ({ viewport: innerWidth, content: document.documentElement.scrollWidth }))
  assert.equal(measured.viewport, width)
  assert.ok(measured.content <= width, `Viewport overflow: ${measured.content} > ${width}`)
  return measured
}
async function openAdvanced(containing) {
  const details = page.locator('details.mission-advanced-options').filter({ has: page.locator(containing) })
  assert.equal(await details.count(), 1)
  if (!(await details.evaluate((element) => element.open))) await details.locator('summary').click()
}
async function prepareMission(title) {
  report.stage = 'prepare unsaved mission'
  await save()
  await page.goto(`${web}/#missions`, { waitUntil: 'networkidle', timeout: 30_000 })
  await page.locator('.live-indicator.live-live').waitFor({ timeout: 30_000 })
  const newMission = page.getByRole('button', { name: 'New mission', exact: true })
  if (await newMission.isVisible()) await newMission.click()
  await page.locator('#mission-title').fill(title)
  await openAdvanced('#mission-description')
  await page.locator('#mission-description').fill('Owned deterministic verification-policy regression. Use the isolated source fixture, preserve evidence, and perform no external effects.')
  const targets = await page.locator('#mission-repository option').evaluateAll((items) => items
    .filter((item) => item.value).map((item) => ({ value: item.value, source: JSON.parse(item.value) })))
  const matches = targets.filter((item) => item.source[0] === setup.source_repository && item.source[2] === setup.source_commit)
  assert.equal(matches.length, 1, 'Exactly the caller-owned immutable source must be available')
  await page.locator('#mission-repository').selectOption(matches[0].value)
  await page.getByRole('checkbox', { name: /Confirm this target/ }).check()
  await openAdvanced('#mission-deliverable')
  await page.getByRole('checkbox', { name: /Developer fixtures/ }).check()
  await page.locator('#mission-adapter').selectOption('fake-process')
  await page.locator('#mission-strategy').selectOption('single')
  await page.locator('#mission-deliverable').selectOption('review_only_report')
  await page.getByRole('checkbox', { name: /Commit verified work/ }).uncheck()
  await page.getByRole('checkbox', { name: /Save without starting/ }).check()
  await page.getByRole('button', { name: 'Review and build', exact: true }).click()
  const custom = page.getByRole('checkbox', { name: /Custom verification/ })
  assert.equal(await custom.isEnabled(), true)
  await custom.check()
  return page.getByTestId('mission-verification-editor')
}
async function fillCheck(editor, index, check) {
  report.stage = `author check ${index + 1}: ${check.type}`
  await save()
  const tabs = editor.locator('.verification-check-tabs button')
  while (await tabs.count() <= index) await editor.getByRole('button', { name: 'Add check', exact: true }).click()
  await tabs.nth(index).click()
  await editor.getByLabel(`Verifier check ${index + 1} type`, { exact: true }).selectOption(check.type)
  if (check.type === 'artifact') await editor.getByLabel('Minimum artifact bytes', { exact: true }).fill(String(check.min_bytes))
  if (check.type === 'file' || check.type === 'screenshot') {
    await editor.getByLabel('Worktree-relative path', { exact: true }).fill(check.path)
    await editor.getByLabel('Minimum bytes', { exact: true }).fill(String(check.min_bytes))
  }
  if (check.type === 'command' || check.type === 'test') {
    await editor.getByLabel('Program', { exact: true }).fill(check.program)
    await editor.getByLabel('Timeout in milliseconds', { exact: true }).fill(String(check.timeout_ms))
    await editor.getByLabel('Arguments, one per line').fill(check.args.join('\n'))
  }
  if (check.type === 'json_schema') {
    await editor.getByLabel('JSON file', { exact: true }).fill(check.path)
    await editor.getByLabel('Required top-level keys').fill(check.required_keys.join('\n'))
  }
}
async function editorViewport(editor, name, width, height, expectedPolicy) {
  report.stage = `editor ${name}`
  await page.setViewportSize({ width, height })
  const tabs = editor.locator('.verification-check-tabs button')
  const selected = []
  for (let index = 0; index < 6; index += 1) {
    await tabs.nth(index).focus()
    await page.keyboard.press('Enter')
    assert.equal(await tabs.nth(index).getAttribute('aria-pressed'), 'true')
    const input = editor.getByLabel(`Verifier check ${index + 1} type`, { exact: true })
    await input.focus()
    const focus = await input.evaluate((element) => ({
      active: document.activeElement === element,
      outline: getComputedStyle(element).outlineStyle,
      outline_width: parseFloat(getComputedStyle(element).outlineWidth),
    }))
    assert.equal(focus.active, true)
    assert.notEqual(focus.outline, 'none')
    assert.ok(focus.outline_width >= 2)
    selected.push({ index, type: await input.inputValue(), focus })
  }
  const gate = editor.getByLabel('Final reviewer gate')
  await gate.selectOption('human_approval')
  assert.equal(await editor.getByLabel('Eligible roles').inputValue(), 'owner, admin')
  await gate.selectOption('independent_review')
  const excluded = editor.getByRole('checkbox', { name: /Exclude the mission requester/ })
  assert.equal(await excluded.isChecked(), true)
  await excluded.uncheck()
  await editor.getByLabel('Eligible roles').fill('member, owner')
  await excluded.check()
  await gate.selectOption('none')
  assert.equal(await editor.getByLabel('Eligible roles').count(), 0)
  const disclosure = editor.locator('.verification-plan-disclosure')
  if (!(await disclosure.evaluate((element) => element.open))) await disclosure.locator('summary').click()
  const summaries = await editor.getByTestId('verification-policy-preview').locator('ol li p').allTextContents()
  assert.ok(summaries[0].endsWith('at least 1 byte'))
  const commandIndex = expectedPolicy.checks.findIndex((check) => check.type === 'command')
  const command = expectedPolicy.checks[commandIndex]
  const rendered = summaries[commandIndex]
  assert.deepEqual(JSON.parse(rendered.slice(rendered.indexOf('['), rendered.lastIndexOf(']') + 1)), [command.program, ...command.args])
  assert.equal(await editor.getByTestId('verification-policy-preview').locator('ol li p').nth(commandIndex).evaluate((element) => getComputedStyle(element).whiteSpace), 'pre-wrap')
  const schemaIndex = expectedPolicy.checks.findIndex((check) => check.type === 'json_schema')
  assert.deepEqual(JSON.parse(summaries[schemaIndex].split(' · keys: ')[1]), expectedPolicy.checks[schemaIndex].required_keys)
  report.viewports.push({ name, width, height, selected, manual_gates: 'draft-only; restored to none',
    command_summary: rendered, byte_summary: summaries[0],
    layout: await noOverflow(width), screenshot: await screenshot(`${name}-editor`) })
  await save()
}
async function saveAndLaunch(title, expectedPolicy, expectedOutcome) {
  report.stage = `save ${expectedOutcome}`
  const creation = page.waitForResponse((response) => response.url() === `${server}/api/corps/${demo.corp_id}/missions` && response.request().method() === 'POST')
  await page.getByRole('button', { name: 'Save plan', exact: true }).click()
  const response = await creation
  assert.equal(response.status(), 200)
  const authored = response.request().postDataJSON()
  assert.deepEqual(authored.verification_policy, expectedPolicy)
  assert.equal(authored.preferred_adapter, 'fake-process')
  const created = await response.json()
  const receipt = { title, mission_id: created.mission_id, task_id: created.task_id, authored, expected_outcome: expectedOutcome }
  report.missions.push(receipt)
  await save()
  const saved = missionView(await snapshot(), created.mission_id)
  assert.equal(saved.mission.status, 'ready')
  assert.equal(saved.runs.length, 0)
  assert.equal(saved.tasks.length, 1)
  assert.deepEqual(saved.tasks[0].verification_policy, expectedPolicy)
  const card = page.locator(`[data-mission-id="${created.mission_id}"]`)
  await card.locator('.status-chip-ready').waitFor()
  receipt.saved_screenshot = await screenshot(`${expectedOutcome}-saved`)
  const launchResponse = page.waitForResponse((value) => value.url() === `${server}/api/corps/${demo.corp_id}/missions/${created.mission_id}/launch` && value.request().method() === 'POST')
  await card.getByTestId('work-result-card').getByRole('button', { name: 'Start mission', exact: true }).click()
  const launched = await launchResponse
  assert.equal(launched.status(), 200)
  receipt.launch = await launched.json()
  report.stage = `runner ${expectedOutcome}`
  await save()
  const final = await until(`runner ${expectedOutcome}`, async () => missionView(await snapshot(), created.mission_id), (value) =>
    value.runs.length === 1 && ['completed', 'failed'].includes(value.mission.status) && value.runs[0].workspace_disposition === 'preserved')
  const run = final.runs[0]
  assert.equal(run.runner_id, setup.runner_id)
  assert.equal(run.source_base_commit, setup.source_commit)
  const relative = path.relative(setup.workspace, run.workspace_path)
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative))
  assert.notEqual(path.resolve(run.workspace_path).toLowerCase(), path.resolve(setup.source).toLowerCase())
  const evidence = final.state.verification_evidence.filter((item) => item.run_id === run.id).sort((a, b) => a.check_index - b.check_index)
  const events = final.state.events.filter((event) => event.aggregate_id === run.id)
  assert.equal(evidence.length, expectedPolicy.checks.length)
  assert.deepEqual(final.tasks[0].verification_policy, expectedPolicy)
  assert.equal(final.state.verification_requests.filter((row) => row.run_id === run.id).length, 0)
  if (expectedOutcome === 'passed') {
    assert.equal(final.mission.status, 'completed')
    assert.equal(run.status, 'completed')
    assert.ok(evidence.every((item) => item.status === 'passed'))
    for (const [index, check] of expectedPolicy.checks.entries()) {
      if (check.type === 'command' || check.type === 'test') {
        assert.deepEqual(evidence[index].payload.args, check.args)
        assert.equal(evidence[index].payload.program, check.program)
        assert.equal(evidence[index].payload.exit_code, 0)
      }
    }
    assert.equal(events.filter((event) => event.type === 'run.completed').length, 1)
  } else {
    assert.equal(final.mission.status, 'failed')
    assert.equal(run.status, 'failed')
    assert.equal(evidence[0].status, 'failed')
    assert.equal(evidence[0].kind, 'artifact')
    assert.equal(events.filter((event) => event.type === 'run.completed').length, 0)
    assert.ok(events.some((event) => event.type === 'run.verification_failed'))
  }
  receipt.final = { mission: final.mission, tasks: final.tasks, run, evidence, events }
  await until('final browser projection', () => card.innerText(), (text) => expectedOutcome === 'passed' ? /completed/i.test(text) : /failed/i.test(text), 30_000)
  receipt.final_screenshot = await screenshot(`${expectedOutcome}-final`)
  await save()
}

try {
  for (const [role, url] of [['server', server], ['web', web]]) {
    const process = setup.processes[role]
    assert.ok(process?.pid && process.executable)
    await captureOwnedTestServerManifest({ root: setup.qa_root, server: url, binary: process.executable,
      pid: process.pid, pidPath: path.join(output, `${role}-ownership.json`) })
  }
  assert.equal((await request('/health')).mode, 'development')
  const require = createRequire(import.meta.url)
  const { chromium } = require(process.env.CRONY_PLAYWRIGHT_MODULE || 'playwright')
  browser = await chromium.launch({ channel: process.env.CRONY_BROWSER_CHANNEL || 'msedge', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, reducedMotion: 'reduce' })
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    if (![server, web].includes(url.origin) || url.pathname === '/api/demo/reset' || /verification-decision|action-approval/.test(url.pathname)) {
      report.blocked_requests.push({ method: route.request().method(), origin: url.origin, path: url.pathname })
      await route.abort()
    } else await route.continue()
  })
  page = await context.newPage()
  page.on('pageerror', (error) => report.errors.push(error.message.slice(0, 1000)))
  const bootstrap = page.waitForResponse((response) => response.url().startsWith(`${server}/api/demo/bootstrap`) && response.request().method() === 'POST')
  await page.goto(`${web}/#missions`, { waitUntil: 'networkidle', timeout: 30_000 })
  const boot = await bootstrap
  assert.equal(boot.status(), 200)
  demo = await boot.json()
  report.corp_id = demo.corp_id
  report.development_actor_id = demo.alice_actor_id
  const boundaryArgs = ['one two', 'two  spaces', 'quoted "value"', 'back\\slash']
  const argumentCheck = `require('node:assert/strict').deepEqual(process.argv.slice(1), ${JSON.stringify(boundaryArgs)})`
  const passingPolicy = { checks: [
    { type: 'artifact', min_bytes: 1 },
    { type: 'file', path: 'verify.txt', min_bytes: 9 },
    { type: 'command', program: 'node', args: ['-e', argumentCheck, ...boundaryArgs], timeout_ms: 10_000 },
    { type: 'test', program: 'node', args: ['--test', 'fixture.test.mjs'], timeout_ms: 10_000 },
    { type: 'json_schema', path: 'schema.json', required_keys: ['status', 'count'] },
    { type: 'screenshot', path: 'screenshot.png', min_bytes: 16 },
  ], manual_gate: null }
  const passedTitle = `[verification-matrix] Policy browser pass ${randomUUID().slice(0, 8)}`
  const editor = await prepareMission(passedTitle)
  for (const [index, check] of passingPolicy.checks.entries()) await fillCheck(editor, index, check)
  await editorViewport(editor, 'desktop', 1440, 1050, passingPolicy)
  await editorViewport(editor, 'mobile', 390, 844, passingPolicy)
  await saveAndLaunch(passedTitle, passingPolicy, 'passed')
  const failedTitle = `[verification-matrix] Policy browser floor failure ${randomUUID().slice(0, 8)}`
  const failingEditor = await prepareMission(failedTitle)
  const failingPolicy = { checks: [{ type: 'artifact', min_bytes: 10_000_000 }], manual_gate: null }
  await fillCheck(failingEditor, 0, failingPolicy.checks[0])
  await saveAndLaunch(failedTitle, failingPolicy, 'failed')
  const sourceHead = (await execute('git', ['-C', setup.source, 'rev-parse', 'HEAD'])).stdout.trim()
  const dirty = (await execute('git', ['-C', setup.source, 'status', '--porcelain'])).stdout.trim()
  assert.equal(sourceHead, setup.source_commit)
  assert.equal(dirty, '')
  assert.equal(report.errors.length, 0)
  assert.equal(report.blocked_requests.length, 0)
  report.source_unchanged = true
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'
  report.failure = String(error.message).replace(/\b(?:postgres(?:ql)?):\/\/\S+/g, '[database URL withheld]').slice(0, 2000)
  if (page) report.failure_screenshot = await screenshot('failure').catch(() => null)
  process.exitCode = 1
} finally {
  await browser?.close()
  report.finished_at = new Date().toISOString()
  await save()
  console.log(JSON.stringify({ status: report.status, stage: report.stage, report: path.join(output, 'report.json'), failure: report.failure }))
}
