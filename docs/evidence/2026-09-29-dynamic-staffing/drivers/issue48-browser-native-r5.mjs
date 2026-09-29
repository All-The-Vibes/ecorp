// Owned native fixture: real browser/server/runner, deterministic provider.
// Reuses the repository's pin lifecycle driver; never resets an interrupted run.
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { execFile as execFileCallback, execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile, realpath, lstat } from 'node:fs/promises'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const execFile = promisify(execFileCallback)
const qa = await realpath(process.env.ISSUE48_QA_ROOT)
const product = await realpath(process.env.ISSUE48_PRODUCT)
assert.match(path.basename(qa), /^issue48-native-20260929-r\d+$/)
assert.equal(path.dirname(qa).toLowerCase(), '<USERPROFILE>\\code\\qa')
const owner = JSON.parse(await readFile(path.join(qa, 'ownership.json'), 'utf8'))
assert.equal(owner.purpose, 'issue48-native-acceptance')
assert.equal(owner.test_owned, true)
assert.ok(owner.ready_at && !owner.stopped_at)
const server = 'http://127.0.0.1:59031'
const web = 'http://127.0.0.1:59032'
assert.equal(owner.plan.server, server)
assert.equal(owner.plan.web, web)
const output = path.join(qa, 'evidence', 'browser-r5')
await mkdir(output, { recursive: false })
const sha = value => createHash('sha256').update(value).digest('hex')
const canonical = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item)
const report = {
  issue: 48, status: 'running', stage: 'setup', started_at_utc: new Date().toISOString(),
  product_head: owner.plan.expected_head, source_binding_sha256: owner.canonical_receipt_sha256,
  binaries: owner.binaries, source: owner.source, assertions: [], operations: [], screenshots: [],
  page_errors: [], blocked_requests: [], lifecycle_observations: [],
  physical_provider_observations: [],
  limitations: ['Development principals, not production identity-provider acceptance.',
    'Native deterministic fake-process; no vendor inference or external GitHub effects.',
    'This lane establishes the retention slice; tester/reviewer staffing remains separately qualified.'],
}
const reportPath = path.join(output, 'browser-retirement-report.json')
await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
const save = () => writeFile(reportPath, JSON.stringify(report, null, 2) + '\n')
const check = async (name, detail) => { report.assertions.push({ name, at: new Date().toISOString(), ...(detail === undefined ? {} : { detail }) }); await save() }
const stage = async name => { report.stage = name; await save() }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const demo = owner.demo
const api = suffix => `/api/corps/${demo.corp_id}${suffix}`
async function request(route, body, expected = 200) {
  if (body !== undefined) { report.operations.push({ kind: 'fixture-api', route, body, at: new Date().toISOString() }); await save() }
  const response = await fetch(new URL(route, server), {
    method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(15_000),
  })
  const result = await response.json()
  assert.equal(response.status, expected, `${route}: ${JSON.stringify(result)}`)
  return result
}
const snapshot = (actor = demo.alice_actor_id) => request(api(`/snapshot?actor_id=${actor}`))
const sql = query => JSON.parse(execFileSync(process.env.ECORP_PSQL_BINARY,
  ['-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-c', query], { encoding: 'utf8', windowsHide: true, timeout: 15_000 }).trim())
