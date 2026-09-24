import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const qa = process.env.ECORP_COMPLETION_QA_ROOT
const product = process.env.ECORP_COMPLETION_PRODUCT
const binaries = process.env.ECORP_COMPLETION_BINARIES
assert.ok([qa, product, binaries].every((value) => path.isAbsolute(value ?? '')))
assert.match(path.basename(qa), /^pr283-state-audit-/)
const owned = JSON.parse(await readFile(path.join(qa, 'ownership.json'), 'utf8'))
assert.equal(owned.test_owned, true)
assert.equal(owned.purpose, 'pr283-state-audit')
assert.equal(path.resolve(owned.workspace), path.resolve(qa))
function origin(value) {
  const url = new URL(value)
  assert.equal(url.protocol, 'http:')
  assert.equal(url.hostname, '127.0.0.1')
  assert.ok(['59131', '59132'].includes(url.port))
  assert.ok(!url.username && !url.password && !url.search && !url.hash)
  assert.equal(url.pathname, '/')
  return url.origin
}
const server = origin(owned.plan.server)
const web = origin(owned.plan.web)
assert.notEqual(server, web)
const output = path.join(qa, 'evidence/browser-audit')
await mkdir(output)
const report = { pr: 283, status: 'running', started_at_utc: new Date().toISOString(),
  tested_staged_tree: process.env.ECORP_COMPLETION_TESTED_TREE, stage: 'ownership',
  scope: 'Native owned PostgreSQL/server/runner and real browser with deterministic fake-process; local signer and offline verification; no external publication or inference.',
  errors: [], blocked_requests: [], screenshots: [], checks: [] }
