// Owned fresh fixture: actual browser, server and runner with deterministic providers.
// Does not reset, adopt or resume interrupted fixtures. Every mutation is checkpointed.
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { execFile as execFileCallback, execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile, realpath } from 'node:fs/promises'
import { promisify } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const execFile = promisify(execFileCallback)
const qa = await realpath(process.env.ISSUE48_QA_ROOT)
const product = await realpath(process.env.ISSUE48_PRODUCT)
assert.match(path.basename(qa), /^issue48-native-20260929-r\d+$/)
assert.equal(path.dirname(qa).toLowerCase(), '<USERPROFILE>\\code\\qa')
const owner = JSON.parse(await readFile(path.join(qa, 'ownership.json'), 'utf8'))
assert.equal(owner.purpose, 'issue48-native-acceptance')
assert.equal(owner.test_owned, true)
assert.equal(owner.plan.provider_mode, 'fake-only')
assert.ok(owner.ready_at && !owner.stopped_at)
const server = 'http://127.0.0.1:59031'
const web = 'http://127.0.0.1:59032'
assert.equal(owner.plan.server, server)
assert.equal(owner.plan.web, web)
const demo = owner.demo
const source = { repository: owner.source.repository, base_ref: owner.source.base_ref, base_commit: owner.source.base_commit }
const api = suffix => `/api/corps/${demo.corp_id}${suffix}`
const output = path.join(qa, 'evidence', 'staffing-r2')
await mkdir(output, { recursive: false })
const reportPath = path.join(output, 'native-staffing-report.json')
const sha = value => createHash('sha256').update(value).digest('hex')
const sorted = values => [...values].sort()
const byPath = (a, b) => a.path.localeCompare(b.path)
const metadata = file => ({ path: file.path, sha256: file.sha256, bytes: file.bytes })
const canonical = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item)
const secrets = new Set()
const scrub = value => JSON.parse(JSON.stringify(value, (name, item) =>
  /^(credential|enrollment_token|claim_token|assignment_token|lease_token|publisher_token|authorization)$/i.test(name)
    ? '[REDACTED]' : item))
