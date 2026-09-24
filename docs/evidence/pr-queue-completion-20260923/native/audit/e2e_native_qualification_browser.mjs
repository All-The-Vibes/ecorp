// Reuses the launch-admission browser flow and native artifact client.
// Requires an explicitly owned native stack; never resets its database.
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { startSurface, supplementalState } from "file:///<private-evidence>/queue-audit-native-r471/native_qualification_attempt.mjs"
import { downloadVerifiedArtifact } from "file:///<reviewed-worktree>/tools/artifact_client.mjs"

const attempt = process.argv[3] === 'readback' ? await startSurface('browser') : null

assert.equal(process.env.CRONY_NATIVE_QUALIFICATION, '1', 'Explicit qualification opt-in required')
assert.equal(process.argv.length, 4)
assert.equal(process.argv[2], '--phase')
const phase = process.argv[3]
assert.ok(['prepare', 'readback'].includes(phase))
function ownedOrigin(value, port) {
  const url = new URL(value)
  assert.equal(url.protocol, 'http:')
  assert.equal(url.hostname, '127.0.0.1')
  assert.equal(url.port, port)
  assert.equal(url.pathname, '/')
  assert.ok(!url.username && !url.password && !url.search && !url.hash)
  return url.origin
}
const server = ownedOrigin(process.env.CRONY_SERVER_HTTP, '8992')
const web = ownedOrigin(process.env.CRONY_NATIVE_WEB, '5298')
assert.ok(process.env.CRONY_NATIVE_OUTPUT && path.isAbsolute(process.env.CRONY_NATIVE_OUTPUT))
const output = path.resolve(process.env.CRONY_NATIVE_OUTPUT)
const reportPath = path.join(output, 'browser-qualification.json')
const root = "<reviewed-worktree>"
const require = createRequire(import.meta.url)
const { chromium } = require(process.env.CRONY_PLAYWRIGHT_MODULE || 'playwright')
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const httpResults = []
let report