function historyDigest() {
  return sha(canonical(sql(`SELECT jsonb_build_object(
    'runs',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM runs r),
    'tasks',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM tasks t),
    'missions',(SELECT jsonb_agg(to_jsonb(m) ORDER BY id) FROM missions m),
    'leases',(SELECT jsonb_agg(to_jsonb(l) ORDER BY agent_id) FROM control_leases l),
    'approvals',(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM action_approvals a),
    'reviews',(SELECT jsonb_agg(to_jsonb(v) ORDER BY run_id) FROM verification_requests v),
    'messages',(SELECT jsonb_agg(to_jsonb(q) ORDER BY id) FROM queued_messages q),
    'commands',(SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM runner_commands c))`)))
}
async function waitFor(predicate, label, timeout = 90_000) {
  const deadline = Date.now() + timeout
  do { const state = await snapshot(); const value = predicate(state); if (value) return { state, value }; await sleep(200) } while (Date.now() < deadline)
  throw new Error(`Timed out: ${label}; preserve the native fixture and checkpoint`)
}
async function observeProviders(runIds, known = []) {
  const args = ['-NoProfile', '-File', fileURLToPath(new URL('./issue48-provider-observation-r1.ps1', import.meta.url)),
    '-QaRoot', qa, '-RunIds', runIds.join(',')]
  if (known.length) args.push('-ObservedProcessIds', known.map(x => x.pid).join(','))
  const result = await execFile('pwsh', args, { cwd: qa, env: process.env, windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 })
  const observed = JSON.parse(result.stdout)
  report.physical_provider_observations.push(observed)
  await save()
  return observed
}
function assertProvidersAbsent(observed, known) {
  assert.equal(observed.matches.length, 0, 'A provider process remains after terminal completion')
  for (const prior of known) {
    const current = observed.prior_processes.find(x => x.pid === prior.pid)?.current
    assert.ok(!current || current.started_utc !== prior.started_utc || current.executable !== prior.executable,
      'The physically observed provider still exists after terminal completion')
  }
}
async function pinPhase(phase) {
  const args = [path.join(product, 'tools', 'e2e_agent_pinning.mjs'), '--phase', phase]
  const opts = { cwd: qa, env: process.env, windowsHide: true, timeout: 240_000, maxBuffer: 4 * 1024 * 1024 }
  try {
    const result = await execFile(process.execPath, args, opts)
    await writeFile(path.join(output, `pin-${phase}.stdout.log`), result.stdout, { flag: 'wx' })
    await writeFile(path.join(output, `pin-${phase}.stderr.log`), result.stderr, { flag: 'wx' })
  } catch (error) {
    await writeFile(path.join(output, `pin-${phase}.stdout.log`), error.stdout ?? '', { flag: 'wx' })
    await writeFile(path.join(output, `pin-${phase}.stderr.log`), error.stderr ?? '', { flag: 'wx' })
    throw new Error(`Existing native pin driver phase ${phase} failed; retained phase logs record the observed result`)
  }
  return JSON.parse(await readFile(path.join(process.env.CRONY_PIN_OUTPUT, 'native-agent-pinning.json'), 'utf8'))
}
const browserEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
  /^(PATH|PATHEXT|SystemRoot|windir|ComSpec|TEMP|TMP|USERPROFILE|HOMEDRIVE|HOMEPATH|HOME|APPDATA|LOCALAPPDATA|PROGRAMDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMW6432|SYSTEMDRIVE|USERNAME|USERDOMAIN|COMPUTERNAME|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE|OS)$/i.test(name)))
