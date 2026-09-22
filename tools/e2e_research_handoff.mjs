// DETERMINISTIC #297 / TF01 acceptance against a parent-owned native server and runner.
// CRONY_RESEARCH_HANDOFF_TEST=1 CRONY_SERVER_HTTP=http://127.0.0.1:18973
// CRONY_RESEARCH_HANDOFF_OUTPUT=<new-directory-with-existing-parent> node tools/e2e_research_handoff.mjs
//
// Prerequisites: an empty owned Corp, one connected fake-process runner, its selected immutable
// source, and the native research/readback fixture in scripts/fake-agent.mjs. No service setup here.
// Creates ONE held source-selected parallel-specialists mission, then launches its THREE tasks
// exactly once. The native planner supplies the contracts; this client never fabricates evidence.
// Downloads only through actor-authorized signed artifact APIs; never reads a runner worktree.
// Checkpoint every POST before effects and immediately retain response IDs. No reset, SQL, cleanup,
// repair, resume, or replacement tasks. Existing output directories (even failed ones) STOP.
// With --case browser-consumption --require-owned-qa, additionally require the operator's
// ECORP_ISSUE297_QA_CONTEXT and launch/download through the actual pinned App.
// No-argument mode retains API-only coverage. Neither mode proves vendor inference.
// Authority/negative/link cases belong to the separate Rust/SQLx lane, not skipped passes here.

import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, rename } from 'node:fs/promises'
import path from 'node:path'
import { loadResearchQa, openResearchBrowser, researchCase, researchDemo } from './research_handoff_browser.mjs'
import { runResearchAdversarial } from './research_handoff_adversarial.mjs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SHA = /^[0-9a-f]{64}$/
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const ACTIVE = new Set(['provisioning', 'starting', 'running', 'waiting_for_input',
  'waiting_for_approval', 'verifying'])
const TABLES = ['missions', 'tasks', 'runs', 'actors', 'agents', 'rooms', 'events',
  'source_deliverables', 'verification_evidence', 'factory_work_items']
const ROOT_KEYS = ['specialist-a', 'specialist-b']
const ARTIFACT_CHECK = { type: 'artifact', min_bytes: 1 }
const PROBE_COMMAND = "const fs=require('node:fs');for(const p of process.argv.slice(1)){const b=fs.readFileSync(p);const s=new TextDecoder('utf-8',{fatal:true}).decode(b);if(!b.length||b.length>6144)process.exit(1);if(p.endsWith('.json'))JSON.parse(s)}"
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const sorted = (items) => [...items].sort()
const ids = (items) => sorted(items.map((item) => item.id))
const pick = (item, keys) => Object.fromEntries(keys.map((key) => [key, item[key]]))
const canonical = (value) => JSON.stringify(value, (_, item) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
    : item)
const pathsFor = (key) => [`handoffs/${key}.md`, `handoffs/${key}-probe.json`]
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const utf8 = (bytes) => new TextDecoder('utf-8', { fatal: true }).decode(bytes)
const boundedMessage = (error) => String(error.message).slice(0, 2_000)
const counts = { get: 0, post: 0, snapshots: 0 }
let server
let output
let checkpointPath
let checkpoint
let ownsCheckpoint = false
let sequence = 0
let currentCheck = 'explicit fixture configuration'
let deadline
let lastState
let selectedCase
let ownedQa
let browser

async function durableWrite(file, value) {
  const handle = await open(file, 'wx', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function save() {
  checkpoint.updated_at = new Date().toISOString()
  checkpoint.requests = { ...counts }
  const pending = path.join(output, `.research-handoff-${checkpoint.nonce}-${++sequence}.pending`)
  await durableWrite(pending, checkpoint)
  await rename(pending, checkpointPath)
}

async function initialize() {
  selectedCase = researchCase(process.argv.slice(2))
  assert.equal(process.env.CRONY_RESEARCH_HANDOFF_TEST, '1', 'Requires CRONY_RESEARCH_HANDOFF_TEST=1')
  if (selectedCase) ownedQa = await loadResearchQa()
  assert.ok(process.env.CRONY_SERVER_HTTP, 'CRONY_SERVER_HTTP must be explicit')
  const endpoint = new URL(process.env.CRONY_SERVER_HTTP)
  assert.equal(endpoint.protocol, 'http:', 'Use the parent-owned loopback HTTP QA stack')
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname), 'Loopback only')
  assert.ok(endpoint.port && Number(endpoint.port) >= 10_000 &&
    !['8791', '8991'].includes(endpoint.port), 'Shared/default ports forbidden; use an owned high port')
  assert.ok(!endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash)
  assert.equal(endpoint.pathname, '/', 'CRONY_SERVER_HTTP must be an origin')
  assert.ok(process.env.CRONY_RESEARCH_HANDOFF_OUTPUT, 'CRONY_RESEARCH_HANDOFF_OUTPUT must be explicit')
  output = path.resolve(process.env.CRONY_RESEARCH_HANDOFF_OUTPUT)
  assert.notEqual(output, path.parse(output).root, 'Use a dedicated evidence directory')
  server = endpoint.origin
  checkpointPath = path.join(output, 'deterministic-research-handoff.json')
  // No recursive mkdir: an existing directory, including an ambiguous previous attempt, is fenced.
  // The parent supplies its existing evidence parent; this driver owns only the new leaf directory.
  await mkdir(output)
  checkpoint = {
    schema_version: 1,
    suite: 'deterministic-research-handoff-public-api',
    scenario: 'TF01',
    evidence_scope: 'Native API/server/runner/fake-process fixture; actual file readback, not summaries',
    browser_coverage: false,
    vendor_inference: false,
    negative_authority_link_coverage: 'Separate Rust/SQLx tests; not executed by this driver',
    phase: 'in_progress',
    server,
    nonce: randomUUID(),
    started_at: new Date().toISOString(),
    operations: [],
    source: null,
    mission_id: null,
    task_ids: [],
    run_ids: [],
    source_deliverable_ids: [],
    proof: {},
  }
  if (ownedQa) checkpoint.candidate_binding = {
    head: ownedQa.qa.head, files_sha256: ownedQa.qa.files_sha256,
    server_sha256: ownedQa.qa.server.sha256, runner_sha256: ownedQa.qa.runner.sha256,
    web_assets: ownedQa.qa.web.assets, case: selectedCase,
  }
  await durableWrite(checkpointPath, checkpoint)
  ownsCheckpoint = true
  deadline = Date.now() + 180_000
}