const save = () => writeFile(path.join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
const execute = promisify(execFile)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const { captureOwnedTestServerManifest } = await import(pathToFileURL(path.join(product, 'tools/owned_test_stack.mjs')))
let browser, page
let demo = owned.demo
async function request(route, body, expected = 200) {
  assert.ok(route === '/health' || route.startsWith(`/api/corps/${demo.corp_id}/`))
  const response = await fetch(`${server}${route}`, { method: body ? 'POST' : 'GET',
    headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined,
    redirect: 'error', signal: AbortSignal.timeout(20_000) })
  const text = await response.text()
  assert.equal(response.status, expected, `${route.split('?')[0]}: HTTP ${response.status}; ${text.slice(0, 500)}`)
  return { status: response.status, text, value: JSON.parse(text) }
}
const snapshot = async () => (await request(`/api/corps/${demo.corp_id}/snapshot?actor_id=${demo.alice_actor_id}`)).value.snapshot
const audit = (command, actor = demo.alice_actor_id, expected = 200) => request(`/api/corps/${demo.corp_id}/state-audit`, { actor_id: actor, command }, expected)
async function until(label, read, predicate, timeout = 90_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await read()
    if (predicate(value)) return value
    await sleep(150)
  }
  throw new Error(`Timed out waiting for ${label}`)
}
async function screenshot(name) {
  const file = path.join(output, `${name}.png`)
  await page.screenshot({ path: file, fullPage: true })
  report.screenshots.push({ file, sha256: createHash('sha256').update(await readFile(file)).digest('hex') })
  await save()
}
async function advanced(containing) {
  const details = page.locator('details.mission-advanced-options').filter({ has: page.locator(containing) })
  assert.equal(await details.count(), 1)
  if (!(await details.evaluate((element) => element.open))) await details.locator('summary').click()
}
try {
  for (const [role, url] of [['server', server], ['web', web]]) {
    const process = owned.processes[role]
    await captureOwnedTestServerManifest({ root: qa, server: url, binary: process.executable,
      pid: process.pid, pidPath: path.join(output, `${role}-ownership.json`) })
  }
  assert.equal((await request('/health')).value.mode, 'development')
  const require = createRequire(import.meta.url)
  const { chromium } = require(process.env.CRONY_PLAYWRIGHT_MODULE)
  browser = await chromium.launch({ channel: 'msedge', headless: true })
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
  report.stage = 'browser mission authoring'
  await save()
  const bootstrap = page.waitForResponse((response) => response.url().startsWith(`${server}/api/demo/bootstrap`) && response.request().method() === 'POST')
  await page.goto(`${web}/#missions`, { waitUntil: 'networkidle', timeout: 30_000 })
  const boot = await bootstrap
  assert.equal(boot.status(), 200)
  const browserDemo = await boot.json()
  assert.equal(browserDemo.corp_id, demo.corp_id)
  assert.equal(browserDemo.alice_actor_id, demo.alice_actor_id)
  await page.locator('.live-indicator.live-live').waitFor({ timeout: 30_000 })
  const create = page.getByRole('button', { name: 'New mission', exact: true })
  if (await create.isVisible()) await create.click()
  await page.locator('#mission-title').fill(`[verification-matrix] Audited mission ${randomUUID().slice(0, 8)}`)
  await advanced('#mission-description')
  await page.locator('#mission-description').fill('Execute the caller-owned deterministic source fixture and retain verifier evidence.')
  const targets = await page.locator('#mission-repository option').evaluateAll((options) => options.filter((item) => item.value).map((item) => ({ value: item.value, source: JSON.parse(item.value) })))
  const matches = targets.filter((item) => item.source[0] === owned.source.repository && item.source[2] === owned.source.base_commit)
  assert.equal(matches.length, 1)
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
  const policy = { checks: [{ type: 'artifact', min_bytes: 1 }], manual_gate: null }
  const creation = page.waitForResponse((response) => response.url() === `${server}/api/corps/${demo.corp_id}/missions` && response.request().method() === 'POST')
  await page.getByRole('button', { name: 'Save plan', exact: true }).click()
  const createdResponse = await creation
  assert.equal(createdResponse.status(), 200)
  assert.deepEqual(createdResponse.request().postDataJSON().verification_policy, policy)
  const created = await createdResponse.json()
  const saved = await snapshot()
  const task = saved.tasks.find((row) => row.id === created.task_id)
  assert.ok(task)
  assert.equal(saved.missions.find((row) => row.id === created.mission_id).status, 'ready')
  assert.equal(saved.runs.filter((row) => row.task_id === task.id).length, 0)
  await screenshot('mission-saved')
  report.mission_id = created.mission_id
  report.task_id = task.id
  report.stage = 'audit coverage and revision receipts'
  await save()
  const ledger = randomUUID()
  assert.equal((await audit({ action: 'initialize', ledger_id: ledger })).value.ledger_id, ledger)
  const baseline = (await audit({ action: 'cover', mission_id: created.mission_id })).value
  assert.equal(baseline.ledger_id, ledger)
  assert.equal(baseline.sequence, 1)
  assert.equal(baseline.decision, 'baseline')
  const deniedCoverage = await audit({ action: 'cover', mission_id: created.mission_id }, demo.bob_actor_id, 400)
  assert.match(deniedCoverage.value.error, /require an owner or admin/)
  const revisionRequest = { actor_id: demo.alice_actor_id, task_id: task.id, expected_contract_version: 1,
    next_action: 'redispatch', source_run_id: null, reason: 'Clarify the covered mission before its first run.', idempotency_key: randomUUID(),
    description: 'Execute the revised caller-owned deterministic source fixture and retain verifier evidence.',
    contract: { ...task.contract, expected_output: 'Persisted verification evidence from the corrected contract.' }, verification_policy: policy }
  const revisionRoute = `/api/corps/${demo.corp_id}/missions/${created.mission_id}/contract-revisions`
  const revised = (await request(revisionRoute, revisionRequest)).value
  assert.equal(revised.replayed, false)
  assert.equal(revised.revision.version, 2)
  const receipt = (await audit({ action: 'receipt', request_id: revisionRequest.idempotency_key })).value
  assert.equal(receipt.decision, 'accepted')
  assert.equal(receipt.sequence, 2)
  const replay = (await request(revisionRoute, revisionRequest)).value
  assert.equal(replay.replayed, true)
  assert.equal(replay.revision.id, revised.revision.id)
  assert.deepEqual((await audit({ action: 'receipt', request_id: revisionRequest.idempotency_key })).value, receipt)
  const staleRequest = { ...revisionRequest, idempotency_key: randomUUID(), reason: 'Stale version must be durably refused.' }
  await request(revisionRoute, staleRequest, 400)
  const refusal = (await audit({ action: 'receipt', request_id: staleRequest.idempotency_key })).value
  assert.equal(refusal.decision, 'refused')
  assert.equal(refusal.sequence, 3)
  await request(revisionRoute, staleRequest, 400)
  assert.deepEqual((await audit({ action: 'receipt', request_id: staleRequest.idempotency_key })).value, refusal)
  report.receipts = { baseline, accepted: receipt, refused: refusal, accepted_replay_stable: true, refused_replay_stable: true }
  report.stage = 'browser launch and native runner verification'
  await save()
  const card = page.locator(`[data-mission-id="${created.mission_id}"]`)
  await card.locator('.status-chip-ready').waitFor()
  const launch = page.waitForResponse((response) => response.url() === `${server}/api/corps/${demo.corp_id}/missions/${created.mission_id}/launch` && response.request().method() === 'POST')
  await card.getByTestId('work-result-card').getByRole('button', { name: 'Start mission', exact: true }).click()
  assert.equal((await launch).status(), 200)
  const final = await until('persisted verified completion', snapshot, (state) => state.missions.some((row) => row.id === created.mission_id && row.status === 'completed') && state.runs.some((row) => row.task_id === task.id && row.status === 'completed' && row.workspace_disposition === 'preserved'))
  const runs = final.runs.filter((row) => row.task_id === task.id)
  assert.equal(runs.length, 1)
  const run = runs[0]
  assert.equal(run.runner_id, owned.plan.runner_id)
  assert.equal(run.source_base_commit, owned.source.base_commit)
  const relative = path.relative(path.join(qa, 'runner'), run.workspace_path)
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative))
  assert.notEqual(path.resolve(run.workspace_path).toLowerCase(), path.resolve(qa, 'source').toLowerCase())
  const evidence = final.verification_evidence.filter((row) => row.run_id === run.id)
  assert.equal(evidence.length, 1)
  assert.equal(evidence[0].status, 'passed')
  assert.equal(final.tasks.find((row) => row.id === task.id).contract_version, 2)
  assert.equal(final.events.filter((row) => row.aggregate_id === run.id && row.type === 'run.completed').length, 1)
  report.run = run
  report.verification_evidence = evidence
  await until('completed browser projection', () => card.innerText(), (value) => /completed/i.test(value), 30_000)
  await screenshot('mission-completed')
  report.stage = 'checkpoint and independent offline verification'
  await save()
  report.checkpoint = (await audit({ action: 'checkpoint' })).value
  const exported = await audit({ action: 'export' })
  const archivePath = path.join(output, 'archive.json')
  await writeFile(archivePath, exported.text, { flag: 'wx' })
  assert.equal(exported.value.rows.length, 3)
  assert.equal(exported.value.rows.filter((row) => row.decision.request_id === revisionRequest.idempotency_key).length, 1)
  const publicKey = path.join(qa, 'evidence/audit-trusted-public.bin')
  const cli = path.join(binaries, 'crony-cli.exe')
  const verified = await execute(cli, ['audit-verify', archivePath, '--trusted-key-file', publicKey], { windowsHide: true })
  await writeFile(path.join(output, 'offline-verification.log'), verified.stdout + verified.stderr)
  report.offline_verification = JSON.parse(verified.stdout)
  assert.equal(report.offline_verification.verified, true)
  assert.equal(report.offline_verification.last_sequence, 3)
  const wrongKey = path.join(output, 'untrusted-public-key.bin')
  const wrongJwk = generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' })
  await writeFile(wrongKey, Buffer.from(wrongJwk.x, 'base64url'), { flag: 'wx' })
  let rejected = false
  try { await execute(cli, ['audit-verify', archivePath, '--trusted-key-file', wrongKey], { windowsHide: true }) }
  catch (error) { rejected = true; await writeFile(path.join(output, 'wrong-key-rejection.log'), `${error.stdout ?? ''}${error.stderr ?? ''}`) }
  assert.equal(rejected, true)
  report.wrong_key_rejected = true
  const source = path.join(qa, 'source')
  assert.equal((await execute('git', ['-C', source, 'rev-parse', 'HEAD'], { windowsHide: true })).stdout.trim(), owned.source.base_commit)
  assert.equal((await execute('git', ['-C', source, 'status', '--porcelain'], { windowsHide: true })).stdout.trim(), '')
  assert.equal(report.errors.length, 0)
  assert.equal(report.blocked_requests.length, 0)
  report.source_unchanged = true
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'
  report.failure = String(error.message).slice(0, 2500)
  if (page) await screenshot('failure').catch(() => {})
  process.exitCode = 1
} finally {
  await browser?.close()
  report.finished_at_utc = new Date().toISOString()
  await save()
  console.log(JSON.stringify({ status: report.status, stage: report.stage, report: path.join(output, 'report.json'), failure: report.failure }))
}