const redact = error => {
  let result = String(error)
  for (const secret of secrets) result = result.replaceAll(secret, '[REDACTED]')
  return result.slice(0, 6000)
}
const report = {
  issue: 48, status: 'running', stage: 'setup', started_at_utc: new Date().toISOString(),
  source, product_head: owner.plan.expected_head, source_binding_sha256: owner.canonical_receipt_sha256,
  binaries: owner.binaries, operations: [], assertions: [], missions: [], screenshots: [],
  page_errors: [], blocked_requests: [], physical_provider_observations: [], synthetic_messages: [],
  limitations: [
    'Development principals and native deterministic fake-process; no production identity-provider or vendor inference claim.',
    'The incompatible higher-priority runtime is an enrolled synthetic capability advertisement, not a vendor provider.',
    'Agent tester/reviewer output is product evidence, not a human decision or authorization to merge.',
  ],
}
await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
let writes = Promise.resolve()
const save = () => {
  const data = JSON.stringify(scrub(report), null, 2) + '\n'
  writes = writes.then(() => writeFile(reportPath, data))
  return writes
}
const stage = async name => { report.stage = name; await save() }
const check = async (name, detail) => { report.assertions.push({ name, at: new Date().toISOString(), detail }); await save() }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const deadline = Date.now() + 10 * 60_000
let requestCount = 0
let syntheticFailure = null
function healthy() {
  assert.ok(Date.now() < deadline, 'Ten-minute fixture bound exhausted; retain original missions and evidence')
  assert.equal(syntheticFailure, null, syntheticFailure ?? '')
}
async function request(route, body, expected = 200, confidential = false) {
  healthy()
  assert.ok(++requestCount < 2000, 'Fixture request bound exceeded')
  const url = new URL(route, server)
  assert.equal(url.origin, server)
  let operation
  if (body !== undefined) {
    operation = { kind: 'public-api', route, request: scrub(body), checkpoint_at: new Date().toISOString() }
    report.operations.push(operation)
    await save()
  }
  const response = await fetch(url, {
    method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(15_000),
  })
  const result = await response.json()
  if (confidential) for (const key of ['enrollment_token', 'credential']) if (result[key]) secrets.add(result[key])
  if (operation) {
    Object.assign(operation, { status: response.status, response: scrub(result), finished_at: new Date().toISOString() })
    await save()
  }
  assert.equal(response.status, expected, `${route}: HTTP ${response.status}; ${confidential ? 'confidential response omitted' : JSON.stringify(scrub(result))}`)
  return result
}
const snapshot = (actor = demo.alice_actor_id) => request(api(`/snapshot?actor_id=${actor}`))
function fingerprint(state) {
  return sha(canonical(Object.fromEntries(['agents', 'actors', 'missions', 'tasks', 'runs', 'source_deliverables', 'verification_evidence']
    .map(key => [key, state.snapshot[key]]))))
}
async function rejectedWithoutMutation(label, body, pattern) {
  const before = await snapshot()
  const result = await request(api('/missions'), body, 400)
  assert.match(result.error ?? '', pattern)
  assert.equal(fingerprint(await snapshot()), fingerprint(before), `${label}: rejected request changed persisted work`)
  await check(label, { response: result, state_sha256: fingerprint(before) })
}
async function waitFor(predicate, label, timeout = 45_000) {
  const until = Date.now() + timeout
  do {
    healthy()
    const state = await snapshot()
    const value = predicate(state)
    if (value) return { state, value }
    await sleep(200)
  } while (Date.now() < until)
  throw new Error(`Timed out: ${label}; preserve the existing fixture`)
}
async function observeProviders(runIds, known = []) {
  const args = ['-NoProfile', '-File', fileURLToPath(new URL('./issue48-provider-observation-r1.ps1', import.meta.url)),
    '-QaRoot', qa, '-RunIds', runIds.join(',')]
  if (known.length) args.push('-ObservedProcessIds', known.map(p => p.pid).join(','))
  const result = await execFile('pwsh', args, { cwd: qa, env: process.env, windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 })
  const observed = JSON.parse(result.stdout)
  report.physical_provider_observations.push(observed)
  await save()
  return observed
}
function oneEvent(state, run, type) {
  const found = state.snapshot.events.filter(event => event.aggregate_id === run.id && event.type === type)
  assert.equal(found.length, 1, `${run.id}: expected exactly one ${type}`)
  assert.equal(found[0].corp_id, demo.corp_id)
  return found[0]
}
async function signedDownload(record, role) {
  const isSource = role === 'source_deliverable'
  const uri = isSource ? record.uri : record.artifact_uri
  assert.equal(uri, api(`/artifacts/${record.artifact_id}`))
  const response = await fetch(new URL(`${uri}?actor_id=${demo.alice_actor_id}`, server), { redirect: 'error', signal: AbortSignal.timeout(15_000) })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), isSource ? record.media_type : record.artifact_media_type)
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(response.headers.get('x-crony-artifact-role'), role)
  assert.equal(response.headers.get('x-crony-artifact-signature'), isSource ? record.provenance_signature : record.artifact_signature)
  assert.match(response.headers.get('content-disposition') ?? '', /^attachment;/)
  const bytes = Buffer.from(await response.arrayBuffer())
  assert.ok(bytes.length > 0 && bytes.length < 1024 * 1024)
  assert.equal(sha(bytes), isSource ? record.sha256 : record.artifact_sha256)
  if (isSource) assert.equal(bytes.length, record.bytes)
  return bytes
}
const utf8 = bytes => new TextDecoder('utf-8', { fatal: true }).decode(bytes)
const fromBase64 = text => {
  const bytes = Buffer.from(text, 'base64')
  assert.equal(bytes.toString('base64'), text)
  return bytes
}
async function checkParent(state, task, run, verified) {
  const found = state.snapshot.source_deliverables.filter(item => item.run_id === run.id)
  assert.equal(found.length, 1)
  const [record] = found
  assert.equal(record.task_id, task.id)
  assert.equal(record.corp_id, demo.corp_id)
  assert.equal(record.form, 'typed_artifact_set')
  assert.equal(record.base_commit, source.base_commit)
  assert.equal(record.head_commit, null)
  assert.equal(record.branch, run.workspace_branch)
  assert.equal(record.integration_state, 'ready_for_review')
  assert.equal(record.verification_sha256, run.verification_sha256)
  assert.equal(record.sha256, run.deliverable_sha256)
  assert.notEqual(record.artifact_id, run.artifact_id)
  const bytes = await signedDownload(record, 'source_deliverable')
  const document = JSON.parse(utf8(bytes))
  assert.equal(document.schema_version, 1)
  assert.equal(document.form, record.form)
  assert.equal(document.base_commit, record.base_commit)
  assert.equal(document.head_commit, null)
  assert.equal(document.verification_sha256, record.verification_sha256)
  assert.equal(sha(fromBase64(document.patch_base64)), document.patch_sha256)
  assert.deepEqual(sorted(document.changes.map(file => file.path)), sorted(task.contract.deliverable.paths))
  const evidence = state.snapshot.verification_evidence.filter(item => item.run_id === run.id)
  const files = document.changes.map(file => {
    assert.ok(['A', 'M'].includes(file.status))
    assert.ok(['100644', '100755'].includes(file.mode))
    const content = fromBase64(file.content_base64)
    assert.ok(content.length > 0 && content.length <= 6144)
    assert.equal(content.length, file.bytes)
    assert.equal(sha(content), file.sha256)
    const check = evidence.find(item => item.kind === 'file' && item.payload.path === file.path)
    assert.ok(check)
    assert.equal(check.status, 'passed')
    assert.equal(check.payload.sha256, file.sha256)
    assert.equal(check.payload.bytes, file.bytes)
    return { ...metadata(file), text: utf8(content) }
  })
  const note = files.find(file => file.path.endsWith('.md'))
  const probe = files.find(file => file.path.endsWith('-probe.json'))
  assert.ok(note.text.includes(`Run: ${run.id}\n`))
  assert.ok(note.text.includes('Exact bytes: λ\n'))
  const nonce = /^Nonce: ([0-9a-f-]{36})$/m.exec(note.text)?.[1]
  assert.ok(nonce)
  assert.ok(!String(run.summary).includes(nonce))
  assert.deepEqual(JSON.parse(probe.text), { observed: true, run_id: run.id, note_sha256: note.sha256 })
  const event = oneEvent(state, run, 'run.deliverable')
  assert.equal(event.payload.artifact_role, 'source_deliverable')
  assert.ok(event.seq < verified.seq)
  return { task, run, record, files, nonce, deliverable_event: event }
}
let browser, page, observerPage, syntheticSocket, heartbeat
const browserEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
  /^(PATH|PATHEXT|SystemRoot|windir|ComSpec|TEMP|TMP|USERPROFILE|HOMEDRIVE|HOMEPATH|HOME|APPDATA|LOCALAPPDATA|PROGRAMDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMW6432|SYSTEMDRIVE|USERNAME|USERDOMAIN|COMPUTERNAME|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE|OS)$/i.test(name)))