const api = (suffix) => `/api/corps/${checkpoint.corp_id}${suffix}`
function inventory(state) {
  return Object.fromEntries(TABLES.map((table) => [table, ids(state.snapshot[table])]))
}

async function http(route, method = 'GET', body) {
  const url = new URL(route, server)
  assert.equal(url.origin, server, 'Refusing an off-stack request')
  assert.ok(url.pathname.startsWith('/api/') || (ownedQa && method === 'GET' && url.pathname === '/health'),
    'Public API paths only')
  const remaining = deadline - Date.now()
  assert.ok(remaining > 0, 'Three-minute acceptance bound exhausted; preserve all IDs')
  const key = method === 'POST' ? 'post' : 'get'
  assert.ok(++counts[key] <= (key === 'post' ? 3 : 512), 'Bounded request count exceeded')
  return fetch(url, {
    method,
    headers: { 'content-type': 'application/json', accept: 'application/json, application/octet-stream' },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.timeout(Math.min(15_000, remaining)),
  })
}

async function boundedBody(response, limit) {
  const declared = Number(response.headers.get('content-length'))
  assert.ok(!Number.isFinite(declared) || declared <= limit, 'Response exceeds its byte bound')
  const reader = response.body?.getReader()
  assert.ok(reader, 'Response has no body')
  let length = 0
  const chunks = []
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      assert.ok(length <= limit, 'Response exceeds its byte bound')
      chunks.push(Buffer.from(value))
    }
  } finally {
    await reader.cancel()
  }
  return Buffer.concat(chunks)
}

async function jsonBody(response) {
  const bytes = await boundedBody(response, 8 * 1024 * 1024)
  try { return JSON.parse(utf8(bytes)) } catch {
    throw new Error('API returned invalid UTF-8/JSON; response text omitted')
  }
}

async function post(label, route, body, browserLaunch = false) {
  currentCheck = label
  assert.ok(route === '/api/demo/bootstrap?seed_crew=false' ||
    (checkpoint.corp_id && route === api('/missions')) ||
    (checkpoint.mission_id && route === api(`/missions/${checkpoint.mission_id}/launch`)),
  'Mutation route is outside this one-mission fixture')
  assert.ok(!checkpoint.operations.some((operation) => operation.route === route),
    'Never repeat a possibly accepted POST')
  if (ownedQa) await ownedQa.check()
  const operation = {
    operation_id: randomUUID(), label, route, request: body, state: 'pending',
    started_at: new Date().toISOString(),
    ids_before: lastState ? inventory(lastState) : {},
  }
  checkpoint.operations.push(operation)
  await save()
  const response = browserLaunch ? await browser.launch() : await http(route, 'POST', body)
  operation.http_status = response.status
  const parsed = browserLaunch ? response.body : await jsonBody(response)
  operation.response_ids = pick(parsed, ['corp_id', 'room_id', 'alice_actor_id',
    'mission_id', 'task_id', 'task_ids', 'run_id', 'run_ids'])
  operation.state = 'response_received'
  operation.received_at = new Date().toISOString()
  await save() // IDs survive validation failure; never issue a replacement request.
  assert.equal(response.status, 200, `${label}: unexpected HTTP ${response.status}`)
  return parsed
}

function sourceTuple(item) {
  // GitHub namespace casing is cosmetic; selected Git refs and commits stay exact.
  return { repository: item.source_repository?.toLowerCase(), base_ref: item.source_base_ref,
    base_commit: item.source_base_commit }
}

