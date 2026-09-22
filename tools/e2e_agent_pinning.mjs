// Native deterministic fixture, not production identity or vendor inference.
// An external owner starts/stops the isolated server, runner, PostgreSQL and web.
// prepare -> Alice clicks Pin in the actual office -> start ->
// Bob clicks Unpin in a second actual browser -> complete -> inspect history.
// Never resets a Corp or replaces an interrupted checkpoint.
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { lstat, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

assert.equal(process.env.CRONY_PIN_TEST, '1', 'Explicit owned-stack opt-in required')
assert.deepEqual(process.argv.slice(2, 3), ['--phase'])
assert.equal(process.argv.length, 4)
const phase = process.argv[3]
assert.ok(['prepare', 'start', 'complete'].includes(phase))
function origin(value) {
  const url = new URL(value)
  assert.equal(url.protocol, 'http:')
  assert.equal(url.hostname, '127.0.0.1')
  assert.ok(Number(url.port) >= 59030 && Number(url.port) <= 59039, 'Use this fixture owner’s allocated ports')
  assert.equal(url.pathname, '/')
  assert.ok(!url.username && !url.password && !url.search && !url.hash)
  return url.origin
}
const server = origin(process.env.CRONY_SERVER_HTTP)
const web = origin(process.env.CRONY_PIN_WEB)
for (const key of ['CRONY_PIN_OUTPUT', 'CRONY_PIN_PRIVATE', 'CRONY_CLI_BINARY', 'CRONY_PIN_SOURCE', 'ECORP_PSQL_BINARY']) {
  assert.ok(process.env[key] && path.isAbsolute(process.env[key]), `${key} must be explicit and absolute`)
}
assert.equal(process.env.PGHOST, '127.0.0.1')
assert.equal(process.env.PGPORT, '59030')
assert.match(process.env.PGDATABASE ?? '', /^issue48_app(?:_[a-z0-9]+)?$/)
assert.equal(process.env.PGUSER, 'issue48')
// Resolve existing ancestors before creating anything: lexical absolute paths
// can still alias the source through junctions, symlinks or Windows casing.
async function directoryLocation(value) {
  let ancestor = path.resolve(value)
  const missing = []
  for (;;) {
    try {
      await lstat(ancestor)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      const parent = path.dirname(ancestor)
      assert.notEqual(parent, ancestor, 'Directory must have an existing ancestor')
      missing.unshift(path.basename(ancestor))
      ancestor = parent
      continue
    }
    // A dangling link must fail here, rather than being treated as a missing
    // directory and followed by a later recursive mkdir.
    const resolved = await realpath(ancestor)
    assert.ok((await stat(resolved)).isDirectory(), 'Existing ancestor must be a directory')
    return path.join(resolved, ...missing)
  }
}
const source = await realpath(process.env.CRONY_PIN_SOURCE)
assert.ok((await stat(source)).isDirectory(), 'Source must be a directory')
const output = await directoryLocation(process.env.CRONY_PIN_OUTPUT)
const privateDirectory = await directoryLocation(process.env.CRONY_PIN_PRIVATE)
const directories = [source, output, privateDirectory]
function contains(parent, child) {
  const relative = path.relative(parent, child)
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
}
for (let left = 0; left < directories.length; left += 1) {
  for (let right = left + 1; right < directories.length; right += 1) {
    assert.ok(!contains(directories[left], directories[right]) && !contains(directories[right], directories[left]),
      'source, output and private directories must be disjoint')
  }
}
async function verifyDirectories() {
  for (const directory of directories) {
    assert.equal(path.relative(directory, await directoryLocation(directory)), '', 'Fixture directory changed or became an alias')
  }
}
const checkpointPath = path.join(output, 'native-agent-pinning.json')
const privatePath = path.join(privateDirectory, 'pin-lease.json')
async function verifyFile(file) {
  let info
  try { info = await lstat(file) } catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  }
  assert.ok(info.isFile() && !info.isSymbolicLink() && info.nlink === 1, 'Fixture files must be regular unaliased files')
}
await verifyFile(checkpointPath)
await verifyFile(privatePath)
const sha = (value) => createHash('sha256').update(value).digest('hex')
const canonical = (value) => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const sql = (query) => JSON.parse(execFileSync(process.env.ECORP_PSQL_BINARY,
  ['-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-c', query],
  { encoding: 'utf8', windowsHide: true, timeout: 15000 }).trim())