let browser
const pages = {}
const contexts = {}
async function capture(label, page = pages.alice) {
  const file = path.join(output, `${label}.png`)
  await page.screenshot({ path: file, fullPage: true })
  report.screenshots.push({ label, file, sha256: sha(await readFile(file)), viewport: page.viewportSize() })
  await save()
}
async function floor(page) {
  await page.goto(`${web}/?actor=${page === pages.bob ? 'bob' : page === pages.eve ? 'eve' : 'alice'}#floor`, { waitUntil: 'domcontentloaded' })
  await page.locator('.crew-management').waitFor({ state: 'visible', timeout: 30_000 })
  const toggle = page.getByRole('checkbox', { name: 'Show offline and test identities', exact: true })
  await toggle.check()
}
async function expandCurrent(page) {
  const details = page.locator('.crew-management .crew-roster').filter({ has: page.locator('summary', { hasText: /^Current identities/ }) })
  await details.waitFor({ state: 'visible', timeout: 30_000 })
  assert.equal(await details.count(), 1, 'Exactly one current roster is available')
  if (!await details.evaluate(el => el.open)) await details.locator('summary').click()
}
async function inspector(page, name) {
  const worker = page.getByTestId(`agent-${name}`)
  await worker.waitFor({ state: 'visible', timeout: 30_000 })
  assert.equal(await worker.count(), 1, 'Exactly one floor worker opens this inspector')
  await worker.click()
  return page.getByRole('dialog', { name: `${name} details and controls`, exact: true })
}
async function closeInspector(page) {
  const dialog = page.getByRole('dialog')
  if (await dialog.count()) await dialog.getByRole('button', { name: 'Close', exact: true }).click()
}
async function clickMutation(page, button, suffix, expected = 200) {
  const pending = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith(suffix), { timeout: 30_000 })
  await button.click()
  const response = await pending
  const body = response.request().postDataJSON()
  const result = await response.json()
  report.operations.push({ kind: 'browser', route: new URL(response.url()).pathname, body, status: response.status(), result, at: new Date().toISOString() })
  await save()
  assert.equal(response.status(), expected, JSON.stringify(result))
  return { body, result }
}
async function pinInBrowser(page, name, pinned) {
  const dialog = await inspector(page, name)
  const response = await clickMutation(page, dialog.getByRole('button', { name: `${pinned ? 'Pin' : 'Unpin'} ${name}`, exact: true }), '/pin')
  assert.equal(response.result.pinned, pinned)
  await closeInspector(page)
  return response
}
function missionBody(title, source) {
  return {
    requested_by: demo.alice_actor_id, title, preferred_adapter: 'fake-process', strategy: 'single', source,
    budget_tokens: 80_000, budget_cost_microusd: 1_000_000,
    verification_policy: { checks: [{ type: 'artifact', min_bytes: 1 }, { type: 'file', path: 'result.md', min_bytes: 1 }], manual_gate: null },
  }
}
try {
  const { chromium } = createRequire(import.meta.url)(process.env.CRONY_PLAYWRIGHT_MODULE)
  browser = await chromium.launch({ channel: 'msedge', headless: true, env: browserEnv })
  for (const actor of ['alice', 'bob', 'eve']) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    contexts[actor] = context
    await context.route('**/*', async route => {
      const url = new URL(route.request().url())
      if ([web, server].includes(url.origin)) return route.continue()
      report.blocked_requests.push({ actor, origin: url.origin, pathname: url.pathname })
      return route.abort('blockedbyclient')
    })
    pages[actor] = await context.newPage()
    pages[actor].on('pageerror', error => report.page_errors.push({ actor, message: String(error) }))
    await floor(pages[actor])
  }
  assert.equal((await snapshot()).snapshot.agents.length, 0)
  assert.match(await pages.alice.locator('.crew-management').innerText(), /Your crew is empty/)
  assert.equal(await pages.alice.getByRole('button', { name: 'Clear crew', exact: true }).isEnabled(), false)
  assert.equal(await pages.eve.getByRole('button', { name: 'Clear crew', exact: true }).isEnabled(), false)
  await capture('01-empty-crew')
  await check('Fresh Corp has no static workers; empty crew and unauthorized controls are explicit')

  await stage('Native pin and active-obligation preservation')
  let pin = await pinPhase('prepare')
  await pages.alice.getByRole('button', { name: 'Refresh crew', exact: true }).click()
  await expandCurrent(pages.alice)
  await pinInBrowser(pages.alice, 'Delivery engineer', true)
  await pages.bob.locator('.crew-management').getByText(/Pinned/).first().waitFor({ state: 'attached' })
  await capture('02-pinned-off-shift')
  pin = await pinPhase('start')
  await waitFor(s => s.snapshot.runs.some(r => r.id === pin.launch.run_id && r.status === 'waiting_for_approval'), 'held native approval')
  const heldProcesses = await observeProviders([pin.launch.run_id])
  assert.equal(heldProcesses.matches.length, 1)
  assert.ok(heldProcesses.matches.every(p => p.owned_runner_parent && p.owned_workspace_argument))
  const heldIdentities = heldProcesses.matches.map(p => p.identity)
  const obligations = historyDigest()
  await expandCurrent(pages.alice)
  const cleared = await clickMutation(pages.alice, pages.alice.getByRole('button', { name: 'Clear crew', exact: true }), '/agents/clear')
  assert.equal(cleared.result.results.length, 1)
  assert.equal(cleared.result.results[0].status, 'blocked')
  assert.ok(cleared.result.results[0].blockers.includes('pending_approval'))
  assert.ok(cleared.result.results[0].blockers.includes('control_lease'))
  assert.equal(historyDigest(), obligations)
  const retired = await clickMutation(pages.alice, pages.alice.getByRole('button', { name: 'Retire Delivery engineer', exact: true }), '/retire')
  assert.equal(retired.result.results[0].status, 'blocked')
  assert.ok(retired.result.results[0].blockers.includes('active_run'))
  assert.equal(historyDigest(), obligations)
  await capture('03-active-removal-blocked')
  await check('Browser Clear and Retire explain blockers and preserve exact active run/task/mission/lease/approval/message/review/command rows', { digest: obligations, clear: cleared.result, retire: retired.result })
  await pinInBrowser(pages.bob, 'Delivery engineer', false)
  pin = await pinPhase('complete')
  assert.equal(pin.phase, 'complete')
  await waitFor(s => [pin.launch.run_id, pin.second_launch.run_id].every(id =>
    s.snapshot.runs.find(r => r.id === id)?.workspace_disposition === 'preserved'), 'pin fixture workspace cleanup persistence')
  assertProvidersAbsent(await observeProviders([pin.launch.run_id, pin.second_launch.run_id], heldIdentities), heldIdentities)
  await check('Existing native multiplayer Pin/Unpin, exact replay, verifier completion, pinned reuse and automatic retirement driver passed', { assertions: pin.checks, counts: pin.final_counts })
  await floor(pages.alice)
  await pages.alice.getByText('Retired history (1)', { exact: true }).click()
  assert.equal(await pages.alice.getByRole('button', { name: /^Inspect Delivery engineer,/ }).count(), 0)
  await capture('04-automatic-retirement-history')

  await stage('Browser-launched native work and explicit pinned retirement')
  const next = await request(api('/missions'), missionBody('[slow] Issue48 explicit retirement after native completion', pin.mission_source))
  let latest = await snapshot()
  const task = latest.snapshot.tasks.find(t => t.mission_id === next.mission_id)
  const workerId = task.assigned_agent_id
  assert.notEqual(workerId, pin.agent)
  report.manual_worker = workerId
  report.manual_mission = next.mission_id
  await floor(pages.alice)
  await expandCurrent(pages.alice)
  await pinInBrowser(pages.alice, 'Delivery engineer', true)
  await floor(pages.bob)
  await expandCurrent(pages.bob)
  await pages.bob.evaluate(() => {
    window.__issue48CrewLabels = []
    const root = document.querySelector('.crew-management')
    const record = () => {
      const labels = [...root.querySelectorAll('.crew-identity-label span')]
        .filter(el => el.getClientRects().length).map(el => el.textContent)
      const previous = window.__issue48CrewLabels.at(-1)
      if (JSON.stringify(previous?.labels) !== JSON.stringify(labels)) {
        window.__issue48CrewLabels.push({ at: new Date().toISOString(), labels })
      }
    }
    window.__issue48CrewObserver = new MutationObserver(record)
    window.__issue48CrewObserver.observe(root, { childList: true, subtree: true, characterData: true })
    record()
  })
  const current = pages.alice.locator('.crew-management .crew-roster').filter({ has: pages.alice.locator('summary', { hasText: /^Current identities/ }) })
  await current.getByRole('button', { name: 'View mission for Delivery engineer', exact: true }).click()
  const launched = await clickMutation(pages.alice, pages.alice.getByRole('button', { name: 'Start mission', exact: true }), '/launch')
  report.manual_run = launched.result.run_id
  await waitFor(s => s.snapshot.runs.some(r => r.id === report.manual_run && r.status === 'running'), 'native provider running')
  const manualProcesses = await observeProviders([report.manual_run])
  assert.equal(manualProcesses.matches.length, 1)
  assert.ok(manualProcesses.matches.every(p => p.owned_runner_parent && p.owned_workspace_argument))
  const manualIdentities = manualProcesses.matches.map(p => p.identity)
  await capture('native-live-crew', pages.bob)
  await floor(pages.alice)
  await waitFor(s => {
    const a = s.snapshot.agents.find(a => a.id === workerId)
    const r = s.snapshot.runs.find(r => r.id === report.manual_run)
    if (a && r && !report.lifecycle_observations.some(x => x.agent_status === a.status && x.run_status === r.status)) {
      report.lifecycle_observations.push({ at: new Date().toISOString(), agent_status: a.status, run_status: r.status })
    }
    return r?.status === 'completed' && r.workspace_disposition === 'preserved' && a?.current_run_id === null &&
      s.snapshot.events.some(e => e.aggregate_id === r.id && e.type === 'run.session_terminated') &&
      s.snapshot.events.some(e => e.aggregate_id === r.id && e.type === 'run.workspace_preserved')
  }, 'browser-launched native verifier completion', 120_000)
  latest = await snapshot()
  const native = latest.snapshot.runs.find(r => r.id === report.manual_run)
  assert.equal(native.verification_status, 'passed')
  assert.ok(latest.snapshot.verification_evidence.filter(v => v.run_id === native.id).every(v => v.status === 'passed'))
  const termination = latest.snapshot.events.find(e => e.aggregate_id === native.id && e.type === 'run.session_terminated')
  assert.equal(termination.payload.provider_process_alive, false)
  report.lifecycle_render_observations = await pages.bob.evaluate(() => {
    window.__issue48CrewObserver.disconnect()
    return window.__issue48CrewLabels
  })
  assertProvidersAbsent(await observeProviders([report.manual_run], manualIdentities), manualIdentities)
  await check('Actual browser Start mission reaches native isolated runner, persisted verifier evidence and provider teardown', { run_id: native.id, termination_event_id: termination.id, evidence: latest.snapshot.verification_evidence.filter(v => v.run_id === native.id) })
  await pages.alice.getByRole('button', { name: 'Refresh crew', exact: true }).click()
  await expandCurrent(pages.alice)
  const kept = await clickMutation(pages.alice, pages.alice.getByRole('button', { name: 'Clear crew', exact: true }), '/agents/clear')
  assert.deepEqual(kept.result.results[0].blockers, ['pinned'])

  await stage('Actual room-authority denial preserves retry and unrelated authorized work')
  // Bootstrap before revocation: this compatibility fixture also ensures demo room memberships.
  await request('/api/demo/bootstrap?seed_crew=true', {})
  latest = await snapshot()
  const legacy = latest.snapshot.agents.filter(a => a.mission_id == null && a.retired_at == null)
  assert.equal(legacy.length, 6)
  assert.ok(legacy.every(a => a.current_run_id == null))
  await floor(pages.bob)
  await expandCurrent(pages.bob)
  const quote = value => "'" + String(value).replaceAll("'", "''") + "'"
  const membershipWhere = 'room_id=' + quote(demo.room_id) + '::uuid AND actor_id=' + quote(demo.bob_actor_id) + '::uuid'
  const membership = sql('SELECT to_jsonb(rm) FROM room_memberships rm WHERE ' + membershipWhere)
  assert.equal(membership.room_id, demo.room_id)
  assert.equal(membership.actor_id, demo.bob_actor_id)
  assert.equal(sql('SELECT to_jsonb(corp_id) FROM rooms WHERE id=' + quote(demo.room_id)), demo.corp_id)
  const allMemberships = () => sql('SELECT jsonb_agg(to_jsonb(rm) ORDER BY room_id,actor_id) FROM room_memberships rm')
  const membershipsBefore = canonical(allMemberships())
  await writeFile(path.join(output, 'owned-room-membership-before.json'), JSON.stringify(membership, null, 2) + '\n', { flag: 'wx' })
  let deniedMembershipRequest, deniedMembershipRequestBytes, deniedSavedOperation, legacyClear
  const bobJournalKey = 'ecorp:crew-retirement:' + JSON.stringify([server, demo.corp_id, demo.bob_actor_id])
  const bobJournal = () => pages.bob.evaluate(key => JSON.parse(sessionStorage.getItem(key)), bobJournalKey)
  try {
    const removed = sql('WITH removed AS (DELETE FROM room_memberships rm WHERE ' + membershipWhere +
      ' AND to_jsonb(rm)=' + quote(JSON.stringify(membership)) + '::jsonb RETURNING *) SELECT jsonb_agg(to_jsonb(removed)) FROM removed')
    assert.deepEqual(removed, [membership], 'Only the exact owned fixture membership may be revoked')
    const denied = await clickMutation(pages.bob, pages.bob.getByRole('button', { name: 'Retire Delivery engineer', exact: true }), '/retire', 403)
    deniedMembershipRequest = denied.body
    deniedMembershipRequestBytes = JSON.stringify(denied.body)
    assert.equal(denied.body.actor_id, demo.bob_actor_id)
    await pages.bob.waitForFunction(() => document.querySelector('.crew-management')?.getAttribute('aria-busy') === 'false')
    assert.equal((await snapshot(demo.bob_actor_id)).snapshot.agents.some(a => a.id === workerId), false)
    // A full demo bootstrap recreates its demo memberships. Refresh through the
    // product snapshot route while authority is revoked; reload only after the
    // exact original membership has been restored in finally.
    const refreshed = pages.bob.waitForResponse(response => response.request().method() === 'GET' &&
      new URL(response.url()).pathname === api('/snapshot') && new URL(response.url()).searchParams.get('actor_id') === demo.bob_actor_id)
    await pages.bob.getByRole('button', { name: 'Refresh crew', exact: true }).click()
    const refreshedResponse = await refreshed
    assert.equal(refreshedResponse.status(), 200)
    assert.equal((await refreshedResponse.json()).snapshot.agents.some(agent => agent.id === workerId), false)
    await pages.bob.getByText('Current identities (6)', { exact: true }).waitFor({ state: 'visible' })
    await expandCurrent(pages.bob)
    await pages.bob.getByRole('button', { name: 'Retry saved request', exact: true }).waitFor({ state: 'visible' })
    const saved = (await bobJournal()).operations.find(op => op.idempotency_key === denied.body.idempotency_key)
    deniedSavedOperation = saved
    assert.equal(saved.response, undefined)
    assert.deepEqual(saved.targets, [{ agent_id: workerId, expected_pin_version: denied.body.expected_pin_version }])
    const beforeLegacy = historyDigest()
    legacyClear = await clickMutation(pages.bob, pages.bob.getByRole('button', { name: 'Clear crew', exact: true }), '/agents/clear')
    await pages.bob.waitForFunction(() => document.querySelector('.crew-management')?.getAttribute('aria-busy') === 'false')
    assert.deepEqual(legacyClear.body.targets.map(t => t.agent_id).sort(), legacy.map(a => a.id).sort())
    assert.ok(legacyClear.result.results.every(r => r.status === 'retired'), JSON.stringify(legacyClear.result))
    assert.equal(historyDigest(), beforeLegacy)
    const pendingAfterClear = (await bobJournal()).operations.find(op => op.idempotency_key === denied.body.idempotency_key)
    assert.deepEqual(pendingAfterClear, saved, 'Unrelated success must not discard or change the denied request')
    await pages.bob.getByRole('button', { name: 'Retry saved request', exact: true }).waitFor({ state: 'visible' })
    assert.deepEqual((await bobJournal()).operations.find(op => op.idempotency_key === denied.body.idempotency_key), saved)
    await capture('native-403-unrelated-clear', pages.bob)
    await check('Real server 403 and authorized snapshot retain exact denied Retire while Clear retires all six unrelated visible identities', {
      denied_status: 403, denied_request: denied.body, clear: legacyClear, history_digest: beforeLegacy,
      qualification: 'Only one owned fixture room_memberships row was removed through SQL; the denial, snapshot refresh and mutations ran through the product HTTP routes. Reload waits until exact membership restoration because demo bootstrap recreates demo memberships.',
    })
  } finally {
    // Preserve concurrent changes: reinsert only when absent, then verify every original field.
    sql('WITH restored AS (INSERT INTO room_memberships SELECT * FROM jsonb_populate_record(NULL::room_memberships,' +
      quote(JSON.stringify(membership)) + '::jsonb) ON CONFLICT (room_id,actor_id) DO NOTHING RETURNING *) SELECT to_jsonb(count(*)) FROM restored')
    const restored = sql('SELECT to_jsonb(rm) FROM room_memberships rm WHERE ' + membershipWhere)
    assert.deepEqual(restored, membership, 'Owned fixture authority restoration must match the exact original row')
    assert.equal(canonical(allMemberships()), membershipsBefore)
    await writeFile(path.join(output, 'owned-room-membership-restored.json'), JSON.stringify({ restored_at_utc: new Date().toISOString(), row: restored, all_memberships_unchanged: true }, null, 2) + '\n', { flag: 'wx' })
  }

  await floor(pages.bob)
  await pages.bob.getByRole('button', { name: 'Retry saved request', exact: true }).waitFor({ state: 'visible' })
  assert.deepEqual((await bobJournal()).operations.find(op => op.idempotency_key === deniedMembershipRequest.idempotency_key), deniedSavedOperation)
  assert.equal(await pages.bob.getByRole('button', { name: 'Clear crew', exact: true }).isDisabled(), true)
  await capture('native-403-restored-authority-reload', pages.bob)
  await check('Reload after exact authority restoration preserves the unresolved request and fences overlapping Clear', {
    denied_request: deniedMembershipRequest, restored_membership: membership, saved_operation: deniedSavedOperation,
  })

  await stage('Lost retirement response and exact replay after native authorization recovery')
  await floor(pages.alice)
  await expandCurrent(pages.alice)
  await floor(pages.bob)
  await inspector(pages.bob, 'Delivery engineer')
  const historyBefore = historyDigest()
  let lostRequest, committedResponse
  const retireUrl = `${server}${api(`/agents/${workerId}/retire`)}`
  await pages.alice.route(retireUrl, async route => {
    lostRequest = route.request().postData()
    const response = await route.fetch()
    assert.equal(response.status(), 200)
    committedResponse = await response.json()
    await route.abort('failed')
  }, { times: 1 })
  await pages.alice.getByRole('button', { name: 'Retire Delivery engineer', exact: true }).click()
  await pages.alice.getByRole('button', { name: 'Retry saved request', exact: true }).waitFor({ state: 'visible' })
  await pages.alice.waitForFunction(() => document.querySelector('.crew-management')?.getAttribute('aria-busy') === 'false')
  assert.equal(committedResponse.results[0].status, 'retired')
  assert.equal(historyDigest(), historyBefore)
  await pages.bob.getByRole('dialog').waitFor({ state: 'hidden' })
  assert.equal(await pages.bob.evaluate(() => document.activeElement?.id), 'crew-management-heading')
  await capture('05-retired-response-lost')
  await pages.alice.reload({ waitUntil: 'domcontentloaded' })
  const replay = await clickMutation(pages.alice, pages.alice.getByRole('button', { name: 'Retry saved request', exact: true }), '/retire')
  assert.equal(JSON.stringify(replay.body), lostRequest)
  assert.equal(replay.result.replayed, true)
  assert.deepEqual(replay.result.results, committedResponse.results)
  assert.equal(historyDigest(), historyBefore)
  const after = await snapshot()
  assert.equal(after.snapshot.events.filter(e => e.aggregate_id === workerId && e.type === 'agent.retired').length, 1)
  assert.ok(after.snapshot.agents.find(a => a.id === workerId)?.retired_at)
  assert.equal(after.snapshot.tasks.find(t => t.id === task.id).assigned_agent_id, workerId)
  assert.equal(after.snapshot.runs.find(r => r.id === native.id).agent_id, workerId)
  assert.equal(after.snapshot.missions.find(m => m.id === next.mission_id).status, 'completed')
  await check('Explicit pinned Retire preserves history; lost response survives reload and retries identical bytes once; other client closes retired inspector with usable focus', { original_request: JSON.parse(lostRequest), original_response: committedResponse, replay: replay.result, history_digest: historyBefore })
  const deniedRetry = await clickMutation(pages.bob, pages.bob.getByRole('button', { name: 'Retry saved request', exact: true }), '/retire')
  assert.equal(JSON.stringify(deniedRetry.body), deniedMembershipRequestBytes)
  assert.equal(deniedRetry.body.idempotency_key, deniedMembershipRequest.idempotency_key)
  assert.equal(deniedRetry.result.results[0].status, 'already_retired')
  assert.equal(historyDigest(), historyBefore)
  assert.equal((await snapshot()).snapshot.events.filter(e => e.aggregate_id === workerId && e.type === 'agent.retired').length, 1)
  await check('After exact authority restoration, Bob retries the original denied request and reconciles Alice\'s retirement without a duplicate retirement event', deniedRetry)
  await pages.alice.getByText('Retired history (8)', { exact: true }).click()
  await capture('06-manual-retirement-recovered')
  await pages.alice.setViewportSize({ width: 390, height: 844 })
  const geometry = await pages.alice.locator('.crew-management').evaluate(el => ({
    viewport: window.innerWidth, document_width: document.documentElement.scrollWidth,
    width: el.getBoundingClientRect().width, scroll_width: el.scrollWidth,
    overflowing_controls: [...el.querySelectorAll('button')].filter(b => b.getClientRects().length && (b.getBoundingClientRect().right > window.innerWidth + 1 || b.getBoundingClientRect().left < -1)).map(b => b.textContent),
  }))
  assert.equal(geometry.overflowing_controls.length, 0)
  assert.ok(geometry.scroll_width <= geometry.width + 1, JSON.stringify(geometry))
  await capture('07-narrow-retired-history')
  await check('Crew management and its controls fit 390 CSS pixels', geometry)
  await pages.alice.setViewportSize({ width: 1280, height: 900 })

  await stage('Cleared legacy roster and private-room event authorization')
  latest = await snapshot()
  assert.ok(legacy.every(a => latest.snapshot.agents.find(currentAgent => currentAgent.id === a.id)?.retired_at))
  await floor(pages.alice)
  await pages.alice.getByText('Your crew is empty. A mission provisions the workers it needs.', { exact: true }).waitFor({ state: 'visible' })
  assert.equal(legacyClear.body.targets.length, 6)
  assert.equal(legacyClear.result.results.length, 6)
  const eve = await snapshot(demo.eve_actor_id)
  const dynamicWorkers = [pin.agent, workerId]
  assert.deepEqual(eve.snapshot.agents.map(a => a.id).sort(), legacy.map(a => a.id).sort())
  assert.ok(eve.snapshot.agents.every(a => a.mission_id == null && a.retired_at != null))
  assert.ok(eve.snapshot.agents.every(a => !dynamicWorkers.includes(a.id)))
  assert.equal(eve.snapshot.events.filter(e => dynamicWorkers.includes(e.aggregate_id) &&
    ['agent.retired', 'agent.retirement_checked', 'agent.pinned', 'agent.unpinned'].includes(e.type)).length, 0)
  report.legacy_event_visibility = {
    legacy_agent_ids: legacy.map(a => a.id),
    visible_to_eve: eve.snapshot.events.filter(e => legacy.some(a => a.id === e.aggregate_id) &&
      ['agent.retired', 'agent.retirement_checked'].includes(e.type)),
    qualification: 'Legacy identities have no mission room; their Corp-scoped event visibility is not private-room evidence.',
  }
  await request(api('/agents/clear'), { actor_id: demo.eve_actor_id, idempotency_key: randomUUID(), targets: [{ agent_id: workerId, expected_pin_version: 1 }] }, 403)
  await request(api(`/agents/${workerId}/retire`), { actor_id: demo.eve_actor_id, idempotency_key: randomUUID(), expected_pin_version: 1 }, 403)
  const bob = await snapshot(demo.bob_actor_id)
  assert.equal(bob.snapshot.agents.filter(a => a.retired_at == null).length, 0)
  await check('Cleared identities remain historically resolvable and dynamic worker events remain private-room scoped', { requested: 6, retired: 6 })
  await capture('08-clear-crew-complete')
  const final = await snapshot()
  report.final_counts = {
    agents: final.snapshot.agents.length, retired: final.snapshot.agents.filter(a => a.retired_at != null).length,
    missions: final.snapshot.missions.length, tasks: final.snapshot.tasks.length, runs: final.snapshot.runs.length,
    completed_runs: final.snapshot.runs.filter(r => r.status === 'completed').length,
    verifier_rows: final.snapshot.verification_evidence.length,
  }
  assert.equal(report.final_counts.completed_runs, 3)
  assert.equal(report.final_counts.agents, 8)
  assert.equal(report.final_counts.retired, 8)
  assert.equal(report.final_counts.verifier_rows, 6)
  assert.equal(report.page_errors.length, 0)
  assert.equal(report.blocked_requests.length, 0)
  assert.equal(execFileSync('git', ['-C', owner.source.path, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), owner.source.base_commit)
  assert.equal(execFileSync('git', ['-C', owner.source.path, 'status', '--porcelain'], { encoding: 'utf8' }).trim(), '')
  assert.equal((await lstat(owner.source.path)).isSymbolicLink(), false)
  await writeFile(path.join(output, 'final-snapshot.json'), JSON.stringify(final, null, 2) + '\n', { flag: 'wx' })
  report.status = 'passed'
  report.stage = 'complete'
} catch (error) {
  report.status = 'failed'
  report.failure = String(error)
  if (pages.alice && !pages.alice.isClosed()) { try { await capture('failure-observation') } catch { /* Retain original failure. */ } }
  throw error
} finally {
  if (browser) await browser.close()
  report.finished_at_utc = new Date().toISOString()
  await save()
  console.log(JSON.stringify({ status: report.status, stage: report.stage, assertions: report.assertions.length, screenshots: report.screenshots.length, report: reportPath }))
}