function fixtureRunner(state) {
  const connected = state.runners.filter((runner) => runner.connected)
  assert.equal(connected.length, 1, 'Requires exactly one connected parent-owned runner')
  const [runner] = connected
  assert.ok(runner.capabilities.some((cap) => cap.name === 'fake-process' && cap.available),
    'The connected native runner must advertise fake-process')
  assert.ok(runner.capabilities.some((cap) =>
    cap.name === 'verified-dependency-files-v1' && cap.available),
  'The connected native runner must advertise verified-dependency-files-v1')
  const workspaces = runner.capabilities.filter((cap) =>
    cap.name === 'workspace-isolation' && cap.available && cap.workspace_connection_id == null)
  assert.equal(workspaces.length, 1, 'Requires one unbound native source capability')
  const source = sourceTuple(workspaces[0])
  assert.match(source.repository, /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i)
  assert.ok(typeof source.base_ref === 'string' && source.base_ref.length > 0)
  assert.match(source.base_commit, COMMIT)
  if (ownedQa) {
    assert.equal(runner.id, ownedQa.qa.runner.id, 'Runner differs from operator-owned process binding')
    assert.deepEqual(source, ownedQa.qa.source, 'Runner source differs from operator-qualified candidate')
  }
  if (checkpoint.runner_id) {
    assert.equal(runner.id, checkpoint.runner_id, 'Owned runner identity changed')
    assert.deepEqual(source, checkpoint.source, 'Selected runner source changed')
  }
  return { runner, source }
}

function missionView(state) {
  const mission = state.snapshot.missions.find((item) => item.id === checkpoint.mission_id)
  assert.ok(mission, 'Checkpointed mission is missing; do not recreate')
  const tasks = state.snapshot.tasks.filter((task) => task.mission_id === mission.id)
    .sort((a, b) => a.plan_key.localeCompare(b.plan_key))
  const taskIds = new Set(ids(tasks))
  const runs = state.snapshot.runs.filter((run) => taskIds.has(run.task_id))
  return { mission, tasks, runs }
}

function authority(view) {
  return hash(canonical({
    mission: pick(view.mission, ['id', 'corp_id', 'room_id', 'requested_by', 'title', 'description',
      'strategy', 'max_nodes', 'max_depth', 'budget_tokens', 'budget_cost_microusd']),
    tasks: view.tasks.map((task) => pick(task, ['id', 'corp_id', 'mission_id', 'plan_key',
      'assigned_agent_id', 'required_adapter', 'depends_on', 'depth', 'max_attempts',
      'contract_version', 'contract', 'verification_policy'])),
  }))
}

async function snapshot() {
  const response = await http(api(`/snapshot?actor_id=${checkpoint.actor_id}`))
  assert.equal(response.status, 200, 'Authorized snapshot failed')
  const state = await jsonBody(response)
  for (const table of TABLES) {
    assert.ok(Array.isArray(state.snapshot?.[table]), `Snapshot omitted required ${table}`)
    assert.ok(state.snapshot[table].length < 500, `Use a fresh owned Corp, not truncated ${table}`)
  }
  assert.ok(Array.isArray(state.runners), 'Snapshot omitted runners')
  lastState = state
  counts.snapshots++
  // Persist observed IDs before any assertion can fail, including unexpected/partial execution.
  checkpoint.last_inventory = inventory(state)
  checkpoint.run_ids = ids(state.snapshot.runs)
  checkpoint.source_deliverable_ids = ids(state.snapshot.source_deliverables)
  checkpoint.last_runs = state.snapshot.runs.map((run) => pick(run, ['id', 'task_id', 'agent_id',
    'runner_id', 'status', 'verification_status', 'workspace_run_id', 'workspace_path',
    'workspace_branch', 'workspace_disposition', 'source_repository', 'source_base_ref',
    'source_base_commit', 'artifact_id', 'artifact_sha256']))
  await save()
  fixtureRunner(state)
  if (checkpoint.mission_id) {
    assert.deepEqual(ids(state.snapshot.missions), [checkpoint.mission_id], 'Unexpected mission history')
    assert.deepEqual(ids(state.snapshot.tasks), sorted(checkpoint.task_ids), 'Tasks changed or replaced')
    assert.ok(state.snapshot.runs.every((run) => checkpoint.task_ids.includes(run.task_id)),
      'Foreign run entered the owned Corp')
    assert.equal(state.snapshot.factory_work_items.length, 0, 'Unexpected Factory history')
    const view = missionView(state)
    if (checkpoint.authority_sha256) assert.equal(authority(view), checkpoint.authority_sha256,
      'Persisted task/source/verifier/attempt authority changed')
    for (const task of view.tasks) {
      assert.ok(task.attempt_count <= 1, 'No retry or replacement attempt is authorized')
      assert.ok(view.runs.filter((run) => run.task_id === task.id).length <= 1,
        'Each task must have exactly one lineage, never a replacement')
    }
  }
  return state
}