const sourceIdentity = () => ({
  head: execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  status: execFileSync('git', ['-C', source, 'status', '--porcelain'], { encoding: 'utf8' }).trim(),
  seed: sha(execFileSync('git', ['-C', source, 'show', 'HEAD:seed.txt'])),
})
let checkpoint
await mkdir(output, { recursive: true })
if (phase === 'prepare') {
  checkpoint = {
    schema_version: 1, phase: 'preparing', server, web, started_at: new Date().toISOString(),
    scope: 'Owned native development-principal server/runner/browser/CLI deterministic fixture; no provider inference or external effects.',
    operations: [], checks: [], source: sourceIdentity(),
  }
  assert.equal(checkpoint.source.status, '', 'Independent source must begin clean')
  await writeFile(checkpointPath, `${JSON.stringify(checkpoint, null, 2)}\n`, { flag: 'wx' })
} else {
  checkpoint = JSON.parse(await readFile(checkpointPath, 'utf8'))
  assert.equal(checkpoint.server, server)
  assert.equal(checkpoint.web, web)
  assert.equal(checkpoint.phase, phase === 'start' ? 'awaiting_browser_pin' : 'awaiting_browser_unpin')
}
const save = async () => {
  await verifyDirectories()
  await verifyFile(checkpointPath)
  await writeFile(checkpointPath, `${JSON.stringify(checkpoint, null, 2)}\n`)
}
const check = (name) => { checkpoint.checks.push(name) }
const api = (suffix) => `/api/corps/${checkpoint.ids.corp_id}${suffix}`
async function request(route, body, expected = 200) {
  if (body !== undefined) {
    checkpoint.operations.push({ route, body, intent_at: new Date().toISOString() })
    await save()
  }
  const response = await fetch(`${server}${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000), redirect: 'error',
  })
  const text = await response.text()
  let result
  try { result = JSON.parse(text) } catch { result = { error: text } }
  assert.equal(response.status, expected, `${route}: ${JSON.stringify(result)}`)
  return result
}
const snapshot = (actor = checkpoint.ids.alice_actor_id) => request(api(`/snapshot?actor_id=${actor}`))
const agent = (state) => state.snapshot.agents.find((item) => item.id === checkpoint.agent)
const run = (state, id) => state.snapshot.runs.find((item) => item.id === id)
const pinEvents = (state) => state.snapshot.events.filter((event) =>
  event.aggregate_id === checkpoint.agent && ['agent.pinned', 'agent.unpinned'].includes(event.type))
const replayBody = (event) => ({
  actor_id: event.payload.request.actor_id,
  pinned: event.payload.request.pinned,
  expected_version: event.payload.request.expected_version,
  idempotency_key: event.idempotency_key.replace('agent-pin:', ''),
})
async function waitFor(predicate, label, ms = 60000) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    const state = await snapshot()
    if (predicate(state)) return state
    await sleep(200)
  }
  throw new Error(`Timed out: ${label}; preserve existing checkpoint`)
}
function obligationsDigest() {
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
async function cliPin(pinned, version) {
  const key = randomUUID()
  checkpoint.operations.push({ cli: pinned ? 'pin' : 'unpin', agent: checkpoint.agent, version, key })
  await save()
  const args = ['--server', server, pinned ? 'pin' : 'unpin', checkpoint.ids.corp_id, checkpoint.agent,
    checkpoint.ids.alice_actor_id, '--expected-version', String(version), '--operation-key', key]
  const first = JSON.parse(execFileSync(process.env.CRONY_CLI_BINARY, args,
    { encoding: 'utf8', windowsHide: true, timeout: 15000 }))
  const replay = JSON.parse(execFileSync(process.env.CRONY_CLI_BINARY, args,
    { encoding: 'utf8', windowsHide: true, timeout: 15000 }))
  assert.equal(first.replayed, false)
  assert.equal(replay.replayed, true)
  assert.equal(replay.pin_version, version + 1)
  assert.equal(replay.pinned, pinned)
}
function missionBody(title) {
  return {
    requested_by: checkpoint.ids.alice_actor_id, title, preferred_adapter: 'fake-process', strategy: 'single',
    source: checkpoint.mission_source, budget_tokens: 80000, budget_cost_microusd: 1000000,
    verification_policy: { checks: [{ type: 'artifact', min_bytes: 1 }, { type: 'file', path: 'result.md', min_bytes: 1 }], manual_gate: null },
  }
}
try {
  if (phase === 'prepare') {
    checkpoint.ids = await request('/api/demo/bootstrap?seed_crew=false', {})
    const state = await snapshot()
    assert.equal(state.snapshot.agents.length, 0)
    assert.equal(state.snapshot.missions.length, 0)
    assert.equal(state.snapshot.runs.length, 0)
    assert.equal(state.snapshot.factory_work_items.length, 0)
    assert.equal(state.runners.length, 1)
    assert.equal(state.runners[0].id, 'runner-issue48-42269426')
    const cap = state.runners[0].capabilities.find((item) => item.name === 'workspace-isolation' && item.available)
    assert.ok(cap)
    checkpoint.mission_source = { repository: cap.source_repository, base_ref: cap.source_base_ref, base_commit: cap.source_base_commit }
    assert.equal(checkpoint.mission_source.base_commit, checkpoint.source.head)
    checkpoint.first = await request(api('/missions'), missionBody('[approval-action] issue48 native retention'))
    const created = await snapshot()
    const task = created.snapshot.tasks.find((task) => task.mission_id === checkpoint.first.mission_id)
    checkpoint.agent = task.assigned_agent_id
    assert.deepEqual(task.verification_policy, missionBody('').verification_policy)
    assert.equal(created.snapshot.agents.length, 1)
    assert.equal(agent(created).pin_version, 0)
    assert.equal(created.snapshot.runs.length, 0)
    check('empty Corp provisions one held mission-owned identity')
    checkpoint.phase = 'awaiting_browser_pin'
  } else if (phase === 'start') {
    const state = await snapshot()
    assert.equal(agent(state).pinned, true)
    assert.equal(agent(state).pin_version, 1)
    assert.equal(pinEvents(state).length, 1)
    assert.equal(pinEvents(state)[0].actor_id, checkpoint.ids.alice_actor_id)
    checkpoint.browser_pin_event = pinEvents(state)[0]
    check('Alice browser Pin persisted version one and actor-attributed audit')
    await request(api(`/agents/${checkpoint.agent}/pin`), {
      actor_id: checkpoint.ids.eve_actor_id, pinned: false, expected_version: 1, idempotency_key: randomUUID(),
    }, 403)
    const foreign = replayBody(checkpoint.browser_pin_event)
    foreign.expected_version = 1
    await request(`/api/corps/${randomUUID()}/agents/${checkpoint.agent}/pin`,
      { ...foreign, idempotency_key: randomUUID() }, 403)
    await request(api(`/agents/${checkpoint.agent}/pin`),
      { ...foreign, retire: true, idempotency_key: randomUUID() }, 422)
    check('guest foreign-Corp and extra-effect requests denied')
    checkpoint.launch = await request(api(`/missions/${checkpoint.first.mission_id}/launch`),
      { requested_by: checkpoint.ids.alice_actor_id })
    const pending = await waitFor((s) => s.snapshot.action_approvals.some((a) =>
      a.run_id === checkpoint.launch.run_id && a.status === 'pending'), 'native provider approval')
    assert.equal(run(pending, checkpoint.launch.run_id).status, 'waiting_for_approval')
    checkpoint.approval = pending.snapshot.action_approvals.find((a) => a.run_id === checkpoint.launch.run_id).id
    const lease = await request(api(`/agents/${checkpoint.agent}/lease`), { actor_id: checkpoint.ids.bob_actor_id })
    assert.equal(lease.acquired, true)
    await verifyDirectories()
    await mkdir(privateDirectory, { recursive: true })
    await writeFile(privatePath, JSON.stringify(lease), { flag: 'wx' })
    checkpoint.queued = await request(api(`/agents/${checkpoint.agent}/messages`), {
      actor_id: checkpoint.ids.alice_actor_id, text: 'Retain for the next assigned mission; this is not a task.',
      idempotency_key: randomUUID(),
    })
    checkpoint.obligations_before_unpin = obligationsDigest()
    checkpoint.phase = 'awaiting_browser_unpin'
  } else {
    const state = await snapshot()
    assert.equal(agent(state).pinned, false)
    assert.equal(agent(state).pin_version, 2)
    const unpin = pinEvents(state).find((event) => event.type === 'agent.unpinned')
    assert.equal(unpin.actor_id, checkpoint.ids.bob_actor_id)
    checkpoint.browser_unpin_event = unpin
    assert.equal(obligationsDigest(), checkpoint.obligations_before_unpin)
    assert.equal(run(state, checkpoint.launch.run_id).status, 'waiting_for_approval')
    check('Bob browser Unpin preserves exact native run task mission lease approval message command rows')
    await cliPin(true, 2)
    check('native CLI Pin and duplicate replay commit exactly once')
    await request(api(`/approvals/${checkpoint.approval}/decision`), {
      actor_id: checkpoint.ids.bob_actor_id, approved: true, note: 'Owned deterministic fixture approval',
      decision_key: randomUUID(),
    })
    const firstDone = await waitFor((s) => run(s, checkpoint.launch.run_id)?.status === 'completed' &&
      s.snapshot.events.some((e) => e.aggregate_id === checkpoint.launch.run_id && e.type === 'run.session_terminated'), 'first native accepted completion')
    assert.equal(agent(firstDone).pinned, true)
    assert.equal(agent(firstDone).retired_at, null)
    assert.equal(agent(firstDone).current_run_id, null)
    check('native accepted terminal mission retains pinned identity with provider terminated')
    const lease = JSON.parse(await readFile(privatePath, 'utf8'))
    // The short-lived private token never enters the public checkpoint.
    if (Date.parse(lease.expires_at) > Date.now()) {
      const release = await fetch(`${server}${api(`/agents/${checkpoint.agent}/lease/release`)}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ actor_id: checkpoint.ids.bob_actor_id, token: lease.token }),
        signal: AbortSignal.timeout(15000), redirect: 'error',
      })
      assert.equal(release.status, 200)
    } else {
      check('short-lived lease expired naturally; historical row was not deleted')
    }
    checkpoint.second = await request(api('/missions'), missionBody('issue48 pinned identity reused'))
    let next = await snapshot()
    const secondTask = next.snapshot.tasks.find((t) => t.mission_id === checkpoint.second.mission_id)
    assert.equal(secondTask.assigned_agent_id, checkpoint.agent)
    assert.equal(next.snapshot.agents.length, 1)
    await cliPin(false, 3)
    // The native retirement reconciler ticks every three seconds.
    await sleep(6500)
    next = await snapshot()
    assert.equal(agent(next).retired_at, null)
    assert.equal(next.snapshot.missions.find((m) => m.id === checkpoint.second.mission_id).status, 'ready')
    check('pinned identity reused in same room; Unpin preserves second held plan and does not retire early')
    const originalPin = checkpoint.browser_pin_event
    const replay = await request(api(`/agents/${checkpoint.agent}/pin`), replayBody(originalPin))
    assert.equal(replay.replayed, true)
    assert.equal(replay.pin_version, 1)
    assert.equal(agent(await snapshot()).pinned, false)
    checkpoint.second_launch = await request(api(`/missions/${checkpoint.second.mission_id}/launch`),
      { requested_by: checkpoint.ids.alice_actor_id })
    const settled = await waitFor((s) => run(s, checkpoint.second_launch.run_id)?.status === 'completed' &&
      agent(s)?.retired_at != null, 'unpinned reused identity automatic retirement')
    assert.equal(settled.snapshot.runs.length, 2)
    assert.equal(settled.snapshot.agents.length, 1)
    assert.equal(settled.snapshot.missions.length, 2)
    assert.equal(settled.snapshot.tasks.length, 2)
    assert.equal(settled.snapshot.factory_work_items.length, 0)
    assert.ok(settled.snapshot.queued_messages.every((q) => q.id !== checkpoint.queued.message_id || q.status === 'delivered'))
    checkpoint.native_runs = []
    for (const nativeRun of settled.snapshot.runs) {
      assert.equal(nativeRun.source_base_commit, checkpoint.source.head)
      assert.equal(nativeRun.workspace_base_commit, checkpoint.source.head)
      assert.equal(nativeRun.verification_status, 'passed')
      assert.notEqual(path.resolve(nativeRun.workspace_path), path.resolve(process.env.CRONY_PIN_SOURCE))
      const evidence = settled.snapshot.verification_evidence.filter((v) => v.run_id === nativeRun.id)
      assert.equal(evidence.length, 2)
      assert.ok(evidence.every((v) => v.status === 'passed'))
      const termination = settled.snapshot.events.find((event) =>
        event.aggregate_id === nativeRun.id && event.type === 'run.session_terminated')
      assert.equal(termination.payload.provider_process_alive, false)
      const downloaded = await fetch(`${server}${api(`/artifacts/${nativeRun.artifact_id}?actor_id=${checkpoint.ids.alice_actor_id}`)}`,
        { signal: AbortSignal.timeout(15000), redirect: 'error' })
      assert.equal(downloaded.status, 200)
      const bytes = Buffer.from(await downloaded.arrayBuffer())
      assert.equal(sha(bytes), nativeRun.artifact_sha256)
      await writeFile(path.join(output, `${nativeRun.id}-provider-artifact.txt`), bytes)
      checkpoint.native_runs.push({
        id: nativeRun.id, task_id: nativeRun.task_id, agent_id: nativeRun.agent_id,
        source_base_commit: nativeRun.source_base_commit, workspace_path: nativeRun.workspace_path,
        workspace_disposition: nativeRun.workspace_disposition,
        artifact_id: nativeRun.artifact_id, artifact_sha256: nativeRun.artifact_sha256,
        verification_sha256: nativeRun.verification_sha256, verification_ids: evidence.map((v) => v.id),
        termination_event_id: termination.id,
      })
    }
    assert.notEqual(checkpoint.native_runs[0].workspace_path, checkpoint.native_runs[1].workspace_path)
    check('both native missions complete once; unpinned identity retires only after obligations settle')
    await request(api(`/agents/${checkpoint.agent}/pin`), {
      actor_id: checkpoint.ids.alice_actor_id, pinned: true, expected_version: 4, idempotency_key: randomUUID(),
    }, 409)
    const before = obligationsDigest()
    await request(api(`/agents/${checkpoint.agent}/pin`), replayBody(originalPin))
    assert.equal(obligationsDigest(), before)
    assert.ok(agent(await snapshot()).retired_at)
    check('retired Pin rejected and old successful replay cannot resurrect history')
    const eve = await snapshot(checkpoint.ids.eve_actor_id)
    assert.equal(eve.snapshot.agents.length, 0)
    assert.equal(pinEvents(eve).length, 0)
    const bob = await snapshot(checkpoint.ids.bob_actor_id)
    assert.equal(pinEvents(bob).length, 4)
    assert.deepEqual(sourceIdentity(), checkpoint.source)
    checkpoint.final_counts = sql(`SELECT jsonb_build_object(
      'agents',(SELECT count(*) FROM agents), 'missions',(SELECT count(*) FROM missions),
      'tasks',(SELECT count(*) FROM tasks), 'runs',(SELECT count(*) FROM runs),
      'pin_events',(SELECT count(*) FROM events WHERE type IN ('agent.pinned','agent.unpinned')),
      'retirements',(SELECT count(*) FROM events WHERE type='agent.retired'),
      'completed_runs',(SELECT count(*) FROM runs WHERE status='completed'),
      'delivered_messages',(SELECT count(*) FROM queued_messages WHERE status='delivered'),
      'factory_items',(SELECT count(*) FROM factory_work_items),
      'pending_commands',(SELECT count(*) FROM runner_commands WHERE status='pending'))`)
    assert.equal(checkpoint.final_counts.pin_events, 4)
    assert.equal(checkpoint.final_counts.pending_commands, 0)
    assert.equal(checkpoint.final_counts.delivered_messages, 1)
    await writeFile(path.join(output, 'native-final-snapshot.json'), JSON.stringify(settled, null, 2))
    check('durable audit history, both viewers, tenant/room visibility and original source preserved')
    checkpoint.phase = 'complete'
    checkpoint.completed_at = new Date().toISOString()
  }
  await save()
  console.log(JSON.stringify({ phase: checkpoint.phase, agent: checkpoint.agent, checks: checkpoint.checks.length, output: checkpointPath }, null, 2))
} catch (error) {
  checkpoint.failure = { phase, message: String(error), at: new Date().toISOString() }
  await save()
  throw error
}
