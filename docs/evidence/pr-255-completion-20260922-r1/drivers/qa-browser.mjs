import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'

assert.ok(path.isAbsolute(process.env.ECORP_ISSUE161_QA ?? ''), 'Explicit owned QA root required')
const qa = process.env.ECORP_ISSUE161_QA
const demo = JSON.parse(await readFile(path.join(qa, 'demo.json'), 'utf8'))
const baseline = JSON.parse(await readFile(path.join(qa, 'authority-baseline.json'), 'utf8'))
const host = JSON.parse((await readFile(path.join(qa, 'host-state.json'), 'utf8')).replace(/^\uFEFF/, ''))
const owned = JSON.parse(await readFile(path.join(qa, 'api-shared.json'), 'utf8'))
const api = 'http://127.0.0.1:18971'
const web = 'http://127.0.0.1:15471'
assert.equal(owned.test_owned, true)
assert.equal(owned.workspace.toLowerCase(), qa.toLowerCase())
assert.equal(owned.server_state, 'running')
assert.equal(owned.server_url, api)
assert.ok(host.processes.web?.pid)
const output = path.join(qa, 'browser')
await mkdir(output)
const report = { status: 'running', started_at: new Date().toISOString(), api, web,
  scope: 'Actual Edge browser, native Rust server and separately enrolled native runner; deterministic fake-process, development identity, same Windows host.',
  source_commit: baseline.source_commit, page_errors: [], blocked_requests: [], screenshots: [], authority_views: [] }
const save = () => writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n')
const allow = new Set(['path', 'pathext', 'systemroot', 'windir', 'comspec', 'temp', 'tmp', 'userprofile',
  'homedrive', 'homepath', 'home', 'appdata', 'localappdata', 'programdata', 'programfiles', 'programfiles(x86)',
  'programw6432', 'systemdrive', 'username', 'userdomain', 'computername', 'psmodulepath',
  'number_of_processors', 'processor_architecture', 'os'])
const browserEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) => allow.has(key.toLowerCase())))
assert.ok(!Object.keys(browserEnvironment).some(key => /^(PG|CRONY_|ECORP_|GH_|GITHUB_|AZURE_)|DATABASE_URL|TOKEN|SECRET|PASSWORD/i.test(key)))
report.browser_environment_keys = Object.keys(browserEnvironment).sort()
report.browser_database_or_provider_credentials_inherited = false
const require = createRequire(import.meta.url)
const { chromium } = require(process.env.CRONY_PLAYWRIGHT_MODULE)
let browser, page
async function snapshot() {
  const response = await fetch(api + '/api/corps/' + demo.corp_id + '/snapshot?actor_id=' + demo.alice_actor_id,
    { redirect: 'error', signal: AbortSignal.timeout(10_000) })
  assert.equal(response.status, 200)
  return response.json()
}
async function until(label, check) {
  const end = Date.now() + 90_000
  while (Date.now() < end) {
    const value = await check()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  throw new Error('Timed out: ' + label)
}
async function capture(name) {
  const file = path.join(output, name + '.png')
  await page.screenshot({ path: file, fullPage: true })
  report.screenshots.push({ file: name + '.png', sha256: createHash('sha256').update(await readFile(file)).digest('hex') })
  await save()
}
async function advanced(selector) {
  const details = page.locator('details.mission-advanced-options').filter({ has: page.locator(selector) })
  assert.equal(await details.count(), 1)
  if (!(await details.evaluate(element => element.open))) await details.locator('summary').click()
}
try {
  await save()
  browser = await chromium.launch({ channel: 'msedge', headless: true, env: browserEnvironment })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' })
  await context.route('**/*', async route => {
    const url = new URL(route.request().url())
    if (![api, web].includes(url.origin) || url.pathname === '/api/demo/reset') {
      report.blocked_requests.push({ method: route.request().method(), origin: url.origin, path: url.pathname })
      await route.abort()
    } else await route.continue()
  })
  page = await context.newPage()
  page.on('pageerror', error => report.page_errors.push(error.message))
  report.stage = 'factory authority'
  await page.goto(web + '/#factory', { waitUntil: 'networkidle', timeout: 30_000 })
  await page.locator('.live-indicator.live-live').waitFor({ timeout: 30_000 })
  const authority = page.getByTestId('factory-panel').getByTestId('factory-authority')
  await authority.waitFor()
  await authority.locator('summary').click()
  for (const [name, width, height] of [['desktop', 1440, 1000], ['mobile', 390, 844]]) {
    await page.setViewportSize({ width, height })
    await authority.scrollIntoViewIfNeeded()
    const fields = await authority.locator('dl > div').evaluateAll(rows =>
      Object.fromEntries(rows.map(row => [row.querySelector('dt').textContent, row.querySelector('dd').textContent])))
    assert.equal(fields['Control plane'], api)
    assert.equal(fields.Corp, demo.corp_id)
    assert.equal(fields['Claim authority'], baseline.shared.authority.claim_authority_id)
    assert.equal(fields['Project namespace'], 'ecorp-qa/161')
    assert.match(fields.Mode, /^Development or unverified/)
    assert.ok((await authority.innerText()).includes('Work item pinned to this Corp ledger'))
    const layout = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }))
    assert.ok(layout.document <= width, 'Authority view overflows the viewport')
    report.authority_views.push({ name, width, height, fields, layout })
    await capture(name + '-authority')
  }
  await page.setViewportSize({ width: 1440, height: 1000 })
  report.stage = 'browser mission authoring'
  await page.goto(web + '/#missions', { waitUntil: 'networkidle', timeout: 30_000 })
  await page.locator('.live-indicator.live-live').waitFor({ timeout: 30_000 })
  const newMission = page.getByRole('button', { name: 'New mission', exact: true })
  if (await newMission.isVisible()) await newMission.click()
  const title = 'QA browser-to-runner authority regression PR255'
  await page.locator('#mission-title').fill(title)
  await advanced('#mission-description')
  await page.locator('#mission-description').fill('Exercise this owned synthetic source through the actual browser, server and runner. Preserve the verified result and retained workspace.')
  const targets = await page.locator('#mission-repository option').evaluateAll(items => items.filter(i => i.value).map(i => ({ value: i.value, source: JSON.parse(i.value) })))
  const matches = targets.filter(item => item.source[0].toLowerCase() === 'all-the-vibes/ecorp' && item.source[2] === baseline.source_commit)
  assert.equal(matches.length, 1, 'Expected exactly the registered immutable fixture source')
  await page.locator('#mission-repository').selectOption(matches[0].value)
  await page.getByRole('checkbox', { name: /Confirm this target/ }).check()
  await advanced('#mission-deliverable')
  await page.getByRole('checkbox', { name: /Developer fixtures/ }).check()
  await page.locator('#mission-adapter').selectOption('fake-process')
  await page.locator('#mission-strategy').selectOption('single')
  await page.locator('#mission-deliverable').selectOption('review_only_report')
  await page.getByRole('checkbox', { name: /Commit verified work/ }).uncheck()
  await page.getByRole('checkbox', { name: /Save without starting/ }).check()
  await page.getByRole('button', { name: 'Review and build', exact: true }).click()
  await page.getByRole('checkbox', { name: /Custom verification/ }).check()
  const editor = page.getByTestId('mission-verification-editor')
  await editor.getByLabel('Verifier check 1 type', { exact: true }).selectOption('artifact')
  await editor.getByLabel('Minimum artifact bytes', { exact: true }).fill('1')
  await editor.getByRole('button', { name: 'Add check', exact: true }).click()
  await editor.locator('.verification-check-tabs button').nth(1).click()
  await editor.getByLabel('Verifier check 2 type', { exact: true }).selectOption('file')
  await editor.getByLabel('Worktree-relative path', { exact: true }).fill('result.md')
  await editor.getByLabel('Minimum bytes', { exact: true }).fill('1')
  await editor.getByLabel('Final reviewer gate').selectOption('none')
  const policy = { checks: [{ type: 'artifact', min_bytes: 1 }, { type: 'file', path: 'result.md', min_bytes: 1 }], manual_gate: null }
  await capture('desktop-authored-verifiers')
  const creation = page.waitForResponse(response => response.url() === api + '/api/corps/' + demo.corp_id + '/missions' && response.request().method() === 'POST')
  await page.getByRole('button', { name: 'Save plan', exact: true }).click()
  const response = await creation
  assert.equal(response.status(), 200)
  const authored = response.request().postDataJSON()
  assert.deepEqual(authored.verification_policy, policy)
  assert.equal(authored.preferred_adapter, 'fake-process')
  const created = await response.json()
  report.created = created
  report.authored = authored
  await save()
  const before = (await snapshot()).snapshot
  const task = before.tasks.find(t => t.id === created.task_id)
  assert.deepEqual(task.verification_policy, policy)
  assert.equal(before.runs.filter(r => r.task_id === task.id).length, 0)
  const card = page.locator('[data-mission-id="' + created.mission_id + '"]')
  await card.locator('.status-chip-ready').waitFor()
  await capture('desktop-saved-mission')
  report.stage = 'native runner execution'
  const launched = page.waitForResponse(value => value.url() === api + '/api/corps/' + demo.corp_id + '/missions/' + created.mission_id + '/launch' && value.request().method() === 'POST')
  await card.getByTestId('work-result-card').getByRole('button', { name: 'Start mission', exact: true }).click()
  assert.equal((await launched).status(), 200)
  const final = await until('persisted completed mission', async () => {
    const state = (await snapshot()).snapshot
    const mission = state.missions.find(m => m.id === created.mission_id)
    const runs = state.runs.filter(r => r.task_id === created.task_id)
    assert.ok(runs.length <= 1)
    if (runs.some(r => ['failed', 'cancelled', 'lost'].includes(r.status))) throw new Error('Browser mission failed; retain exact IDs')
    return mission?.status === 'completed' && runs[0]?.workspace_disposition === 'preserved' ? { mission, run: runs[0], state } : null
  })
  assert.equal(final.run.status, 'completed')
  assert.equal(final.run.verification_status, 'passed')
  assert.equal(final.run.source_base_commit, baseline.source_commit)
  assert.ok(['runner-a', 'runner-b'].some(role => final.run.workspace_path.toLowerCase().startsWith(path.join(qa, role).toLowerCase() + path.sep)))
  const evidence = final.state.verification_evidence.filter(e => e.run_id === final.run.id)
  assert.equal(evidence.length, 2)
  assert.ok(evidence.every(e => e.status === 'passed'))
  report.final = { mission: final.mission, run: final.run, evidence }
  await until('browser completion projection', async () => /completed/i.test(await card.innerText()))
  await capture('desktop-completed-mission')
  await page.setViewportSize({ width: 390, height: 844 })
  await card.scrollIntoViewIfNeeded()
  await capture('mobile-completed-mission')
  assert.equal(report.page_errors.length, 0)
  assert.equal(report.blocked_requests.length, 0)
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'
  report.failure = String(error.message).replace(/\bpostgres(?:ql)?:\/\/\S+/g, '[database URL withheld]')
  if (page) await capture('failure').catch(() => {})
  process.exitCode = 1
} finally {
  await browser?.close()
  report.finished_at = new Date().toISOString()
  await save()
  console.log(JSON.stringify({ status: report.status, stage: report.stage, failure: report.failure, report: path.join(output, 'report.json') }))
}