function checkHeld(state) {
  const view = missionView(state)
  assert.equal(view.mission.status, 'ready', 'Mission was not held until explicit launch')
  assert.equal(view.mission.strategy, 'parallel-specialists')
  assert.equal(view.mission.corp_id, checkpoint.corp_id)
  assert.equal(view.mission.room_id, checkpoint.room_id)
  assert.equal(view.mission.requested_by, checkpoint.actor_id)
  assert.equal(view.mission.max_nodes, 3)
  assert.equal(view.mission.max_depth, 1)
  assert.equal(view.runs.length, 0, 'Held mission unexpectedly acquired a run')
  assert.deepEqual(sorted(view.tasks.map((task) => task.plan_key)), [...ROOT_KEYS, 'synthesis'])
  for (const task of view.tasks) {
    assert.equal(task.corp_id, checkpoint.corp_id)
    assert.equal(task.required_adapter, 'fake-process')
    assert.equal(task.max_attempts, 1, 'Native optional max_task_attempts=1 must be persisted')
    assert.equal(task.attempt_count, 0)
    assert.deepEqual(sourceTuple(task.contract), checkpoint.source, 'Task lost its selected source')
    assert.ok(task.contract.objective && task.contract.expected_output)
    assert.ok(task.contract.acceptance_tests.length > 0)
    assert.equal(task.verification_policy.manual_gate, null, 'No fixture approval bypass is permitted')
    const agent = state.snapshot.agents.find((item) => item.id === task.assigned_agent_id)
    assert.equal(agent?.mission_id, view.mission.id, 'Must use native mission-owned staffing')
    assert.equal(agent.adapter, 'fake-process')
    assert.equal(agent.pinned, false)
    if (ROOT_KEYS.includes(task.plan_key)) {
      const paths = pathsFor(task.plan_key)
      assert.equal(task.depth, 0)
      assert.equal(task.status, 'ready')
      assert.deepEqual(task.depends_on, [])
      assert.equal(task.contract.expected_output, `Verified research files: ${paths.join(', ')}`)
      assert.deepEqual(task.contract.write_scope, paths, 'Root write scope must contain exactly two files')
      assert.deepEqual(task.contract.deliverable, {
        form: 'typed_artifact_set', commit_after_verification: false, paths,
      }, 'Root must declare a bounded typed source handoff, not generic final evidence')
      assert.deepEqual(task.verification_policy.checks, [
        ARTIFACT_CHECK, ...paths.map((file) => ({ type: 'file', path: file, min_bytes: 1 })),
        { type: 'command', program: 'node', args: ['-e', PROBE_COMMAND, ...paths], timeout_ms: 5_000 },
      ], 'Native root policy must check provider artifact, both files, UTF-8/JSON and byte bounds')
    } else {
      assert.equal(task.depth, 1)
      assert.equal(task.status, 'pending')
      assert.deepEqual(sorted(task.depends_on), ids(view.tasks.filter((item) => item.depth === 0)))
      assert.deepEqual(task.contract.references, ROOT_KEYS.map((key) => `task:${key}`))
      assert.deepEqual(task.verification_policy.checks, [ARTIFACT_CHECK])
    }
  }
  assert.equal(new Set(view.tasks.map((task) => task.assigned_agent_id)).size, 3)
  return view
}

async function waitForMission() {
  let maxActiveRuns = 0
  while (Date.now() < deadline) {
    const state = await snapshot()
    const view = missionView(state)
    maxActiveRuns = Math.max(maxActiveRuns, view.runs.filter((run) => ACTIVE.has(run.status)).length)
    checkpoint.proof.max_active_runs = maxActiveRuns
    assert.ok(!['failed', 'cancelled'].includes(view.mission.status),
      'Mission failed; preserve the original history, never retry')
    assert.ok(view.runs.every((run) => !['failed', 'cancelled', 'lost'].includes(run.status)),
      'A native run failed; no replacement task or fallback is permitted')
    assert.ok(view.runs.every((run) => !['waiting_for_input', 'waiting_for_approval'].includes(run.status)),
      'Unexpected fixture input/approval; do not bypass native authority')
    if (view.mission.status === 'completed' && view.runs.length === 3 &&
      view.runs.every((run) => run.status === 'completed' &&
        ['preserved', 'removed'].includes(run.workspace_disposition))) {
      assert.ok(maxActiveRuns >= 2, 'Parallel roots were never observed in flight together')
      return { state, ...view }
    }
    await pause(200)
  }
  throw new Error('Timed out waiting for original native runs and settled worktrees')
}

function oneEvent(state, run, type) {
  const events = state.snapshot.events.filter((event) =>
    event.aggregate_id === run.id && event.type === type)
  assert.equal(events.length, 1, `Expected exactly one ${type} for ${run.id}`)
  const [event] = events
  assert.equal(event.corp_id, checkpoint.corp_id)
  assert.equal(event.room_id, checkpoint.room_id)
  assert.ok(Number.isSafeInteger(event.seq) && event.seq > 0)
  return event
}