async function capture(label, target = page) {
  const file = path.join(output, `${label}.png`)
  await target.screenshot({ path: file, fullPage: true })
  report.screenshots.push({ label, file, sha256: sha(await readFile(file)), viewport: target.viewportSize() })
  await save()
}
async function browserMission(strategy, label) {
  await stage(`Browser ${label}`)
  const before = await snapshot()
  await page.goto(`${web}/?actor=alice#missions`, { waitUntil: 'domcontentloaded' })
  await page.locator('#missions #mission-title, #missions #new-mission-button')
    .waitFor({ state: 'visible', timeout: 30_000 })
  if (!(await page.locator('#mission-title').isVisible())) await page.locator('#new-mission-button').click()
  await page.locator('#mission-title').waitFor({ state: 'visible', timeout: 30_000 })
  await page.locator('#mission-title').fill(`[slow] Issue48 ${label}`)
  const options = await page.locator('#mission-repository option').evaluateAll(items => items.map(item => ({ value: item.value, text: item.textContent })))
  const option = options.filter(item => item.text.includes(source.repository))
  assert.equal(option.length, 1)
  await page.locator('#mission-repository').selectOption(option[0].value)
  await page.getByRole('checkbox', { name: /Confirm this target/ }).check()
  await page.locator('#mission-strategy').selectOption(strategy)
  const details = page.locator('details').filter({ has: page.locator('summary', { hasText: /^Model, limits and output/ }) })
  if (!(await details.evaluate(element => element.open))) await details.locator('summary').click()
  await page.getByRole('checkbox', { name: /Developer fixtures/ }).check()
  await page.locator('#mission-adapter').selectOption('fake-process')
  await page.getByRole('checkbox', { name: /Commit verified work/ }).uncheck()
  await page.getByRole('checkbox', { name: /Save without starting/ }).uncheck()
  await page.getByRole('button', { name: 'Review and build', exact: true }).click()
  await capture(`${label}-review`)
  const operation = { kind: 'browser-build', strategy, source, adapter: 'fake-process', title: `[slow] Issue48 ${label}`, checkpoint_at: new Date().toISOString() }
  report.operations.push(operation)
  await save()
  const creation = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === api('/missions'), { timeout: 30_000 })
  const launch = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname.startsWith(api('/missions/')) && new URL(response.url()).pathname.endsWith('/launch'), { timeout: 30_000 })
  const [, createdResponse, launchResponse] = await Promise.all([page.getByRole('button', { name: 'Build', exact: true }).click(), creation, launch])
  Object.assign(operation, { request: createdResponse.request().postDataJSON(), created: await createdResponse.json(), creation_status: createdResponse.status(), launch: await launchResponse.json(), launch_status: launchResponse.status(), finished_at: new Date().toISOString() })
  await save()
  assert.equal(operation.creation_status, 200, JSON.stringify(operation.created))
  assert.equal(operation.launch_status, 200, JSON.stringify(operation.launch))
  assert.equal(operation.request.strategy, strategy)
  assert.equal(operation.request.preferred_adapter, 'fake-process')
  assert.deepEqual(operation.request.source, source)
  const result = { label, strategy, mission_id: operation.created.mission_id, entry: 'browser-create-and-launch', baseline_agent_ids: before.snapshot.agents.map(item => item.id) }
  report.missions.push(result)
  await save()
  return result
}
async function finishMission(record) {
  const total = record.strategy === 'test-review' ? 2 : 3
  const expectedRoles = record.strategy === 'test-review' ? ['reviewer', 'tester'] : ['manager', 'specialist-a', 'specialist-b']
  const observed = new Map()
  const until = Date.now() + 180_000
  let state, tasks, runs, agents, mission
  do {
    healthy()
    state = await snapshot()
    mission = state.snapshot.missions.find(item => item.id === record.mission_id)
    assert.ok(mission)
    tasks = state.snapshot.tasks.filter(item => item.mission_id === mission.id)
    agents = state.snapshot.agents.filter(item => item.mission_id === mission.id)
    runs = state.snapshot.runs.filter(item => tasks.some(task => task.id === item.task_id))
    assert.equal(tasks.length, total)
    assert.equal(agents.length, total)
    assert.deepEqual(sorted(agents.map(item => item.role)), expectedRoles)
    assert.ok(agents.every(item => item.adapter === 'fake-process' && !item.pinned && !record.baseline_agent_ids.includes(item.id)))
    assert.ok(runs.length <= total && runs.every(item => !['failed', 'stopped', 'verification_failed'].includes(item.status)), 'Native mission failed; retain original run lineage')
    assert.ok(!['failed', 'cancelled', 'stopped'].includes(mission.status))
    const active = runs.filter(run => run.status === 'running' && !observed.has(run.id)).map(run => run.id)
    if (active.length) {
      const observation = await observeProviders(active)
      for (const match of observation.matches) {
        assert.ok(match.owned_runner_parent && match.owned_workspace_argument)
        observed.set(match.run_id, match.identity)
      }
    }
    if (mission.status === 'completed' && runs.length === total && agents.every(item => item.retired_at) &&
        runs.every(item => item.status === 'completed' && item.verification_status === 'passed' && item.workspace_disposition === 'preserved')) break
    await sleep(200)
  } while (Date.now() < until)
  assert.equal(mission.status, 'completed')
  assert.equal(runs.length, total)
  assert.equal(observed.size, total, 'Every native provider must be physically observed before terminal teardown')
  assert.ok(agents.every(item => item.retired_at && item.current_run_id == null))
  assert.equal(new Set(runs.map(item => item.workspace_path.toLowerCase())).size, total)
  assert.equal(new Set(runs.map(item => item.workspace_branch)).size, total)
  assert.equal(new Set(runs.map(item => item.workspace_run_id)).size, total)
  const parents = []
  const rootKeys = record.strategy === 'test-review' ? ['tester'] : ['specialist-a', 'specialist-b']
  let child
  record.native = []
  for (const task of tasks) {
    const run = runs.find(item => item.task_id === task.id)
    assert.equal(task.status, 'completed')
    assert.equal(task.verification_status, 'passed')
    assert.equal(task.attempt_count, 1)
    assert.equal(run.runner_id, owner.plan.runner_id)
    assert.equal(run.workspace_run_id, run.id)
    assert.equal(run.resumed_from_run_id, null)
    assert.equal(run.source_repository, source.repository)
    assert.equal(run.source_base_ref, source.base_ref)
    assert.equal(run.source_base_commit, source.base_commit)
    assert.equal(run.workspace_base_commit, source.base_commit)
    assert.equal(run.workspace_disposition, 'preserved')
    assert.notEqual(path.resolve(run.workspace_path).toLowerCase(), path.resolve(owner.source.path).toLowerCase())
    const evidence = state.snapshot.verification_evidence.filter(item => item.run_id === run.id).sort((a, b) => a.check_index - b.check_index)
    assert.equal(evidence.length, task.verification_policy.checks.length)
    for (const [index, item] of evidence.entries()) {
      assert.equal(item.task_id, task.id)
      assert.equal(item.corp_id, demo.corp_id)
      assert.equal(item.status, 'passed')
      assert.equal(item.kind, task.verification_policy.checks[index].type)
      if (item.kind === 'command') {
        assert.equal(item.payload.exit_code, 0)
        assert.equal(item.payload.program, task.verification_policy.checks[index].program)
        assert.deepEqual(item.payload.args, task.verification_policy.checks[index].args)
      }
    }
    const requested = oneEvent(state, run, 'run.requested')
    const started = oneEvent(state, run, 'run.started')
    const verified = oneEvent(state, run, 'run.verification_passed')
    const completed = oneEvent(state, run, 'run.completed')
    const terminated = oneEvent(state, run, 'run.session_terminated')
    assert.equal(started.payload.adapter, 'fake-process')
    assert.ok(requested.seq < started.seq && started.seq < verified.seq && verified.seq < completed.seq)
    assert.equal(terminated.payload.provider_process_alive, false)
    const agent = agents.find(item => item.id === task.assigned_agent_id)
    const staffed = oneEvent(state, agent, 'agent.staffed')
    const retired = oneEvent(state, agent, 'agent.retired')
    assert.equal(staffed.actor_id, demo.alice_actor_id)
    assert.equal(staffed.room_id, mission.room_id)
    assert.equal(retired.room_id, mission.room_id)
    assert.ok(staffed.seq < requested.seq && retired.seq > verified.seq)
    const native = { task_id: task.id, run_id: run.id, evidence, requested, started, verified, completed, terminated, staffed, retired }
    record.native.push(native)
    if (rootKeys.includes(task.plan_key)) parents.push({ ...await checkParent(state, task, run, verified), native })
    else { assert.equal(child, undefined); child = { task, run, native } }
  }
  assert.equal(parents.length, total - 1)
  assert.ok(child)
  assert.equal(child.task.plan_key, record.strategy === 'test-review' ? 'reviewer' : 'synthesis')
  assert.ok(child.native.requested.seq > Math.max(...parents.map(item => item.native.completed.seq)))
  if (parents.length === 2) assert.ok(Math.max(...parents.map(item => item.native.started.seq)) < Math.min(...parents.map(item => item.native.completed.seq)), 'Native specialist roots must overlap')
  const context = oneEvent(state, child.run, 'run.dependency_context')
  assert.ok(child.native.requested.seq < context.seq && context.seq < child.native.started.seq)
  const normalize = items => items.map(item => ({ ...item, files: [...item.files].sort(byPath) })).sort((a, b) => a.task_id.localeCompare(b.task_id))
  const expected = parents.map(item => ({ task_id: item.task.id, run_id: item.run.id, verification_run_id: item.run.id,
    artifact_id: item.record.artifact_id, sha256: item.record.sha256, artifact_role: 'source_deliverable', files: item.files.map(metadata) }))
  assert.deepEqual(normalize(context.payload.handoffs), normalize(expected))
  const artifact = utf8(await signedDownload(child.run, 'provider_evidence'))
  const readbacks = [...artifact.matchAll(/^DEPENDENCY READBACK: (.+)$/gm)]
  assert.equal(readbacks.length, 1)
  const readback = JSON.parse(readbacks[0][1])
  assert.deepEqual([...readback].sort(byPath), parents.flatMap(item => item.files.map(metadata)).sort(byPath))
  for (const parent of parents) for (const file of parent.files) {
    assert.ok(artifact.includes(file.text))
    assert.ok(artifact.includes(`SOURCE FILE ${file.path} / sha256 ${file.sha256} / bytes ${file.bytes}\n`))
  }
  const finalProcesses = await observeProviders(runs.map(item => item.id), [...observed.values()])
  assert.equal(finalProcesses.matches.length, 0)
  for (const prior of observed.values()) {
    const current = finalProcesses.prior_processes.find(item => item.pid === prior.pid)?.current
    assert.ok(!current || current.started_utc !== prior.started_utc || current.executable !== prior.executable)
  }
  assert.equal(execFileSync('git', ['-C', owner.source.path, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), source.base_commit)
  assert.equal(execFileSync('git', ['-C', owner.source.path, 'status', '--porcelain'], { encoding: 'utf8' }).trim(), '')
  record.handoffs = parents.map(item => ({ task_id: item.task.id, run_id: item.run.id, source: item.record, files: item.files, nonce: item.nonce }))
  record.child = { run_id: child.run.id, dependency_event: context, readback, provider_artifact_sha256: child.run.artifact_sha256 }
  record.counts = { workers: agents.length, runs: runs.length, completed_runs: runs.filter(item => item.status === 'completed').length,
    retired_workers: agents.filter(item => item.retired_at).length, persisted_verifier_rows: record.native.reduce((count, item) => count + item.evidence.length, 0) }
  await writeFile(path.join(output, `${record.label}-snapshot.json`), JSON.stringify(scrub(state), null, 2) + '\n', { flag: 'wx' })
  await capture(`${record.label}-complete`)
  await check(`${record.label}: exact roles, native isolation, verified file handoffs, dependency order, retained history and physical provider teardown`, record.counts)
}
async function registerIncompatibleRunner() {
  const runnerId = `issue48-incompatible-${randomUUID()}`
  const connectionEpoch = randomUUID()
  const cap = name => ({ name, available: true, detail: 'Synthetic Issue48 capability-selection fixture; no provider execution', models: [] })
  const capabilities = [cap('github-copilot'), cap('canonical-source-verification-v1'), {
    ...cap('workspace-isolation'), source_repository: source.repository, source_base_ref: source.base_ref, source_base_commit: source.base_commit,
  }]
  report.synthetic_runner = { runner_id: runnerId, connection_epoch: connectionEpoch, capabilities, omitted: 'verified-dependency-files-v1', provider_execution: false }
  await save()
  let enrollment = await request(api('/runners/enroll'), { actor_id: demo.alice_actor_id, runner_id: runnerId, expires_in_seconds: 300 }, 200, true)
  let credential = enrollment.enrollment_token
  enrollment = null
  try {
    await new Promise((resolve, reject) => {
      syntheticSocket = new WebSocket(`${server.replace('http:', 'ws:')}/ws/runner`)
      const timeout = setTimeout(() => reject(new Error('Synthetic registration timed out')), 10_000)
      syntheticSocket.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('Synthetic websocket failed')) })
      syntheticSocket.addEventListener('open', () => {
        syntheticSocket.send(JSON.stringify({ type: 'register', runner_id: runnerId, corp_id: demo.corp_id, credential,
          connection_epoch: connectionEpoch, hostname: 'Issue48 synthetic incompatible advertisement', os: 'windows', capabilities, active_runs: [] }))
      })
      syntheticSocket.addEventListener('message', event => {
        const payload = JSON.parse(event.data)
        if (payload.credential) { secrets.add(payload.credential); payload.credential = '[REDACTED]' }
        report.synthetic_messages.push({ type: payload.type, at: new Date().toISOString(), run_id: payload.run_id ?? null })
        if (payload.type === 'registered') {
          clearTimeout(timeout)
          if (payload.runner_id !== runnerId) return reject(new Error('Synthetic identity mismatch'))
          heartbeat = setInterval(() => { if (syntheticSocket.readyState === WebSocket.OPEN) syntheticSocket.send(JSON.stringify({ type: 'heartbeat', runner_id: runnerId, connection_epoch: connectionEpoch, active_runs: [] })) }, 2000)
          resolve()
        } else if (payload.type === 'registration_rejected') {
          clearTimeout(timeout)
          reject(new Error('Synthetic enrollment was rejected; confidential payload omitted'))
        } else if (['start_run', 'resume_run', 'workspace_setup'].includes(payload.type)) {
          syntheticFailure = 'Server incorrectly dispatched work to the incompatible synthetic advertisement; no command was executed'
        }
      })
    })
  } finally { credential = null }
  await waitFor(state => state.runners.some(runner => runner.id === runnerId && runner.connected), 'synthetic capability advertisement')
  await save()
}
try {
  const { selectFixtureRunnerForSource, waitForControlledRunnerDispatch } = await import(pathToFileURL(path.join(product, 'tools/controlled_runner_fixture.mjs')))
  const initial = await snapshot()
  for (const key of ['agents', 'missions', 'tasks', 'runs']) assert.equal(initial.snapshot[key].length, 0, 'Requires a fresh zero-work fixture')
  const selected = selectFixtureRunnerForSource(initial, demo, source)
  assert.equal(selected.runnerId, owner.plan.runner_id)
  await waitForControlledRunnerDispatch({ demo, runner: selected, request: async (route, options) => {
    const response = await fetch(new URL(route, server), { ...options, signal: AbortSignal.timeout(15_000) })
    return { response, body: await response.json() }
  } })
  const { chromium } = createRequire(import.meta.url)(process.env.CRONY_PLAYWRIGHT_MODULE)
  browser = await chromium.launch({ channel: 'msedge', headless: true, env: browserEnv })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  await context.route('**/*', route => {
    const url = new URL(route.request().url())
    if ([server, web].includes(url.origin)) return route.continue()
    report.blocked_requests.push({ origin: url.origin, pathname: url.pathname })
    return route.abort('blockedbyclient')
  })
  page = await context.newPage()
  observerPage = await context.newPage()
  for (const target of [page, observerPage]) target.on('pageerror', error => report.page_errors.push(redact(error)))
  await observerPage.goto(`${web}/?actor=bob#floor`, { waitUntil: 'domcontentloaded' })
  await observerPage.locator('.crew-management').waitFor({ state: 'visible', timeout: 30_000 })
  await observerPage.getByRole('checkbox', { name: 'Show offline and test identities', exact: true }).check()
  await check('Native isolated runner and fresh zero-worker Corp are ready', { runner: selected, initial_counts: { agents: 0, missions: 0, tasks: 0, runs: 0 } })
  const base = { requested_by: demo.alice_actor_id, title: '[slow] Issue48 validation request', strategy: 'test-review', source, budget_tokens: 240_000, budget_cost_microusd: 2_000_000 }
  const missingSource = { ...base, preferred_adapter: 'fake-process' }; delete missingSource.source
  await rejectedWithoutMutation('Tester/reviewer requires an explicit immutable source', missingSource, /explicitly selected repository/)
  await rejectedWithoutMutation('Unavailable adapter rejects before staffing', { ...base, preferred_adapter: 'codex' }, /no connected runner|unavailable|not available|no matching/)
  await rejectedWithoutMutation('Unavailable model rejects before staffing', { ...base, preferred_adapter: 'fake-process', preferred_model: 'nonexistent-issue48-model' }, /model|unavailable|not available/)
  await finishMission(await browserMission('test-review', 'tester-reviewer'))
  await finishMission(await browserMission('parallel-specialists', 'specialists-synthesis'))
  await stage('Automatic selection skips higher-priority runner without native handoff delivery')
  await registerIncompatibleRunner()
  await rejectedWithoutMutation('Explicit higher-priority adapter without dependency-file capability rejects before staffing', { ...base, preferred_adapter: 'github-copilot' }, /no connected runner|no matching/)
  const beforeFallback = await snapshot()
  const created = await request(api('/missions'), { ...base, title: '[slow] Issue48 automatic native fallback' })
  const planned = await snapshot()
  assert.ok(planned.snapshot.agents.filter(agent => agent.mission_id === created.mission_id).every(agent => agent.adapter === 'fake-process'))
  const launched = await request(api(`/missions/${created.mission_id}/launch`), { requested_by: demo.alice_actor_id })
  assert.equal(launched.runner_id, owner.plan.runner_id)
  const fallback = { label: 'automatic-fallback', strategy: 'test-review', mission_id: created.mission_id, entry: 'public-api-automatic-adapter', baseline_agent_ids: beforeFallback.snapshot.agents.map(item => item.id) }
  report.missions.push(fallback)
  await save()
  await finishMission(fallback)
  const final = await snapshot()
  report.final_counts = { agents: final.snapshot.agents.length, retired: final.snapshot.agents.filter(agent => agent.retired_at).length,
    missions: final.snapshot.missions.length, tasks: final.snapshot.tasks.length, runs: final.snapshot.runs.length,
    completed_runs: final.snapshot.runs.filter(run => run.status === 'completed').length, verifier_rows: final.snapshot.verification_evidence.length }
  assert.deepEqual(report.final_counts, { agents: 7, retired: 7, missions: 3, tasks: 7, runs: 7, completed_runs: 7, verifier_rows: 19 })
  healthy()
  assert.equal(report.page_errors.length, 0)
  assert.equal(report.blocked_requests.length, 0)
  assert.ok(report.synthetic_messages.every(message => !['start_run', 'resume_run'].includes(message.type)))
  await writeFile(path.join(output, 'final-snapshot.json'), JSON.stringify(scrub(final), null, 2) + '\n', { flag: 'wx' })
  await observerPage.reload({ waitUntil: 'domcontentloaded' })
  await observerPage.getByText('Retired history (7)', { exact: true }).waitFor({ state: 'visible' })
  await capture('all-seven-retired-history', observerPage)
  await check('All seven dynamically staffed identities retain history after verified native completion; incompatible runner receives no work', report.final_counts)
  report.status = 'passed'
  report.stage = 'complete'
} catch (error) {
  report.status = 'failed'
  report.failure = redact(error)
  if (page && !page.isClosed()) { try { await capture('failure-observation') } catch { /* Preserve original failure. */ } }
  throw new Error(report.failure)
} finally {
  if (heartbeat) clearInterval(heartbeat)
  if (syntheticSocket) syntheticSocket.close()
  if (browser) await browser.close()
  report.finished_at_utc = new Date().toISOString()
  await save()
  secrets.clear()
  console.log(JSON.stringify({ status: report.status, stage: report.stage, assertions: report.assertions.length, report: reportPath }))
}