async function request(route, body, expected = 200) {
  const response = await fetch(`${server}${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  })
  if (body !== undefined || response.status !== expected) {
    httpResults.push({ method: body === undefined ? 'GET' : 'POST', route, status: response.status, expected })
  }
  // Never include arbitrary response bodies in assertion errors or public logs.
  assert.equal(response.status, expected, `${route}: unexpected HTTP status`)
  return response.json()
}
const demo = await request('/api/demo/bootstrap', {})
const api = (suffix) => `/api/corps/${demo.corp_id}${suffix}`
const snapshot = () => request(api(`/snapshot?actor_id=${demo.alice_actor_id}`))
function missionView(state, id) {
  const mission = state.snapshot.missions.find((item) => item.id === id)
  assert.ok(mission, 'Retained mission missing; do not reset the database')
  const tasks = state.snapshot.tasks.filter((item) => item.mission_id === id)
  assert.equal(tasks.length, 1)
  const task = tasks[0]
  const runs = state.snapshot.runs.filter((item) => item.task_id === task.id)
  return { mission, task, runs }
}
function contractDigest(task) {
  const canonical = JSON.stringify({ contract: task.contract, policy: task.verification_policy },
    (_, value) => value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value)
  return createHash('sha256').update(canonical).digest('hex')
}
async function waitFor(predicate) {
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    const state = await snapshot()
    const current = missionView(state, report.mission_id)
    assert.ok(!['failed', 'cancelled'].includes(current.mission.status), 'Native mission failed')
    if (predicate(current, state)) return { ...current, state }
    await delay(250)
  }
  throw new Error('Native mission did not reach its required persisted state')
}
const save = () => writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
await mkdir(output, { recursive: true })
if (phase === 'prepare') {
  try {
    const previous = JSON.parse(await readFile(reportPath, 'utf8'))
    assert.equal(previous.phase, 'starting', 'An existing mission must be resumed, never replaced')
    assert.ok(previous.failure && !previous.mission_id)
    await rename(reportPath, path.join(output, `browser-failed-${Date.now()}.json`))
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  report = {
    schema_version: 1, phase: 'starting', started_at: new Date().toISOString(),
    source_commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    source_branch: execFileSync('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf8' }).trim(),
    server, web, corp_id: demo.corp_id,
    title: `Native local qualification ${randomUUID()}`,
    assurance: 'Development identities and deterministic fake-process; no vendor inference or production identity claim.',
    http_results: httpResults,
  }
  await save()
} else {
  report = JSON.parse(await readFile(reportPath, 'utf8'))
  attempt?.prepare(report)
  assert.ok(['prepared', 'readback_complete'].includes(report.phase))
  assert.equal(report.server, server)
  assert.equal(report.web, web)
  assert.equal(report.corp_id, demo.corp_id)
}
const browser = await chromium.launch({ channel: process.env.CRONY_BROWSER_CHANNEL || 'chrome', headless: true })
const pageErrors = []
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 }, reducedMotion: 'reduce' })
  page.on('pageerror', () => pageErrors.push('Browser pageerror; inspect local browser diagnostics'))
  await page.goto(`${web}/#missions`, { waitUntil: 'networkidle', timeout: 30_000 })
  await page.locator('.live-indicator.live-live').waitFor({ timeout: 30_000 })
  if (phase === 'prepare') {
    if (!(await page.locator('#mission-title').isVisible())) {
      await page.getByRole('button', { name: 'New mission', exact: true }).click()
    }
    await page.locator('#mission-title').fill(report.title)
    await page.locator('details.mission-advanced-options')
      .filter({ has: page.locator('#mission-description') }).locator('summary').click()
    await page.locator('#mission-description').fill(
      'Create a non-sensitive deterministic result in the isolated source worktree. Require native artifact verification and independent outcome review. No external effects.')
    const choices = await page.locator('#mission-repository option').evaluateAll((items) =>
      items.filter((item) => item.value).map((item) => ({ value: item.value, source: JSON.parse(item.value) })))
    const wanted = process.env.CRONY_NATIVE_SOURCE_REPOSITORY
    const targets = wanted ? choices.filter((item) => item.source[0] === wanted) : choices
    assert.equal(targets.length, 1, 'Exactly one owned source must be selected')
    report.source = { repository: targets[0].source[0], base_ref: targets[0].source[1], base_commit: targets[0].source[2] }
    await page.locator('#mission-repository').selectOption(targets[0].value)
    await page.getByRole('checkbox', { name: /Confirm this target/ }).check()
    await page.locator('details.mission-advanced-options')
      .filter({ has: page.locator('#mission-deliverable') }).locator('summary').click()
    await page.getByRole('checkbox', { name: /Developer fixtures/ }).check()
    await page.locator('#mission-adapter').selectOption('fake-process')
    await page.locator('#mission-strategy').selectOption('independent-review')
    await page.locator('#mission-deliverable').selectOption('review_only_report')
    await page.getByRole('checkbox', { name: /Commit verified work/ }).uncheck()
    await page.getByRole('checkbox', { name: /Save without starting/ }).check()
    await page.getByRole('button', { name: 'Review and build', exact: true }).click()
    const createdResponse = page.waitForResponse((response) =>
      response.url() === `${server}${api('/missions')}` && response.request().method() === 'POST')
    await page.getByRole('button', { name: 'Save plan', exact: true }).click()
    const response = await createdResponse
    assert.equal(response.status(), 200)
    report.mission_id = (await response.json()).mission_id
    report.phase = 'created'
    const held = missionView(await snapshot(), report.mission_id)
    assert.equal(held.mission.status, 'ready')
    assert.equal(held.runs.length, 0)
    report.task_id = held.task.id
    report.contract_version = held.task.contract_version
    report.contract_digest = contractDigest(held.task)
    report.verification_policy = held.task.verification_policy
    await save()
    const card = page.locator(`[data-mission-id="${report.mission_id}"]`)
    await card.locator('.status-chip-ready').waitFor()
    const launchedResponse = page.waitForResponse((item) =>
      item.url() === `${server}${api(`/missions/${report.mission_id}/launch`)}` && item.request().method() === 'POST')
    await card.getByTestId('work-result-card').getByRole('button', { name: 'Start mission', exact: true }).click()
    const launchResponse = await launchedResponse
    assert.equal(launchResponse.status(), 200)
    report.run_id = (await launchResponse.json()).run_id
    report.phase = 'launched'
    await save()
    const waiting = await waitFor(({ runs }, state) => runs.length === 1 &&
      runs[0].status === 'waiting_for_approval' && runs[0].workspace_disposition === 'preserved' &&
      state.snapshot.verification_requests.some((item) => item.run_id === runs[0].id && item.status === 'pending'))
    assert.equal(waiting.runs[0].id, report.run_id)
    const evidence = waiting.state.snapshot.verification_evidence.filter((item) => item.run_id === report.run_id)
    assert.ok(evidence.length > 0 && evidence.every((item) => item.status === 'passed'))
    report.verifier_evidence = evidence.map((item) => ({ id: item.id, kind: item.kind, status: item.status, check_index: item.check_index }))
    const decisionRoute = api(`/runs/${report.run_id}/verification-decision`)
    await request(decisionRoute, { actor_id: demo.alice_actor_id, approved: true, note: 'Requester must not self-review.' }, 403)
    await request(decisionRoute, { actor_id: demo.eve_actor_id, approved: true, note: 'Nonmember must not review.' }, 403)
    const decision = await request(decisionRoute, {
      actor_id: demo.bob_actor_id, approved: true, note: 'Independent development reviewer accepts the verified non-sensitive local artifact.',
    })
    assert.equal(decision.status, 'approved')
    report.reviewer_actor_id = demo.bob_actor_id
    report.review_status = decision.status
  }
  const completed = await waitFor(({ mission, runs }) => mission.status === 'completed' &&
    runs.length === 1 && runs[0].status === 'completed' && runs[0].workspace_disposition === 'preserved')
  const run = completed.runs[0]
  assert.equal(run.id, report.run_id)
  assert.equal(completed.task.id, report.task_id)
  assert.equal(contractDigest(completed.task), report.contract_digest)
  assert.equal(run.verification_status, 'passed')
  assert.equal(completed.task.verification_status, 'passed')
  assert.ok(run.workspace_path && run.workspace_branch)
  assert.ok(!Object.hasOwn(run, 'artifact_path'))
  const artifactBytes = await downloadVerifiedArtifact(server, demo, run)
  const acceptance = {
    mission_status: completed.mission.status, task_status: completed.task.status, run_status: run.status,
    verification_status: run.verification_status, artifact_id: run.artifact_id, artifact_sha256: run.artifact_sha256,
    artifact_bytes: artifactBytes.length, artifact_signature: run.artifact_signature,
    workspace_path: run.workspace_path, workspace_branch: run.workspace_branch, workspace_disposition: run.workspace_disposition,
  }
  const review = completed.state.snapshot.verification_requests.find((item) => item.run_id === run.id)
  assert.equal(review.status, 'approved')
  report.verification_request_key = review.run_id
  report.verification_review = {
    run_id: review.run_id, task_id: review.task_id, gate_type: review.gate_type,
    status: review.status, decided_by: review.decided_by, decided_at: review.decided_at,
  }
  report.contract_version = completed.task.contract_version
  const physicalArtifact = await readFile(path.join(run.workspace_path, 'result.md'))
  assert.equal(createHash('sha256').update(physicalArtifact).digest('hex'), run.artifact_sha256)
  assert.ok(physicalArtifact.equals(artifactBytes), 'Physical isolated artifact must equal native download')
  report.physical_artifact_equal = true
  const sourcePath = path.join(output, 'source-fixture')
  assert.equal(execFileSync('git', ['-C', sourcePath, 'status', '--porcelain'], { encoding: 'utf8' }).trim(), '',
    'Configured source checkout must remain unchanged')
  if (phase === 'prepare') report.before_restart = acceptance
  else assert.deepEqual(acceptance, report.before_restart, 'Restart must preserve exact accepted outcome and artifact')
  // Navigate normally again so this is a fresh UI projection, not an API-only claim.
  await page.reload({ waitUntil: 'networkidle' })
  await page.locator('.live-indicator.live-live').waitFor()
  const missionButton = page.getByRole('button').filter({ hasText: report.title })
  if (await missionButton.count()) await missionButton.first().click()
  const finalCard = page.locator(`[data-mission-id="${report.mission_id}"]`)
  await finalCard.waitFor()
  await finalCard.locator('.status-chip-completed').waitFor()
  await page.screenshot({ path: path.join(output, `browser-${phase}-completed.png`), fullPage: true })
  assert.deepEqual(pageErrors, [])
  if (phase === 'readback') {
    report.after_restart = acceptance
    report.restart_agreement = true
    report.http_results.push(...httpResults)
    const runtime = JSON.parse(await readFile(path.join(output, 'runtime-qualification.json'), 'utf8'))
    const baseReadback = await page.evaluate(async ({ server, corp, actor }) => {
      const response = await fetch(`${server}/api/corps/${corp}/base-audit`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ actor_id: actor, command: { action: 'status' } }),
      })
      if (response.status !== 200) throw new Error('Native Base browser readback denied')
      return response.json()
    }, { server, corp: demo.corp_id, actor: demo.alice_actor_id })
    const baseDestination = baseReadback.audit.destinations.find((item) => item.id === runtime.destination_id)
    const supplemental = await supplementalState()
    assert.equal(baseDestination.verified_digest, supplemental?.local_terminal_state.verified_digest ?? runtime.checkpoint.digest)
    assert.equal(baseDestination.verified_sequence, supplemental?.local_terminal_state.verified_sequence ?? runtime.checkpoint.checkpoint.last_sequence)
    if (supplemental) assert.equal(baseDestination.enabled, false)
    report.base_readback = {
      source: 'Native Base API read from the real UI browser origin, with rendered evidence checked separately.',
      destination_id: baseDestination.id, verified_digest: baseDestination.verified_digest,
      verified_sequence: baseDestination.verified_sequence,
      no_active_intent: !baseReadback.audit.intents.some((item) => item.id === runtime.intent.id),
    }
    const archiveEvidence = await readFile(path.join(output, 'github-archive-qualification.json'), 'utf8').then(JSON.parse).catch((error) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (archiveEvidence?.complete) {
      const auditReadback = await page.evaluate(async ({ server, corp, actor }) => {
        const response = await fetch(`${server}/api/corps/${corp}/state-audit`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ actor_id: actor, command: { action: 'status' } }),
        })
        if (response.status !== 200) throw new Error('Native archive browser readback denied')
        return response.json()
      }, { server, corp: demo.corp_id, actor: demo.alice_actor_id })
      const receipt = auditReadback.receipts.find((item) => item.destination_id === runtime.github_destination_id && item.checkpoint_digest === runtime.checkpoint.digest)
      assert.deepEqual(receipt, archiveEvidence.receipt)
      report.archive_readback = { source: 'Native audit status from actual UI browser origin, also rendered in Audit evidence.', receipt }
    }
    const panel = page.getByTestId('audit-evidence-panel')
    await panel.locator('summary').click()
    await panel.getByTestId('base-destination-evidence').waitFor()
    await panel.getByLabel('Base destination').selectOption(runtime.destination_id)
    const finality = panel.locator('[data-audit-history-kind="finalized"]')
    await finality.waitFor()
    assert.ok((await panel.getByTestId('base-destination-evidence').innerText()).includes(runtime.checkpoint.digest))
    assert.ok((await finality.innerText()).includes(runtime.native_event.transaction_hash))
    const receiptText = await panel.getByTestId('archive-receipt-evidence').allTextContents()
    assert.ok(receiptText.some((text) => text.includes(runtime.github_receipt.witness.commit)
      && text.includes(runtime.checkpoint.digest) && text.includes('Recorded')))
    report.visible_audit_projection = { checkpoint_digest: runtime.checkpoint.digest,
      transaction_hash: runtime.native_event.transaction_hash, commit: runtime.github_receipt.witness.commit }
    await page.screenshot({ path: path.join(output, 'browser-audit-evidence.png'), fullPage: true })
    await page.locator('#operator-actor').selectOption(demo.eve_actor_id)
    await page.locator(`[data-testid="audit-evidence-panel"][data-actor-id="${demo.eve_actor_id}"] summary`).waitFor()
    const denied = page.waitForResponse((response) =>
      response.url() === `${server}${api('/base-audit')}` &&
      response.request().postDataJSON()?.actor_id === demo.eve_actor_id)
    await page.getByTestId('audit-evidence-panel').locator('summary').click()
    assert.equal((await denied).status(), 403)
    await page.getByTestId('audit-evidence-panel').getByRole('alert').waitFor()
    assert.ok(!(await page.getByTestId('audit-evidence-panel').innerText()).includes(runtime.checkpoint.digest))
    await page.locator('#operator-actor').selectOption(demo.alice_actor_id)
    await page.locator(`[data-testid="audit-evidence-panel"][data-actor-id="${demo.alice_actor_id}"] summary`).waitFor()
    await page.getByTestId('audit-evidence-panel').locator('summary').click()
    await page.getByTestId('base-destination-evidence').waitFor()
    assert.ok((await page.getByTestId('base-destination-evidence').innerText()).includes(runtime.checkpoint.digest))
    report.ui_authorization = { denied_status: 403, prior_viewer_evidence_absent: true, owner_projection_restored: true }
    assert.deepEqual(pageErrors, [])
  }
  report.phase = phase === 'prepare' ? 'prepared' : 'readback_complete'
  report.updated_at = new Date().toISOString()
  report.page_errors = pageErrors
  await save()
  if (attempt) await attempt.succeed(report)
  console.log(JSON.stringify({ phase: report.phase, mission_id: report.mission_id, task_id: report.task_id, run_id: report.run_id }))
} catch (error) {
  report.failure = { phase, name: error.name, reason: 'Qualification assertion or runtime operation failed; no pass claimed.' }
  await save()
  throw error
} finally {
  await browser.close()
}