function checkRun(state, task, run) {
  assert.ok(run, `Missing original run for ${task.plan_key}`)
  assert.match(run.id, UUID)
  assert.equal(run.workspace_run_id, run.id, 'Fresh execution must own its own workspace lineage')
  assert.equal(run.resumed_from_run_id, null)
  assert.equal(run.corp_id, checkpoint.corp_id)
  assert.equal(run.agent_id, task.assigned_agent_id)
  assert.equal(run.runner_id, checkpoint.runner_id)
  assert.equal(run.status, 'completed')
  assert.equal(run.verification_status, 'passed')
  assert.equal(task.status, 'completed')
  assert.equal(task.verification_status, 'passed')
  assert.equal(task.attempt_count, 1)
  assert.deepEqual(sourceTuple(run), checkpoint.source)
  assert.equal(run.workspace_base_ref, checkpoint.source.base_ref)
  assert.equal(run.workspace_base_commit, checkpoint.source.base_commit)
  assert.ok(typeof run.workspace_path === 'string' && run.workspace_path.length > 0)
  assert.ok(typeof run.workspace_branch === 'string' && run.workspace_branch.length > 0)
  assert.equal(run.workspace_disposition, 'preserved', 'Dirty fixture worktrees must remain retained')
  assert.equal(Object.hasOwn(run, 'artifact_path'), false, 'Runner-local artifact path leaked')
  const evidence = state.snapshot.verification_evidence.filter((item) => item.run_id === run.id)
    .sort((a, b) => a.check_index - b.check_index)
  assert.equal(evidence.length, task.verification_policy.checks.length)
  for (const [index, item] of evidence.entries()) {
    assert.equal(item.corp_id, checkpoint.corp_id)
    assert.equal(item.task_id, task.id)
    assert.equal(item.check_index, index)
    assert.equal(item.kind, task.verification_policy.checks[index].type)
    assert.equal(item.status, 'passed', 'Every persisted native check must pass')
    if (item.kind === 'command') {
      assert.equal(item.payload.program, 'node')
      assert.deepEqual(item.payload.args, task.verification_policy.checks[index].args)
      assert.equal(item.payload.exit_code, 0, 'Probe verifier did not execute successfully')
    }
  }
  const requested = oneEvent(state, run, 'run.requested')
  const started = oneEvent(state, run, 'run.started')
  const verified = oneEvent(state, run, 'run.verification_passed')
  const completed = oneEvent(state, run, 'run.completed')
  assert.equal(requested.payload.task_id, task.id)
  assert.equal(requested.payload.runner_id, checkpoint.runner_id)
  assert.equal(requested.payload.attempt, 1)
  assert.equal(requested.payload.max_attempts, 1)
  assert.equal(started.payload.adapter, 'fake-process')
  assert.equal(started.payload.workspace_base_commit, checkpoint.source.base_commit)
  assert.ok(requested.seq < started.seq && started.seq < verified.seq && verified.seq < completed.seq)
  return { requested, started, verified, completed, evidence }
}

async function signedDownload(record, role) {
  // Same provenance/digest checks as artifact_client.mjs, with this owned-fixture's redirect,
  // origin, request-time and streaming byte bounds. No runner-local path is ever dereferenced.
  const source = role === 'source_deliverable'
  const artifactId = record.artifact_id
  const uri = source ? record.uri : record.artifact_uri
  const sha256 = source ? record.sha256 : record.artifact_sha256
  const mediaType = source ? record.media_type : record.artifact_media_type
  const signature = source ? record.provenance_signature : record.artifact_signature
  assert.match(artifactId, UUID)
  assert.match(sha256, SHA)
  assert.ok(typeof mediaType === 'string' && mediaType.length > 0)
  assert.ok(typeof signature === 'string' && signature.length > 0)
  assert.equal(uri, api(`/artifacts/${artifactId}`), 'Artifact URI must use the native Corp-scoped API')
  const response = await http(`${uri}?actor_id=${checkpoint.actor_id}`)
  assert.equal(response.status, 200, 'Authorized signed artifact download failed')
  assert.equal(response.headers.get('content-type'), mediaType)
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(response.headers.get('x-crony-artifact-role'), role)
  assert.equal(response.headers.get('x-crony-artifact-signature'), signature)
  assert.match(response.headers.get('content-disposition') ?? '', /^attachment;/)
  const bytes = await boundedBody(response, source ? 256 * 1024 : 512 * 1024)
  assert.ok(bytes.length > 0)
  assert.equal(hash(bytes), sha256)
  if (source) assert.equal(bytes.length, record.bytes)
  return bytes
}

function decodeBase64(value) {
  assert.equal(typeof value, 'string')
  const bytes = Buffer.from(value, 'base64')
  assert.equal(bytes.toString('base64'), value, 'Artifact contained noncanonical base64')
  return bytes
}

