// Owned native acceptance. Browser-only variants are reported separately.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, renameSync, existsSync, realpathSync } from 'node:fs'
import { resolve, join, basename, dirname, relative, isAbsolute } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { exerciseBrowserVariants } from './issue260-browser-variants-r4.mjs'
import { createPresentationChecks } from './issue264-presentation-browser-r12.mjs'
import { exercisePresentationVariants } from './issue264-presentation-variants-r13.mjs'
import { admitNativeAcceptance } from './issue264-native-admission-r1.mjs'
import { exerciseNativeMissionCreation } from './issue264-native-mission-create-r2.mjs'

const inputs = process.argv.slice(2)
const requiredArgs = ['--qa-root', '--postgres-bin', '--source-receipt', '--product-root', '--source-receipt-sha256']
assert.equal(inputs.length, requiredArgs.length * 2, 'Exactly the explicit caller inputs are required')
const args = Object.fromEntries(inputs.reduce((items, value, index, all) => index % 2 ? items : [...items, [value, all[index + 1]]], []))
assert.deepEqual(Object.keys(args).sort(), requiredArgs.sort(), 'Unknown or duplicate native driver argument')
const qa = resolve(args['--qa-root'] ?? ''), pg = resolve(args['--postgres-bin'] ?? '')
assert.ok(isAbsolute(args['--qa-root'] ?? '') && basename(dirname(qa)) === 'qa' && /^pr265-run-activity-issue264-[a-z0-9-]+$/i.test(basename(qa)))
assert.equal(realpathSync(qa), qa)
const load = (path) => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''))
const admission = await admitNativeAcceptance({
  productRoot: args['--product-root'], qaRoot: qa,
  sourceReceiptPath: args['--source-receipt'], sourceReceiptSha256: args['--source-receipt-sha256'],
})
const { product, ownership, sourceReceipt } = admission
const { server, web } = ownership.plan, { demo, source } = ownership
for (const key of ['corp_id', 'room_id', 'alice_actor_id', 'bob_actor_id', 'eve_actor_id']) {
  assert.match(demo[key], /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'Owned fixture identity: ' + key)
}
assert.equal(ownership.plan.runner_id, 'pr265-activity-qa')
assert.equal(ownership.plan.database.host, '127.0.0.1'); assert.equal(ownership.plan.database.name, 'pr265_activity')
for (const origin of [server, web]) assert.match(origin, /^http:\/\/127\.0\.0\.1:[1-9][0-9]{4}$/)
execFileSync('pwsh', ['-NoProfile', '-File', join(product, 'tools/qa_factory_run_activity.ps1'), '-Phase', 'Status', '-QaRoot', qa, '-PostgresBin', pg], { timeout: 30000, stdio: 'pipe' })
const { completeGraphFixtureLaunch } = await import(pathToFileURL(join(product, 'tools/task_graph_fixture.mjs')))
const prepared = load(join(qa, 'evidence/acceptance.json')), mid = prepared.mission_id
assert.equal(prepared.status, 'prepared')
assert.match(mid, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
const reportPath = join(qa, 'evidence/issue264-native-browser.json')
assert.ok(!existsSync(reportPath), 'Preserve prior acceptance; do not replay native effects')
const hash = (data) => createHash('sha256').update(data).digest('hex')
const report = {
  issues: [263, 264], status: 'accepting', started_at: new Date().toISOString(), actual_human_reviews: 0,
  scope: 'Owned browser/server/PostgreSQL/native fake-process runner with real signed artifacts and archive deliverables. Two scripted development Bob decisions are not human reviews. No provider inference, production OIDC or real GitHub effects.',
  source_receipt: args['--source-receipt'], source_receipt_sha256: hash(readFileSync(args['--source-receipt'])),
  admission: { product, head: sourceReceipt.identity.head, execution_files: admission.execution_files,
    ownership_selects_executable_root: false },
  operations: [], checks: {}, screenshots: {}, failures: [],
}
const reportRenameWait = new Int32Array(new SharedArrayBuffer(4))
const save = () => {
  report.updated_at = new Date().toISOString()
  writeFileSync(reportPath + '.tmp', JSON.stringify(report, null, 2) + '\n')
  // Windows readers can briefly deny replacement. Keep the prior complete report
  // intact; retry only this evidence-file rename and fail after at most one second.
  for (let attempt = 0; ; attempt++) {
    try { renameSync(reportPath + '.tmp', reportPath); return }
    catch (error) {
      if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 40) throw error
      console.log(`Report replacement retry ${attempt + 1}: ${error.code}`)
      Atomics.wait(reportRenameWait, 0, 0, 25)
    }
  }
}
const check = (name, value = true) => { report.checks[name] = value; save(); console.log('PASS ' + name) }
save()
const api = (suffix) => `/api/corps/${demo.corp_id}${suffix}`
async function request(route, body) {
  assert.ok(route.startsWith('/api/') && !route.startsWith('//'))
  const response = await fetch(server + route, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000) })
  assert.equal(response.status, 200, `${route.split('?')[0]} returned ${response.status}; body withheld`)
  return response.json()
}
function intent(name, route) {
  assert.ok(!report.operations.some((operation) => operation.name === name), 'Do not duplicate native effects: ' + name)
  const operation = { name, route, started_at: new Date().toISOString(), completed: false }
  report.operations.push(operation); save(); return operation
}
const snapshot = (actor = demo.alice_actor_id) => request(api(`/snapshot?actor_id=${actor}`))
async function graph() {
  const { snapshot: s } = await snapshot(), tasks = s.tasks.filter((task) => task.mission_id === mid)
  return { mission: s.missions.find((mission) => mission.id === mid), tasks, runs: s.runs.filter((run) => tasks.some((task) => task.id === run.task_id)) }
}
async function wait(probe, label, timeout = 60000) {
  const deadline = Date.now() + timeout
  do { const result = await probe(); if (result) return result; await new Promise((done) => setTimeout(done, 150)) } while (Date.now() < deadline)
  throw new Error('Timed out: ' + label)
}
function sql(statement) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('PG')))
  Object.assign(env, { PGHOST: '127.0.0.1', PGPORT: String(ownership.plan.database.port), PGDATABASE: 'pr265_activity', PGUSER: 'pr265_qa' })
  try { return execFileSync(join(pg, 'psql.exe'), ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1'], { input: statement, encoding: 'utf8', env, timeout: 30000, maxBuffer: 8 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] }).trim() }
  catch (error) { throw new Error('Owned SQL failed: ' + String(error.stderr ?? '').slice(0, 1200)) }
}
const quote = (value) => "'" + String(value).replaceAll("'", "''") + "'"
const runtime = '<USERPROFILE>/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'
const { chromium } = await import(pathToFileURL(join(runtime, 'index.mjs')))
const { expect: baseExpect } = await import(pathToFileURL(join(runtime, 'test.mjs')))
const expect = baseExpect.configure({ timeout: 15000 })
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, reducedMotion: 'reduce', acceptDownloads: true })
await context.route('**/*', (route) => [web + '/', server + '/', 'data:', 'blob:'].some((prefix) => route.request().url().startsWith(prefix)) ? route.continue() : route.abort())
await context.addInitScript(({ prefix }) => {
  const Native = window.WebSocket, state = { blocked: false, sockets: new Set() }
  window.__issue260Transport = state
  window.WebSocket = class extends Native {
    constructor(...parameters) {
      super(...parameters)
      if (!this.url.startsWith(prefix)) return
      state.sockets.add(this); this.addEventListener('close', () => state.sockets.delete(this))
      if (state.blocked) this.close()
    }
  }
}, { prefix: server.replace('http', 'ws') + '/ws/corps/' })
const page = await context.newPage(), pageErrors = [], artifactRequests = []
page.on('pageerror', (error) => pageErrors.push(error.message))
page.on('request', (r) => { if (r.url().startsWith(server + api('/artifacts/'))) artifactRequests.push({ url: r.url(), method: r.method() }) })
const card = () => page.locator(`[data-mission-id="${mid}"]`)
const inspector = (kind) => card().getByTestId('inspect-' + kind)
const selectionKey = (actorId = demo.alice_actor_id) => 'ecorp:work-selection:v1:' + JSON.stringify([server, demo.corp_id, actorId])
async function selected(run, actorId = demo.alice_actor_id) {
  const choice = { missionId: mid, taskId: run.task_id, runId: run.id }
  await expect.poll(() => page.evaluate((key) => JSON.parse(sessionStorage.getItem(key)), selectionKey(actorId))).toEqual(choice)
  await expect(page.locator(`#mission-evidence-${mid}`)).toHaveValue(run.id)
  await expect(card()).toHaveAttribute('data-run-id', run.id)
}
async function openRun(run, actorId = demo.alice_actor_id) {
  await page.getByRole('link', { name: 'Missions', exact: true }).click()
  await expect(card()).toBeVisible()
  await page.locator(`#mission-evidence-${mid}`).selectOption(run.id)
  await selected(run, actorId)
}
async function actor(id) {
  const response = page.waitForResponse((r) => r.url() === server + api(`/snapshot?actor_id=${id}`) && r.request().method() === 'GET')
  await page.locator('#operator-actor').selectOption(id)
  assert.equal((await response).status(), 200)
  await expect(page.locator('#operator-actor')).toHaveValue(id)
  await expect(page.locator('.live-live')).toBeVisible({ timeout: 20000 })
}
async function capture(name) {
  const file = `${name}-${randomUUID().slice(0, 8)}.png`
  await page.screenshot({ path: join(qa, 'evidence', file), fullPage: true }); report.screenshots[name] = file; save()
}
async function inspectNative(kind, run, deliverable, actorId) {
  const metadata = kind === 'source' ? { id: deliverable.artifact_id, sha256: deliverable.sha256 } : { id: run.artifact_id, sha256: run.artifact_sha256 }
  const panel = inspector(kind), route = server + api(`/artifacts/${metadata.id}?actor_id=${actorId}`)
  await expect(panel).toHaveAttribute('data-run-id', run.id)
  await expect(panel).toHaveAttribute('data-artifact-id', metadata.id)
  await expect(panel).toHaveAttribute('data-artifact-sha256', metadata.sha256)
  const responsePromise = page.waitForResponse((r) => r.url() === route && r.request().method() === 'GET')
  await panel.getByRole('button', { name: new RegExp('^(Inspect|Reload) ' + (kind === 'source' ? 'source changes' : 'provider output') + '$') }).click()
  const response = await responsePromise, bytes = await response.body()
  assert.equal(response.status(), 200); assert.equal(hash(bytes), metadata.sha256)
  await expect(panel).toHaveAttribute('data-inspection-state', 'ready')
  await expect(panel).toContainText('Inspection does not record an outcome decision.')
  await panel.getByText('Exact evidence identity', { exact: true }).click()
  await expect(panel.locator('.evidence-identity')).toContainText(run.id)
  await expect(panel.locator('.evidence-identity')).toContainText(run.task_id)
  await expect(panel.locator('.evidence-identity')).toContainText(metadata.sha256)
  if (kind === 'provider') {
    await expect(panel.getByRole('region', { name: 'Selected provider output', exact: true })).toBeVisible()
  } else {
    const manifest = JSON.parse(bytes.toString('utf8'))
    assert.equal(manifest.schema_version, 1); assert.equal(manifest.form, 'archive')
    assert.equal(manifest.base_commit, source.base_commit); assert.equal(manifest.verification_sha256, run.verification_sha256)
    assert.ok(manifest.changes.length > 0 && manifest.changes.length <= 40)
    await expect(panel.getByRole('list', { name: 'Changed files', exact: true }).locator('li')).toHaveCount(manifest.changes.length)
    const file = manifest.changes.find((f) => f.path === 'result.md') ?? manifest.changes.find((f) => f.media_type?.startsWith('text/') && f.content_base64)
    assert.ok(file, 'Native archive must include a text file')
    await panel.getByRole('searchbox', { name: 'Search changed files', exact: true }).fill(file.path)
    await expect(panel.getByRole('list', { name: 'Changed files', exact: true }).locator('li')).toHaveCount(1)
    await panel.getByRole('button').filter({ hasText: file.path }).click()
    await expect(panel.getByRole('region', { name: file.path, exact: true })).toBeVisible()
    assert.equal(hash(Buffer.from(file.content_base64, 'base64')), file.sha256)
    await expect(panel.locator('.evidence-file-hash')).toContainText(file.sha256)
    report.native_text_file = file.path; save()
    await panel.getByRole('button', { name: 'Inspect source diff', exact: true }).click()
    await expect(panel.getByRole('region', { name: 'Source diff', exact: true })).toBeVisible()
    assert.equal(hash(Buffer.from(manifest.patch_base64, 'base64')), manifest.patch_sha256)
    await expect(panel.locator('.evidence-file-hash')).toContainText(manifest.patch_sha256)
  }
  assert.equal(await panel.locator('script,iframe,img,object,embed').count(), 0)
  return { run_id: run.id, task_id: run.task_id, artifact_id: metadata.id, sha256: metadata.sha256, bytes: bytes.length, http_status: response.status(), path: new URL(route).pathname }
}
const presentationChecks = createPresentationChecks({ browser, page, context, expect, qa, server, web, demo, mid, report, save, check, capture, snapshot, card, selected, inspectNative })
try {
  await presentationChecks.firstPaint()
  await page.goto(web + '/#missions', { waitUntil: 'networkidle' })
  await expect(page.locator('.live-live')).toBeVisible({ timeout: 20000 })
  await page.getByRole('link', { name: 'Missions', exact: true }).click(); await expect(card()).toBeVisible()
  assert.equal((await graph()).runs.length, 0)
  await presentationChecks.ready()
  let launchCalls = 0
  const launchProof = await completeGraphFixtureLaunch(async () => {
    const route = api(`/missions/${mid}/launch`)
    if (launchCalls++ === 0) {
      const operation = intent('browser-launch', route)
      const pending = page.waitForResponse((r) => r.url() === server + route && r.request().method() === 'POST')
      await card().getByTestId('work-result-card').getByRole('button', { name: 'Start mission', exact: true }).click()
      const response = await pending; operation.response_status = response.status(); operation.completed = true; save()
      return { status: response.status(), body: await response.json() }
    }
    assert.equal(launchCalls, 2)
    const before = await graph(); assert.equal(before.mission.status, 'completed')
    assert.equal(before.runs.length, 3); assert.ok(before.runs.every((r) => r.status === 'completed' && r.workspace_disposition === 'preserved'))
    const operation = intent('completed-launch-replay', route)
    const result = await page.evaluate(async ({ url, requestedBy }) => {
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requested_by: requestedBy }), signal: AbortSignal.timeout(20000) })
      return { status: r.status, body: await r.json() }
    }, { url: server + route, requestedBy: demo.alice_actor_id })
    const after = await graph()
    assert.deepEqual(after.runs.map((r) => r.id).sort(), before.runs.map((r) => r.id).sort())
    assert.ok(after.tasks.every((t) => t.attempt_count === 1))
    operation.response_status = result.status; operation.completed = true; save(); return result
  }, async () => {
    const running = await wait(async () => { const g = await graph(); return g.runs.length === 2 && g.runs.every((r) => r.status === 'running') && g }, 'two native roots running')
    const roots = running.runs.toSorted((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
    report.native_roots = roots.map(({ id, task_id }) => ({ id, task_id })); save()
    await openRun(roots[0])
    const disconnected = await page.evaluate(() => {
      const state = window.__issue260Transport; state.blocked = true
      const sockets = [...state.sockets].filter((s) => s.readyState < WebSocket.CLOSING)
      for (const socket of sockets) socket.close(1000, 'Issue260 browser disconnect')
      return sockets.length
    })
    assert.ok(disconnected > 0); await expect(page.locator('.live-live')).toHaveCount(0)
    const waiting = await wait(async () => { const g = await graph(); return g.runs.length === 2 && g.runs.every((r) => r.status === 'waiting_for_approval' && r.artifact_id && r.workspace_disposition === 'preserved') && g }, 'native persisted evidence with client disconnected')
    await page.evaluate(() => { window.__issue260Transport.blocked = false })
    await expect(page.locator('.live-live')).toBeVisible({ timeout: 20000 }); await selected(roots[0])
    const s = (await snapshot()).snapshot, proofs = []
    report.task_contracts = waiting.tasks.map(({ id, title, depth, deliverable, contract, verification_policy }) =>
      ({ id, title, depth, deliverable, contract, verification_policy }))
    save()
    report.native_root_evidence = waiting.runs.map((run) => ({
      run_id: run.id, task_id: run.task_id, status: run.status,
      artifact_id: run.artifact_id, artifact_sha256: run.artifact_sha256,
      verification_sha256: run.verification_sha256, deliverable_sha256: run.deliverable_sha256,
      checks: s.verification_evidence.filter((item) => item.run_id === run.id),
    }))
    save()
    for (const root of roots) {
      const run = waiting.runs.find((r) => r.id === root.id)
      assert.ok(run.artifact_id)
      assert.match(run.artifact_sha256, /^[0-9a-f]{64}$/)
      // The native runner includes a verification digest only when it exports source.
      assert.equal(run.verification_sha256, null)
      assert.equal(run.deliverable_sha256, null)
      const checks = s.verification_evidence.filter((item) => item.run_id === run.id)
      assert.ok(checks.length > 0 && checks.every((item) => item.status === 'passed'))
      assert.equal(s.source_deliverables.filter((d) => d.run_id === root.id).length, 0,
        'This parallel-specialist fixture produces provider evidence on each root and source only on synthesis')
      await openRun(run); await expect(card().getByRole('button', { name: 'Accept evidence', exact: true })).toBeDisabled()
      proofs.push(await inspectNative('provider', run, undefined, demo.alice_actor_id))
      const automated = card().getByTestId('verification-evidence')
      await expect(automated).toHaveAttribute('data-run-id', run.id)
      assert.equal(await automated.getAttribute('data-verification-sha256'), null)
      assert.equal(await automated.getAttribute('data-source-sha256'), null)
      await automated.locator('summary').click()
      await expect(automated.locator('.evidence-checks > li')).toHaveCount(checks.length)
      for (const item of checks) await expect(automated).toContainText(item.summary)
      await expect(automated.getByRole('link', { name: 'Inspect this source deliverable', exact: true })).toHaveCount(0)
      await expect(card().getByTestId('provider-evidence')).toContainText('Provider evidence')
      await expect(card().getByTestId('source-deliverable')).toHaveCount(0)
      await expect(inspector('source')).toHaveCount(0)
    }
    assert.equal((await snapshot()).snapshot.verification_requests.filter((r) => roots.some((x) => x.id === r.run_id) && r.status === 'pending').length, 2)
    check('native_root_provider_artifacts_exact_checks_no_source_substitution',
      { proofs, inspections_create_decisions: false, requester_buttons_disabled: true, runner_survived_disconnect: true })
    await capture('native-root-provider-desktop')
    await presentationChecks.pending(waiting)
    const originalMembership = JSON.parse(sql(`SELECT row_to_json(r) FROM room_memberships r WHERE actor_id='${demo.bob_actor_id}' AND room_id='${demo.room_id}';`))
    await actor(demo.bob_actor_id); await openRun(roots[0], demo.bob_actor_id)
    const first = waiting.runs.find((r) => r.id === roots[0].id)
    try {
      assert.equal(sql(`WITH c AS (DELETE FROM room_memberships WHERE actor_id='${demo.bob_actor_id}' AND room_id='${demo.room_id}' RETURNING actor_id) SELECT count(*) FROM c;`), '1')
      const denied = await fetch(server + api(`/artifacts/${first.artifact_id}?actor_id=${demo.bob_actor_id}`))
      assert.equal(denied.status, 404)
      const noRoom = (await snapshot(demo.bob_actor_id)).snapshot
      assert.ok(!noRoom.missions.some((m) => m.id === mid)); assert.ok(!noRoom.runs.some((r) => r.id === first.id))
      await actor(demo.eve_actor_id)
      await presentationChecks.denied('guest', demo.eve_actor_id)
      await actor(demo.bob_actor_id)
      await expect(card()).toHaveCount(0); await expect(page.getByText('Selected mission unavailable', { exact: true })).toBeVisible()
      await presentationChecks.denied('revoked-room', demo.bob_actor_id)
      assert.equal(sql(`SELECT count(*) FROM room_memberships WHERE actor_id='${demo.bob_actor_id}' AND room_id='${demo.room_id}';`), '0')
    } finally {
      sql(`INSERT INTO room_memberships(room_id,actor_id,role,joined_at) VALUES('${demo.room_id}','${demo.bob_actor_id}',${quote(originalMembership.role)},${quote(originalMembership.joined_at)}) ON CONFLICT DO NOTHING;`)
      assert.equal(sql(`SELECT count(*) FROM room_memberships WHERE actor_id='${demo.bob_actor_id}' AND room_id='${demo.room_id}' AND role=${quote(originalMembership.role)};`), '1')
    }
    const guest = await fetch(server + api(`/artifacts/${first.artifact_id}?actor_id=${demo.eve_actor_id}`))
    assert.equal(guest.status, 404)
    check('native_current_room_and_guest_denial', { revoked_status: 404, guest_status: 404, original_membership_restored: true })
    await actor(demo.alice_actor_id); await actor(demo.bob_actor_id)
    for (const run of roots) {
      await openRun(run, demo.bob_actor_id)
      await expect(card().getByRole('button', { name: 'Accept evidence', exact: true })).toBeEnabled()
      const operation = intent('accept-' + run.id, api(`/runs/${run.id}/verification-decision`))
      const pending = page.waitForResponse((r) => r.url() === server + operation.route && r.request().method() === 'POST')
      await card().getByRole('button', { name: 'Accept evidence', exact: true }).click()
      assert.equal((await pending).status(), 200); operation.completed = true; save()
      await wait(async () => (await graph()).runs.find((r) => r.id === run.id).status === 'completed', 'exact run decision')
      await selected(run, demo.bob_actor_id)
    }
    const completed = await wait(async () => { const g = await graph(); return g.mission.status === 'completed' && g.runs.length === 3 && g.runs.every((r) => r.status === 'completed' && r.workspace_disposition === 'preserved') && g }, 'native graph completion')
    const final = (await snapshot()).snapshot
    assert.ok(completed.tasks.every((t) => t.attempt_count === 1 && t.verification_status === 'passed'))
    const reviews = final.verification_requests.filter((r) => roots.some((run) => run.id === r.run_id))
    assert.equal(reviews.length, 2); assert.ok(reviews.every((r) => r.status === 'approved' && r.decided_by === demo.bob_actor_id))
    const evidence = final.verification_evidence.filter((e) => completed.runs.some((r) => r.id === e.run_id))
    assert.ok(evidence.length >= 3 && evidence.every((e) => e.status === 'passed'))
    const retained = completed.runs.map((run) => {
      const workspace = realpathSync(run.workspace_path), rel = relative(join(qa, 'runner'), workspace)
      assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel))
      assert.equal(run.runner_id, ownership.plan.runner_id); assert.equal(run.workspace_base_commit, source.base_commit)
      assert.equal(hash(readFileSync(join(workspace, 'result.md'))), run.artifact_sha256)
      return { run_id: run.id, task_id: run.task_id, artifact_id: run.artifact_id, artifact_sha256: run.artifact_sha256, workspace: relative(qa, workspace) }
    })
    assert.equal(execFileSync('git', ['-C', join(qa, 'source'), 'status', '--porcelain'], { encoding: 'utf8' }).trim(), prepared.source_before.status)
    assert.equal(execFileSync('git', ['-C', join(qa, 'source'), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), prepared.source_before.head)
    assert.equal(hash(readFileSync(join(qa, 'source/README.md'))), prepared.source_before.readme_sha256)
    assert.equal(final.pull_request_publications.length, 0)
    check('native_exact_decisions_completed_graph_and_preserved_source', { reviews, retained, evidence: evidence.map(({ id, run_id, status, kind }) => ({ id, run_id, status, kind })), github_effects: 0 })
    // Historical root provider selection stays independent of the synthesis source.
    await openRun(roots[0], demo.bob_actor_id)
    await page.reload({ waitUntil: 'networkidle' }); await expect(page.locator('.live-live')).toBeVisible()
    // Development reload chooses Alice; actor-scoped persisted selections stay independent.
    await actor(demo.bob_actor_id); await selected(roots[0], demo.bob_actor_id)
    const historical = completed.runs.find((r) => r.id === roots[0].id)
    const historicalProof = await inspectNative('provider', historical, undefined, demo.bob_actor_id)
    await expect(inspector('source')).toHaveCount(0)
    check('historical_root_provider_selection_survives_synthesis_and_reload', historicalProof)
    await presentationChecks.historical(historical, demo.bob_actor_id)
    const sourceRuns = completed.runs.filter((run) => final.source_deliverables.some((d) => d.run_id === run.id))
    assert.equal(sourceRuns.length, 1)
    const sourceRun = sourceRuns[0], sourceDeliverable = final.source_deliverables.find((d) => d.run_id === sourceRun.id)
    assert.ok(!roots.some((root) => root.id === sourceRun.id), 'Actual source producer is the dependent synthesis')
    assert.equal(sourceDeliverable.sha256, sourceRun.deliverable_sha256)
    report.native_source = { run_id: sourceRun.id, task_id: sourceRun.task_id,
      artifact_id: sourceDeliverable.artifact_id, sha256: sourceDeliverable.sha256 }
    save()
    await openRun(sourceRun, demo.bob_actor_id)
    const sourceProof = await inspectNative('source', sourceRun, sourceDeliverable, demo.bob_actor_id)
    const automated = card().getByTestId('verification-evidence')
    await expect(automated).toHaveAttribute('data-run-id', sourceRun.id)
    await expect(automated).toHaveAttribute('data-verification-sha256', sourceRun.verification_sha256)
    await expect(automated).toHaveAttribute('data-source-sha256', sourceDeliverable.sha256)
    await automated.locator('summary').click()
    await expect(automated.getByRole('link', { name: 'Inspect this source deliverable', exact: true }))
      .toHaveAttribute('href', '#inspect-source-' + sourceDeliverable.artifact_id)
    await expect(card().getByTestId('source-deliverable')).toContainText('Source deliverable')
    await presentationChecks.completed(sourceRun, sourceDeliverable, demo.bob_actor_id)
    await capture('native-synthesis-source-desktop')
    check('native_synthesis_manifest_text_diff_exact_checks', sourceProof)
    await page.reload({ waitUntil: 'networkidle' }); await expect(page.locator('.live-live')).toBeVisible()
    await actor(demo.bob_actor_id); await selected(sourceRun, demo.bob_actor_id)
    await inspectNative('source', sourceRun, sourceDeliverable, demo.bob_actor_id)
    await page.setViewportSize({ width: 390, height: 844 })
    const search = inspector('source').getByRole('searchbox', { name: 'Search changed files', exact: true })
    await search.focus(); await expect(search).toBeFocused()
    await page.keyboard.press('Tab'); await expect(inspector('source').getByRole('list', { name: 'Changed files' }).getByRole('button').first()).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(inspector('source').getByRole('region', { name: report.native_text_file, exact: true })).toBeVisible()
    const bounds = await inspector('source').evaluate((element) => {
      const box = element.getBoundingClientRect(), controls = [...element.querySelectorAll('button,input,summary,pre')].filter((e) => e.getClientRects().length)
      return { left: box.left, right: box.right, client_width: element.clientWidth, scroll_width: element.scrollWidth,
        clipped: controls.filter((e) => { const b = e.getBoundingClientRect(); return b.left < 0 || b.right > innerWidth + 1 }).map((e) => e.tagName), reduced_motion: matchMedia('(prefers-reduced-motion: reduce)').matches }
    })
    assert.ok(bounds.left >= 0 && bounds.right <= 391 && bounds.scroll_width <= bounds.client_width + 1)
    assert.deepEqual(bounds.clipped, []); assert.equal(bounds.reduced_motion, true)
    await capture('native-source-390px-keyboard')
    check('synthesis_source_selection_reload_mobile_keyboard_reduced_motion', { run_id: sourceRun.id, ...bounds })
    await page.setViewportSize({ width: 1440, height: 1050 })
    const downloadPromise = page.waitForEvent('download')
    await card().getByRole('button', { name: 'Download source deliverable', exact: true }).click()
    const download = await downloadPromise, downloadedPath = await download.path()
    assert.ok(downloadedPath); assert.equal(hash(readFileSync(downloadedPath)), sourceDeliverable.sha256)
    check('authorized_source_download_original_bytes', { sha256: sourceDeliverable.sha256, bytes: sourceDeliverable.bytes })
    return completed
  }, prepared.root_task_ids)
  assert.equal(launchCalls, launchProof.initialStatus === 409 ? 2 : 1)
  check('native_launch_protocol', { initial_status: launchProof.initialStatus, launch_calls: launchCalls, reconciled_after_completion: launchProof.initialStatus === 409, returned_run_ids: launchProof.launched.run_ids })
  assert.deepEqual(pageErrors, [])
  report.artifact_requests = artifactRequests; save()
  await exerciseNativeMissionCreation({ browser, expect, qa, server, web, demo, source, snapshot, wait, check, save, report, intent })
  // Synthetic states are explicit extra UI evidence; they never change the owned DB or authorize a decision.
  const beforeVariants = (await snapshot()).snapshot
  await exerciseBrowserVariants({ browser, expect, qa, server, web, demo, mid, snapshot: { snapshot: beforeVariants, runners: (await snapshot()).runners }, report, save, check })
  await exercisePresentationVariants({ browser, expect, qa, server, web, demo, mid, snapshot: { snapshot: beforeVariants, runners: (await snapshot()).runners }, report, save, check })
  const afterVariants = (await snapshot()).snapshot
  for (const key of ['missions', 'tasks', 'runs', 'verification_requests', 'verification_evidence', 'source_deliverables', 'mission_budget_revisions']) {
    assert.deepEqual(afterVariants[key], beforeVariants[key], 'Synthetic browser contexts must not change native ' + key)
  }
  check('browser_variants_did_not_change_native_runs_decisions_or_sources')
  presentationChecks.assertContrast()
  report.status = 'accepted'; report.completed_at = new Date().toISOString(); save()
} catch (error) {
  report.status = 'failed'; report.failures.push({ at: new Date().toISOString(), error: String(error.stack ?? error).slice(0, 7000) }); save()
  try { await capture('failure') } catch { /* Keep original failure. */ }
  throw error
} finally { await context.close(); await browser.close() }