async function checkParent(state, task, run, native) {
  const sources = state.snapshot.source_deliverables.filter((item) => item.run_id === run.id)
  assert.equal(sources.length, 1, 'Every root must retain one exact native source deliverable')
  const [source] = sources
  assert.match(source.id, UUID)
  assert.equal(source.corp_id, checkpoint.corp_id)
  assert.equal(source.task_id, task.id)
  assert.equal(source.form, 'typed_artifact_set')
  assert.equal(source.file_name, 'ecorp-artifact-set.json')
  assert.equal(source.media_type, 'application/vnd.ecorp.deliverable+json')
  assert.equal(source.base_commit, checkpoint.source.base_commit)
  assert.equal(source.head_commit, null, 'Research roots must not commit')
  assert.equal(source.branch, run.workspace_branch)
  assert.equal(source.integration_state, 'ready_for_review')
  assert.ok(Date.parse(source.retention_until) > Date.now(), 'Source retention expired')
  assert.match(source.verification_sha256, SHA)
  assert.equal(source.verification_sha256, run.verification_sha256)
  assert.equal(source.sha256, run.deliverable_sha256)
  assert.notEqual(source.artifact_id, run.artifact_id, 'Provider evidence is not the source handoff')
  const bytes = await signedDownload(source, 'source_deliverable')
  const document = JSON.parse(utf8(bytes))
  assert.equal(document.schema_version, 1)
  assert.equal(document.form, source.form)
  assert.equal(document.base_commit, source.base_commit)
  assert.equal(document.head_commit, null)
  assert.equal(document.branch, source.branch)
  assert.equal(document.verification_sha256, source.verification_sha256)
  assert.equal(document.git_bundle_base64, null)
  assert.equal(document.git_bundle_sha256, null)
  assert.equal(hash(decodeBase64(document.patch_base64)), document.patch_sha256)
  assert.ok(Array.isArray(document.changes))
  const expectedPaths = pathsFor(task.plan_key)
  assert.deepEqual(sorted(document.changes.map((change) => change.path)), sorted(expectedPaths),
    'The source archive must contain exactly the two contracted files')
  const files = document.changes.map((change) => {
    assert.ok(['A', 'M'].includes(change.status), 'Only regular created/modified research files')
    assert.ok(['100644', '100755'].includes(change.mode), 'Handoff must be a regular file')
    const content = decodeBase64(change.content_base64)
    assert.ok(content.length > 0 && content.length <= 6_144, 'Research file exceeded native bounds')
    assert.equal(change.bytes, content.length)
    assert.equal(change.sha256, hash(content))
    const evidence = native.evidence.find((item) =>
      item.kind === 'file' && item.payload.path === change.path)
    assert.ok(evidence, 'Source file omitted its native passing file check')
    assert.equal(evidence.payload.sha256, change.sha256)
    assert.equal(evidence.payload.bytes, content.length)
    return { path: change.path, sha256: hash(content), bytes: content.length, content, text: utf8(content) }
  })
  const note = files.find((file) => file.path === expectedPaths[0])
  const probe = files.find((file) => file.path === expectedPaths[1])
  assert.ok(note.text.includes(`Run: ${run.id}\n`), 'Fixture note lost producing run attribution')
  const nonce = /^Nonce: ([0-9a-f-]+)$/m.exec(note.text)?.[1]
  assert.match(nonce, UUID, 'Fixture must generate a fresh, unpredictable note nonce')
  assert.ok(note.text.includes('Exact bytes: λ\n'), 'Fixture must preserve exact UTF-8 and LF bytes')
  assert.ok(!String(run.summary).includes(nonce), 'A summary must not substitute for note consumption')
  assert.deepEqual(JSON.parse(probe.text), {
    observed: true, run_id: run.id, note_sha256: note.sha256,
  }, 'Probe must bind actual produced note bytes, not proposed checks')
  const deliverableEvent = oneEvent(state, run, 'run.deliverable')
  assert.equal(deliverableEvent.payload.artifact_role, 'source_deliverable')
  assert.ok(deliverableEvent.seq < native.verified.seq &&
    native.verified.seq < native.completed.seq, 'Durable source must precede accepted completion')
  assert.equal(native.verified.payload.verification_sha256, source.verification_sha256)
  assert.equal(native.verified.payload.deliverable_sha256, source.sha256)
  const proof = {
    task_id: task.id, run_id: run.id, plan_key: task.plan_key, source,
    fixture_nonce: nonce,
    files: files.map((file) => pick(file, ['path', 'sha256', 'bytes', 'text'])),
    native_checks: native.evidence,
    events: [native.requested, native.started, deliverableEvent, native.verified, native.completed],
  }
  checkpoint.proof.parents ??= []
  checkpoint.proof.parents.push(proof)
  await save()
  return { source, files, native, task, run, nonce }
}

async function verifyOutcome(result) {
  const { state, mission, tasks, runs } = result
  assert.equal(mission.status, 'completed')
  assert.equal(runs.length, 3)
  assert.equal(new Set(runs.map((run) => run.id)).size, 3)
  assert.equal(new Set(runs.map((run) => run.workspace_run_id)).size, 3)
  assert.equal(new Set(runs.map((run) => run.workspace_branch)).size, 3)
  const workspaceKey = (value) => checkpoint.runner_os === 'windows'
    ? value.replaceAll('\\', '/').toLowerCase() : value
  assert.equal(new Set(runs.map((run) => workspaceKey(run.workspace_path))).size, 3,
    'Roots and synthesis must execute in three distinct worktrees')
  assert.ok(state.snapshot.source_deliverables.every((source) =>
    checkpoint.task_ids.includes(source.task_id)), 'Foreign source deliverable entered the owned Corp')
  const parents = []
  let synthesis
  for (const task of tasks) {
    const run = runs.find((item) => item.task_id === task.id)
    const native = checkRun(state, task, run)
    if (ROOT_KEYS.includes(task.plan_key)) {
      assert.ok(checkpoint.initial_run_ids.includes(run.id))
      assert.equal(native.requested.actor_id, checkpoint.actor_id)
      parents.push(await checkParent(state, task, run, native))
    } else {
      synthesis = { task, run, native }
    }
  }
  assert.equal(parents.length, 2)
  assert.ok(synthesis)
  // The first dispatched root changes the durable mission from ready to running.
  // Later roots in the same launch therefore carry mission_launch: false.
  const launchEvents = parents.map((parent) => parent.native.requested)
    .sort((a, b) => a.seq - b.seq)
  assert.deepEqual(launchEvents.map((event) => event.payload.mission_launch), [true, false],
    'Exactly the first root must record the initial mission transition')
  assert.equal(synthesis.native.requested.payload.mission_launch, false,
    'Dependency release must not record another initial mission transition')
  assert.notEqual(parents[0].nonce, parents[1].nonce)
  assert.equal(new Set(parents.map((parent) => parent.source.artifact_id)).size, 2)
  assert.equal(new Set(parents.map((parent) => parent.source.sha256)).size, 2)
  assert.deepEqual(sorted(checkpoint.initial_run_ids), ids(parents.map((parent) => parent.run)))
  assert.ok(Math.max(...parents.map((parent) => parent.native.started.seq)) <
    Math.min(...parents.map((parent) => parent.native.completed.seq)),
  'Native event order must demonstrate overlapping root executions')
  assert.ok(synthesis.native.requested.seq >
    Math.max(...parents.map((parent) => parent.native.completed.seq)),
  'Synthesis was requested before both roots had accepted completion')
  const context = oneEvent(state, synthesis.run, 'run.dependency_context')
  assert.ok(synthesis.native.requested.seq < context.seq &&
    context.seq < synthesis.native.started.seq, 'Dependency context must precede child startup')
  assert.match(context.payload.context_sha256, SHA)
  assert.ok(Array.isArray(context.payload.handoffs))
  assert.equal(context.payload.handoffs.length, 2)
  const byTask = (a, b) => a.task_id.localeCompare(b.task_id)
  const metadata = (file) => pick(file, ['path', 'sha256', 'bytes'])
  const expectedHandoffs = parents.map((parent) => ({
    task_id: parent.task.id, run_id: parent.run.id, verification_run_id: parent.run.id,
    artifact_id: parent.source.artifact_id, sha256: parent.source.sha256,
    artifact_role: 'source_deliverable', files: parent.files.map(metadata),
  }))
  const normalizeHandoffs = (handoffs) => handoffs.map((handoff) => ({
    ...handoff, files: [...handoff.files].sort((a, b) => a.path.localeCompare(b.path)),
  })).sort(byTask)
  assert.deepEqual(normalizeHandoffs(context.payload.handoffs), normalizeHandoffs(expectedHandoffs),
    'Event dependency metadata must bind parent source IDs and exact verified file bytes')
  currentCheck = 'TF01 signed child artifact and actual workspace file readback'
  const artifact = await signedDownload(synthesis.run, 'provider_evidence')
  const text = utf8(artifact)
  assert.match(text, /VERIFIED DEPENDENCY OUTPUTS:/)
  const matches = [...text.matchAll(/^DEPENDENCY READBACK: (.+)$/gm)]
  assert.equal(matches.length, 1, 'Native fake-process must report actual readFile consumption')
  const readback = JSON.parse(matches[0][1])
  assert.ok(Array.isArray(readback))
  const expected = parents.flatMap((parent) => parent.files.map(metadata))
  assert.equal(readback.length, 4, 'Synthesis must actually read both notes AND both probes')
  assert.equal(new Set(readback.map((file) => file.path)).size, 4)
  assert.deepEqual([...readback].sort((a, b) => a.path.localeCompare(b.path)),
    expected.sort((a, b) => a.path.localeCompare(b.path)),
    'TF01 requires byte-for-byte digest/readback equality, not summaries or file names')
  for (const parent of parents) {
    assert.ok(text.includes(parent.run.id))
    assert.ok(text.includes(parent.source.artifact_id))
    for (const file of parent.files) {
      assert.ok(text.includes(`SOURCE FILE ${file.path} / sha256 ${file.sha256} / bytes ${file.bytes}\n`))
      assert.ok(text.includes(file.text), 'Child artifact lost the exact UTF-8 source context')
    }
  }
  checkpoint.proof.synthesis = {
    task_id: synthesis.task.id, run_id: synthesis.run.id,
    artifact_id: synthesis.run.artifact_id, artifact_sha256: hash(artifact), artifact_bytes: artifact.length,
    artifact_signature: synthesis.run.artifact_signature,
    artifact_text: text,
    readback,
    native_checks: synthesis.native.evidence,
    events: [synthesis.native.requested, context, synthesis.native.started,
      synthesis.native.verified, synthesis.native.completed],
  }
  checkpoint.proof.tf01_actual_content_consumption = true
  checkpoint.proof.three_distinct_worktrees = true
  checkpoint.proof.parents_completed_before_synthesis_request = true
  checkpoint.proof.signed_authorized_source_downloads = true
  await save()
}

try {
  if (researchCase(process.argv.slice(2)) === 'adversarial') {
    await runResearchAdversarial()
    throw new Error('Adversarial executor returned without accepted complete coverage')
  }
  await initialize()
  if (ownedQa) {
    const response = await http('/health')
    assert.equal(response.status, 200)
    const health = await jsonBody(response)
    assert.ok(health.status === 'ok' && health.mode === 'development', 'Requires a healthy owned development server')
  }
  const demo = ownedQa ? researchDemo
    : await post('native bootstrap without crew or reset', '/api/demo/bootstrap?seed_crew=false', {})
  for (const key of ['corp_id', 'room_id', 'alice_actor_id']) assert.match(demo[key], UUID)
  Object.assign(checkpoint, { corp_id: demo.corp_id, room_id: demo.room_id, actor_id: demo.alice_actor_id })
  await save()
  currentCheck = 'fresh native fixture and selected source admission'
  const initial = await snapshot()
  for (const table of ['missions', 'tasks', 'runs', 'source_deliverables',
    'verification_evidence', 'factory_work_items']) {
    assert.equal(initial.snapshot[table].length, 0, `Existing ${table}; inspect prior IDs, never reset`)
  }
  assert.ok(!initial.snapshot.events.some((event) => /^(mission|task|run)\./.test(event.type)),
    'Existing mission/task/run event history; do not overwrite an earlier attempt')
  assert.ok(initial.snapshot.rooms.some((room) => room.id === demo.room_id))
  assert.ok(initial.snapshot.actors.some((actor) =>
    actor.id === demo.alice_actor_id && actor.kind === 'human'))
  assert.ok(initial.snapshot.agents.every((agent) => !agent.pinned),
    'Requires no reusable pinned crew; use the parent-owned fresh fixture')
  const { runner, source } = fixtureRunner(initial)
  Object.assign(checkpoint, { runner_id: runner.id, runner_os: runner.os, source,
    baseline_ids: inventory(initial) })
  await save()
  const created = await post('create one held native research handoff mission', api('/missions'), {
    requested_by: checkpoint.actor_id,
    preferred_adapter: 'fake-process',
    strategy: 'parallel-specialists',
    // CreateMissionRequest declares this optional field. Require the new native protocol: do not
    // fall back to omission/legacy retry defaults if it is rejected or ignored.
    max_task_attempts: 1,
    source: checkpoint.source,
    title: `[graph-slow] [deterministic-research-handoff] ${checkpoint.nonce}`,
    description: 'TF01 deterministic native fixture: synthesize the actual verified research note and JSON probe bytes from both roots. No browser, vendor, publication or final implementation claim.',
    secret_refs: [],
    budget_tokens: 280_000,
    budget_cost_microusd: 3_000_000,
  })
  assert.match(created.mission_id, UUID)
  checkpoint.mission_id = created.mission_id
  checkpoint.task_ids = created.task_ids
  await save()
  assert.equal(created.strategy, 'parallel-specialists')
  assert.ok(Array.isArray(created.task_ids) && created.task_ids.length === 3)
  for (const id of created.task_ids) assert.match(id, UUID)
  assert.equal(new Set(created.task_ids).size, 3)
  currentCheck = 'native root contracts and held launch barrier'
  const held = checkHeld(await snapshot())
  checkpoint.authority_sha256 = authority(held)
  checkpoint.planned_tasks = held.tasks
  await save()
  const heldUntil = Date.now() + 2_000
  do {
    await pause(250)
    checkHeld(await snapshot())
  } while (Date.now() < heldUntil)
  checkpoint.proof.held_without_runs = true
  if (ownedQa) {
    currentCheck = 'owned pinned App admission before browser launch'
    browser = await openResearchBrowser(ownedQa.qa, {
      corpId: checkpoint.corp_id, actorId: checkpoint.actor_id, missionId: checkpoint.mission_id,
      title: held.mission.title, output,
    })
    checkpoint.proof.browser = browser.proof
    await save()
  }
  const launched = await post('explicit native launch; no retry',
    api(`/missions/${checkpoint.mission_id}/launch`), { requested_by: checkpoint.actor_id }, Boolean(browser))
  checkpoint.initial_run_ids = launched.run_ids
  await save()
  assert.ok(Array.isArray(launched.run_ids) && launched.run_ids.length === 2,
    'Launch must dispatch exactly the two ready roots')
  for (const id of launched.run_ids) assert.match(id, UUID)
  assert.equal(new Set(launched.run_ids).size, 2)
  currentCheck = 'native parallel roots, dependency release and verification'
  await verifyOutcome(await waitForMission())
  if (browser) {
    currentCheck = 'actual App download of verified synthesis readback'
    await browser.verify(checkpoint.proof.synthesis)
    await ownedQa.check()
    await browser.close()
    assert.equal(browser.proof.assertions.length, 3, 'Browser case requires all three actual assertions')
    assert.equal(browser.proof.closed, true, 'Owned browser must close before success')
    checkpoint.browser_coverage = true
  }
  checkpoint.phase = 'passed'
  checkpoint.finished_at = new Date().toISOString()
  await save()
  console.log(JSON.stringify({
    phase: 'passed', scenario: 'TF01',
    evidence: browser ? 'native deterministic handoff with actual App launch/download; not vendor or complete TF01 acceptance'
      : 'native deterministic fixture, not browser/vendor proof',
    checkpoint: checkpointPath, mission_id: checkpoint.mission_id,
    runner_id: checkpoint.runner_id, source: checkpoint.source, run_ids: checkpoint.run_ids,
    source_deliverable_ids: checkpoint.source_deliverable_ids,
    actual_content_consumption: true, readback_files: 4,
  }))
} catch (error) {
  if (ownsCheckpoint) {
    checkpoint.phase = 'failed'
    checkpoint.failure = { check: currentCheck, message: boundedMessage(error),
      recorded_at: new Date().toISOString(), automatic_retry_allowed: false }
    try { await save() } catch {
      console.error('Could not update failure checkpoint; preserve its existing file and .pending records.')
    }
  }
  console.error(JSON.stringify({
    phase: 'failed', checkpoint: checkpointPath ?? null, check: currentCheck,
    error: boundedMessage(error),
    next_action: 'Parent inspects retained IDs/evidence; no resets, cleanup or automatic reruns.',
  }))
  process.exitCode = 1
} finally {
  if (browser && !browser.proof.closed) {
    try {
      await browser.close()
      await save()
    } catch {
      console.error('Owned browser cleanup/checkpoint failed; preserve evidence for operator inspection.')
      process.exitCode = 1
    }
  }
}
