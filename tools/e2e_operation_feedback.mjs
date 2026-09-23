// Owned-stack acceptance only. No reset, server/runner restart, provider inference,
// GitHub request, publication or automatic retry. Importing this file is inert.
import assert from 'node:assert/strict'
import { execFile as execFileCallback } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { captureOwnedTestServerManifest, parseOwnedTestServerManifest } from './owned_test_stack.mjs'
import { exportOperationEvidence, exportOperationReceipt } from './operation_receipt.mjs'
import { feedbackDigest, validateFeedbackCorpus } from '../scenarios/repo-steward/lib/feedback.mjs'

const execFile = promisify(execFileCallback)
const SELF = fileURLToPath(import.meta.url), ROOT = path.resolve(path.dirname(SELF), '..')
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u
const HASH = /^[a-f0-9]{64}$/u
const sha = value => createHash('sha256').update(value).digest('hex')
const jsonBytes = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`)
const same = (left, right) => assert.equal(feedbackDigest(left), feedbackDigest(right))
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const normalize = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value)

function plainFile(file, maximum = 1024 * 1024) {
  assert.ok(path.isAbsolute(file))
  const stat = lstatSync(file)
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size > 0 && stat.size <= maximum)
  const bytes = readFileSync(file)
  assert.equal(bytes.length, stat.size)
  return bytes
}
function ordinaryDirectory(directory) {
  assert.ok(path.isAbsolute(directory))
  for (let current = path.resolve(directory); ; current = path.dirname(current)) {
    const stat = lstatSync(current)
    assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), 'Redirected output/input directory refused')
    if (path.dirname(current) === current) break
  }
  assert.equal(normalize(realpathSync(directory)), normalize(directory))
}
function loopback(origin) {
  const url = new URL(origin)
  assert.equal(url.protocol, 'http:')
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
  assert.ok(url.port && !['8791', '8793', '8991', '5187', '5291', '15191', '15193'].includes(url.port))
  assert.ok(!url.username && !url.password && !url.search && !url.hash && url.pathname === '/')
  return url.origin
}

export function parseArgs(argv) {
  const args = {}
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]
    assert.ok(['--setup', '--inputs', '--output', '--proxy-fault'].includes(flag) && !Object.hasOwn(args, flag))
    if (flag === '--proxy-fault') { args[flag] = true; continue }
    const value = argv[++index]
    assert.ok(typeof value === 'string' && path.isAbsolute(value) && !/[\r\n\0]/u.test(value))
    args[flag] = path.resolve(value)
  }
  for (const flag of ['--setup', '--inputs', '--output']) assert.ok(args[flag], `Required: ${flag}`)
  return args
}

// These pure file verifiers are invoked only by the native persisted verifier.
// They do not contact ECorp or start the acceptance driver.
export function verifyFixtureFile(mode, file, expected) {
  assert.ok(['--verify-corpus', '--verify-guidance'].includes(mode))
  assert.ok(typeof file === 'string' && !path.isAbsolute(file) && !file.includes('..') && !/[\\/]/u.test(file))
  const content = plainFile(path.resolve(file))
  if (mode === '--verify-corpus') {
    assert.ok(HASH.test(expected)); assert.equal(sha(content), expected)
    validateFeedbackCorpus(JSON.parse(content))
  } else {
    assert.match(expected, /^FB-[a-f0-9]{64}$/u)
    const observed = JSON.parse(content)
    assert.equal(observed.schema_version, 1)
    assert.equal(observed.kind, 'ecorp-feedback-guidance-observation')
    assert.equal(observed.deterministic_fixture, true); assert.equal(observed.provider_inference, false)
    assert.ok(UUID.test(observed.run_id) && HASH.test(observed.prompt_sha256))
    assert.ok(Array.isArray(observed.references) && observed.references.length >= 2 && observed.references.length <= 64)
    assert.equal(new Set(observed.references).size, observed.references.length)
    assert.ok(observed.references.every(item => typeof item === 'string' && Buffer.byteLength(item) <= 1024))
    assert.deepEqual(observed.rule_ids, [expected])
    assert.equal(observed.references.filter(item => item.startsWith(`Advisory ${expected} (`)).length, 1)
  }
  return { status: 'passed', mode, sha256: sha(content), bytes: content.length }
}

function normalizeSetup(value) {
  const demo = value.demo ?? value
  const result = { ...value, actor_id: value.actor_id ?? demo.alice_actor_id, corp_id: value.corp_id ?? demo.corp_id,
    room_id: value.room_id ?? demo.room_id, denied_actor_id: value.denied_actor_id ?? demo.eve_actor_id }
  assert.equal(result.test_owned, true, 'Only an explicitly owned QA setup is accepted')
  assert.equal(result.deterministic_fixture, true); assert.equal(result.provider_inference, false); assert.equal(result.github_effects, false)
  for (const key of ['actor_id', 'corp_id', 'room_id']) assert.ok(UUID.test(result[key] ?? ''), `Missing setup ${key}`)
  for (const key of ['workspace', 'server_binary', 'server_pid_file', 'mcp_binary', 'source_directory']) assert.ok(path.isAbsolute(result[key] ?? ''), `Missing setup ${key}`)
  result.server_url = loopback(result.server_url)
  assert.match(result.source_commit, /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u)
  assert.ok(result.source_repository && result.source_ref && result.runner_id)
  return result
}
function scopedEnvironment(setup, server = setup.server_url) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|USERPROFILE|HOME|LOCALAPPDATA|APPDATA)$/iu.test(key)))
  return { ...env, CRONY_SERVER_HTTP: server, CRONY_CORP_ID: setup.corp_id, CRONY_ACTOR_ID: setup.actor_id,
    CRONY_MCP_BINARY: setup.mcp_binary, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }
}

export async function runAcceptance(argv) {
  const args = parseArgs(argv), output = args['--output'], inputRoot = args['--inputs']
  ordinaryDirectory(path.dirname(output)); ordinaryDirectory(inputRoot)
  assert.equal(existsSync(output), false, 'Choose a new attempt directory; all previous attempts remain preserved')
  mkdirSync(output, { mode: 0o700 })
  let sequence = 0, proxy
  const assertions = [], owned = [], started = new Date().toISOString()
  const saveBytes = (name, value) => { const file = path.join(output, name); writeFileSync(file, value, { flag: 'wx', mode: 0o600 }); return file }
  const save = (name, value) => saveBytes(name, jsonBytes(value))
  const check = (name, fn) => { fn(); assertions.push({ name, passed: true }) }
  const trace = (name, value) => save(`${String(++sequence).padStart(3, '0')}-${name}.json`, value)
  try {
    const setup = normalizeSetup(JSON.parse(plainFile(args['--setup'])))
    ordinaryDirectory(setup.workspace); ordinaryDirectory(setup.source_directory)
    const env = scopedEnvironment(setup)
    const source = { repository: setup.source_repository, base_ref: setup.source_ref, base_commit: setup.source_commit }
    const prefix = `/api/corps/${setup.corp_id}`
    const sourceFiles = ['tools/e2e_operation_feedback.mjs', 'tools/operation_feedback.mjs', 'tools/operation_receipt.mjs',
      'tools/consume_operation_receipt.mjs', 'tools/probe_mcp.mjs', 'tools/owned_test_stack.mjs', 'scenarios/repo-steward/lib/feedback.mjs']
    const pins = sourceFiles.map(file => ({ file, sha256: sha(plainFile(path.join(ROOT, file))) }))
    const seedBytes = plainFile(path.join(inputRoot, 'manifest.json')), seed = JSON.parse(seedBytes)
    assert.equal(setup.input_manifest_sha256, sha(seedBytes))
    assert.equal(normalize(inputRoot), normalize(setup.inputs_directory))
    const runtimePins = [...setup.binary_pins, ...Object.values(setup.script_pins)]
    for (const pin of runtimePins) assert.equal(sha(plainFile(pin.path, 256 * 1024 * 1024)), pin.sha256)
    const corpusFile = path.join(inputRoot, 'corpus.json'), reviewFile = path.join(inputRoot, 'review.md')
    const corpusBytes = plainFile(corpusFile), reviewBytes = plainFile(reviewFile), corpus = JSON.parse(corpusBytes)
    validateFeedbackCorpus(corpus)
    assert.equal(seed.kind, 'ecorp-operation-feedback-qa-seed'); assert.equal(seed.corpus.file, 'corpus.json')
    assert.equal(seed.corpus.sha256, sha(corpusBytes)); assert.equal(seed.corpus.bytes, corpusBytes.length)
    assert.equal(seed.source_commit, source.base_commit)
    assert.equal(seed.source_repository.toLowerCase(), source.repository.toLowerCase())
    const selected = corpus.records.filter(record => record.id === seed.record.id)
    assert.equal(selected.length, 1); assert.equal(selected[0].status, 'active')
    assert.equal(feedbackDigest(selected[0]), seed.record.digest)
    assert.equal(selected[0].review.evidence_sha256, sha(reviewBytes))
    assert.ok(Date.parse(selected[0].expires_at) > Date.now() + 600000, 'Seed needs ten minutes of prospective lifetime')
    const ownership = { root: setup.workspace, server: setup.server_url, binary: setup.server_binary }
    const manifestBytes = plainFile(setup.server_pid_file, 16384)
    const manifest = parseOwnedTestServerManifest(manifestBytes.toString('utf8'), ownership)
    const verifyOwner = async label => {
      assert.equal(sha(plainFile(setup.server_pid_file, 16384)), sha(manifestBytes), 'Owned server identity changed')
      const captured = await captureOwnedTestServerManifest({ ...ownership, pid: manifest.server, pidPath: path.join(output, `${label}-ownership.json`) })
      for (const key of ['server', 'server_creation', 'server_boot_id', 'server_start_ticks']) if (manifest[key] !== undefined) assert.equal(captured[key], manifest[key])
    }
    await verifyOwner('before')
    const git = async command => (await execFile('git', ['-C', setup.source_directory, ...command], { env, windowsHide: true, timeout: 15000 })).stdout.trim()
    assert.equal(await git(['rev-parse', 'HEAD']), source.base_commit)
    assert.equal(await git(['status', '--porcelain=v1']), '')
    save('invocation.json', { schema_version: 1, started_at: started, setup_sha256: sha(plainFile(args['--setup'])), source,
      seed_sha256: sha(seedBytes), corpus_sha256: sha(corpusBytes), review_sha256: sha(reviewBytes), files: pins,
      api_origin: setup.server_url, runner_id: setup.runner_id, runtime_pins: runtimePins,
      node: { path: process.execPath, version: process.version, sha256: sha(plainFile(process.execPath, 256 * 1024 * 1024)) }, proxy_fault_requested: Boolean(args['--proxy-fault']),
      scope: 'Actual owned development server/runner and deterministic fake-process; synthetic corpus/review; no model inference or remote GitHub effects.' })

    async function request(route, body, expected = [200], origin = setup.server_url) {
      const url = new URL(route, origin)
      assert.equal(url.origin, origin); assert.ok(url.pathname.startsWith(`${prefix}/`) || url.pathname === '/health')
      if (body !== undefined) trace('request-intent', { method: 'POST', route, request: body, automatic_retry: false })
      const response = await fetch(url, { method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: body === undefined ? {} : { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
      assert.ok(expected.includes(response.status), `Unexpected native HTTP status ${response.status}; raw error body withheld`)
      if (!response.ok) { await response.body?.cancel(); trace('native-refusal', { route, status: response.status }); return { status: response.status } }
      const chunks = []; let length = 0
      for await (const chunk of response.body) { length += chunk.length; assert.ok(length <= 16 * 1024 * 1024); chunks.push(chunk) }
      const value = JSON.parse(Buffer.concat(chunks))
      if (body !== undefined) trace('request-result', { route, status: response.status, result: value })
      return value
    }
    const snapshot = () => request(`${prefix}/snapshot?actor_id=${setup.actor_id}`)
    function view(payload, missionId) {
      const state = payload.snapshot, missions = state.missions.filter(item => item.id === missionId)
      assert.equal(missions.length, 1)
      const tasks = state.tasks.filter(item => item.mission_id === missionId)
      assert.equal(tasks.length, 1)
      return { mission: missions[0], task: tasks[0], runs: state.runs.filter(item => item.task_id === tasks[0].id),
        revisions: state.mission_contract_revisions.filter(item => item.mission_id === missionId),
        revision_events: state.events.filter(item => item.type === 'mission.contract_revised' && item.correlation_id === missionId) }
    }
    function unrun(current) {
      assert.equal(current.mission.status, 'ready'); assert.equal(current.mission.room_id, setup.room_id)
      assert.equal(current.runs.length, 0); assert.equal(current.task.attempt_count, 0)
      assert.equal(current.task.required_adapter, 'fake-process')
    }
    function unchangedReferencesOnly(before, after, proposal) {
      unrun(after)
      const wanted = structuredClone(before)
      wanted.mission.specification_version = before.mission.specification_version + 1
      wanted.mission.updated_at = after.mission.updated_at
      wanted.task.contract_version = wanted.mission.specification_version
      wanted.task.updated_at = after.task.updated_at
      wanted.task.verification_status = 'pending'
      wanted.task.contract.references = [...before.task.contract.references, ...proposal.reference_suffix]
      same(wanted.mission, after.mission); same(wanted.task, after.task)
      assert.equal(after.revisions.length, 1); assert.equal(after.revision_events.length, 1)
      const revision = after.revisions[0]
      assert.equal(revision.task_id, after.task.id); assert.equal(revision.revised_by, setup.actor_id)
      assert.equal(revision.version, after.task.contract_version)
      same(revision.previous_contract, before.task.contract); same(revision.replacement_contract, after.task.contract)
      same(revision.previous_verification_policy, before.task.verification_policy)
      same(revision.replacement_verification_policy, before.task.verification_policy)
      assert.equal(after.revision_events[0].aggregate_id, revision.id)
    }
    const initial = await snapshot()
    assert.equal(initial.snapshot.corp.id, setup.corp_id)
    const runner = initial.runners.find(item => item.runner_id === setup.runner_id || item.id === setup.runner_id)
    assert.ok(runner?.connected && runner.capabilities.some(item => item.name === 'fake-process' && item.available))
    const workspace = runner.capabilities.find(item => item.name === 'workspace-isolation' && item.available)
    assert.ok(workspace)
    assert.equal(workspace.source_repository.toLowerCase(), source.repository.toLowerCase())
    assert.equal(workspace.source_base_ref, source.base_ref); assert.equal(workspace.source_base_commit, source.base_commit)
    save('baseline.json', initial)

    async function createMission(kind) {
      const sourceCase = kind === 'source', filename = sourceCase ? 'corpus.json' : 'guidance-observation.json'
      const marker = sourceCase ? '[feedback-corpus-source]' : '[feedback-guidance-target]'
      const description = `${marker} Deterministic native feedback acceptance ${path.basename(output)} ${kind}. Preserve all existing authority; no external writes.`
      const body = { requested_by: setup.actor_id, title: `${marker} ${kind} ${randomUUID()}`, description,
        strategy: 'single', preferred_adapter: 'fake-process', preferred_model: null, reasoning_effort: null, max_task_attempts: 1,
        source, secret_refs: [], budget_tokens: 80000, budget_cost_microusd: 1000000,
        deliverable: { form: sourceCase ? 'typed_artifact_set' : 'review_only_report', commit_after_verification: false, paths: sourceCase ? ['corpus.json'] : [] },
        contract: { objective: `Write only ${filename} as declared by the deterministic fixture.`, expected_output: filename,
          acceptance_tests: ['Persist the declared JSON artifact and pass the unchanged native verifier.'], allowed_tools: ['filesystem'],
          prohibited_actions: ['No network requests, publication or deployment.', 'Do not alter the configured source checkout or verifier.'],
          references: ['Synthetic input; no authenticated independent review or provider inference.'],
          write_scope: sourceCase ? ['corpus.json', 'corpus-evidence.json'] : [filename] },
        verification_policy: { checks: [{ type: 'artifact', min_bytes: 32 }, { type: 'file', path: filename, min_bytes: 32 },
          { type: 'test', program: process.execPath, args: [SELF, sourceCase ? '--verify-corpus' : '--verify-guidance', filename,
            sourceCase ? seed.corpus.sha256 : seed.record.id], timeout_ms: 15000 }], manual_gate: null } }
      const created = await request(`${prefix}/missions`, body)
      assert.ok(UUID.test(created.mission_id) && UUID.test(created.task_id))
      owned.push({ kind, mission_id: created.mission_id, task_id: created.task_id, launched: false })
      const current = view(await snapshot(), created.mission_id)
      unrun(current); assert.equal(current.task.id, created.task_id)
      assert.equal(current.mission.description, description)
      assert.equal(current.task.contract.objective, `${description}\n\nTASK-SPECIFIC OBJECTIVE:\n${body.contract.objective}`,
        'Persisted fixture objective must equal the prospectively expected native composition')
      assert.equal(current.task.objective, current.task.contract.objective)
      assert.equal(current.task.contract.source_base_commit, source.base_commit)
      same(current.task.verification_policy, body.verification_policy)
      trace(`${kind}-saved-unrun`, current)
      return { created, before: current, body }
    }
    async function launchAndAccept(saved, kind) {
      const launch = await request(`${prefix}/missions/${saved.created.mission_id}/launch`, { requested_by: setup.actor_id })
      assert.ok(UUID.test(launch.run_id)); owned.find(item => item.mission_id === saved.created.mission_id).launched = true
      trace(`${kind}-launched`, { mission_id: saved.created.mission_id, run_id: launch.run_id })
      const end = Date.now() + 90000
      while (Date.now() < end) {
        const payload = await snapshot(), current = view(payload, saved.created.mission_id)
        const run = current.runs.find(item => item.id === launch.run_id)
        if (run && ['failed', 'cancelled', 'lost'].includes(run.status)) { trace(`${kind}-terminal-failure`, current); throw new Error(`${kind} native run failed; preserve lineage`) }
        if (run?.status === 'completed' && current.mission.status === 'completed' && current.task.status === 'completed'
          && ['preserved', 'removed'].includes(run.workspace_disposition)) {
          check(`${kind} full native verifier acceptance`, () => {
            assert.equal(run.verification_status, 'passed'); assert.equal(current.task.verification_status, 'passed')
            assert.equal(current.runs.length, 1)
            const checks = payload.snapshot.verification_evidence.filter(item => item.run_id === run.id).sort((a,b) => a.check_index - b.check_index)
            assert.equal(checks.length, saved.body.verification_policy.checks.length)
            assert.ok(checks.every((item, index) => item.check_index === index && item.status === 'passed'))
            assert.ok(payload.snapshot.events.some(item => item.type === 'run.session_terminated' && item.aggregate_id === run.id
              && item.payload?.outcome === 'completed' && item.payload.provider_process_alive === false), 'Native provider termination evidence required')
          })
          trace(`${kind}-accepted`, { ...current, verification_evidence: payload.snapshot.verification_evidence.filter(item => item.run_id === run.id) })
          return run
        }
        await wait(150)
      }
      throw new Error(`${kind} native run timed out; no automatic retry, resume or teardown`)
    }
    const producer = await createMission('source'), sourceRun = await launchAndAccept(producer, 'source')
    const sourceReceipt = await exportOperationReceipt({ env, runId: sourceRun.id, timeoutMs: 30000 })
    const corpusArtifacts = sourceReceipt.artifacts.filter(item => item.sha256 === seed.corpus.sha256 && item.media_type === 'application/json')
    assert.equal(corpusArtifacts.length, 1)
    const artifactId = corpusArtifacts[0].id
    assert.equal(corpusArtifacts[0].bytes, corpusBytes.length)
    const typedArtifacts = sourceReceipt.artifacts.filter(item => item.role === 'source_deliverable' && item.media_type === 'application/vnd.ecorp.deliverable+json')
    assert.equal(typedArtifacts.length, 1, 'Same source run must export the declared typed artifact set')
    const typedArtifactId = typedArtifacts[0].id
    const typedCapture = await exportOperationEvidence({ env, runId: sourceRun.id, artifactIds: [typedArtifactId], timeoutMs: 30000 })
    assert.equal(typedCapture.artifactBytes.length, 1)
    const typedEnvelope = JSON.parse(typedCapture.artifactBytes[0].bytes)
    assert.equal(typedEnvelope.schema_version, 1); assert.equal(typedEnvelope.form, 'typed_artifact_set')
    const typedFiles = typedEnvelope.changes.filter(item => item.path === 'corpus.json')
    assert.equal(typedFiles.length, 1)
    assert.deepEqual(Buffer.from(typedFiles[0].content_base64, 'base64'), corpusBytes)
    saveBytes('native-source-typed-artifact-set.json', typedCapture.artifactBytes[0].bytes)
    const sourceReceiptFile = save('source-operation-receipt.json', sourceReceipt)

    async function cli(label, command, values, routeEnv, expectedStatus) {
      const out = path.join(output, `${label}.json`), argv = [path.join(ROOT, 'tools/operation_feedback.mjs'), command, ...values, '--out', out]
      trace('cli-intent', { label, argv, server_origin: routeEnv.CRONY_SERVER_HTTP, expected_status: expectedStatus })
      let execution
      try { execution = { ...(await execFile(process.execPath, argv, { cwd: ROOT, env: routeEnv, windowsHide: true, timeout: 45000, maxBuffer: 1024 * 1024 })), exit_code: 0 } }
      catch (error) { execution = { stdout: error.stdout ?? '', stderr: error.stderr ?? '', exit_code: Number.isInteger(error.code) ? error.code : null, error_code: typeof error.code === 'string' ? error.code : null } }
      trace('cli-result', { label, ...execution })
      const result = JSON.parse(plainFile(out))
      assert.equal(result.state ?? result.status, expectedStatus)
      if (['ready-for-review', 'applied'].includes(expectedStatus)) assert.equal(execution.exit_code, 0)
      if (command === 'apply' && ['outcome-unknown', 'applied-but-source-changed'].includes(expectedStatus)) assert.equal(execution.exit_code, 3)
      if (command === 'apply' && expectedStatus === 'refused-before-effect') assert.equal(execution.exit_code, 2)
      assert.equal(result.launched ?? false, false)
      return { file: out, bytes: plainFile(out), result }
    }
    const prepare = (label, target, receiptFile, routeEnv, review = reviewFile, selection = { id: artifactId, path: null }) => cli(label, 'prepare', [
      '--corpus', corpusFile, '--corpus-sha256', sha(corpusBytes), '--review', review, '--review-sha256', sha(plainFile(review)),
      '--receipt', receiptFile, '--receipt-sha256', sha(plainFile(receiptFile)), '--artifact-id', selection.id, '--rule-ids', seed.record.id,
      '--mission-id', target.created.mission_id, '--task-id', target.created.task_id,
      ...(selection.path ? ['--artifact-path', selection.path] : [])], routeEnv, selection.expectedStatus ?? (review === reviewFile ? 'ready-for-review' : 'candidate'))
    const apply = (label, proposal, receiptFile, routeEnv, status = 'applied') => cli(label, 'apply', [
      '--proposal', proposal.file, '--sha256', sha(proposal.bytes), '--corpus', corpusFile, '--review', reviewFile, '--receipt', receiptFile], routeEnv, status)

    const target = await createMission('target')
    const badReview = saveBytes('deliberately-wrong-review.md', Buffer.from('Explicit synthetic negative review-byte control.\n'))
    const candidate = await prepare('negative-review-candidate', target, sourceReceiptFile, env, badReview)
    check('review-byte candidate refusal creates no revision or run', () => { assert.ok(candidate.result.reasons.includes('review_bytes_mismatch')); assert.equal(candidate.result.request, null) })
    same(view(await snapshot(), target.created.mission_id), target.before)
    const staleReceipt = structuredClone(sourceReceipt)
    staleReceipt.task.updated_at = new Date(Date.parse(staleReceipt.task.updated_at) + 1).toISOString()
    const staleReceiptFile = save('deliberately-stale-source-observation.json', staleReceipt)
    const staleCandidate = await prepare('negative-stale-receipt-candidate', target, staleReceiptFile, env, reviewFile,
      { id: artifactId, path: null, expectedStatus: 'candidate' })
    check('stale observation candidate refusal creates no revision or run', () => {
      assert.ok(staleCandidate.result.reasons.includes('receipt_stale_or_mismatched_receipt')); assert.equal(staleCandidate.result.request, null)
    })
    same(view(await snapshot(), target.created.mission_id), target.before)
    const proposal = await prepare('target-proposal', target, sourceReceiptFile, env)
    check('prepared CLI change is reference-only and unlaunched', () => {
      const contract = structuredClone(proposal.result.request.contract); contract.references = target.before.task.contract.references
      same(contract, target.before.task.contract); same(proposal.result.request.verification_policy, target.before.task.verification_policy)
      assert.equal(proposal.result.source.artifact.id, artifactId)
      assert.equal(proposal.result.inputs.corpus_sha256, seed.corpus.sha256)
    })
    if (setup.denied_actor_id) {
      assert.ok(UUID.test(setup.denied_actor_id))
      await request(`${prefix}/missions/${target.created.mission_id}/contract-revisions`,
        { ...proposal.result.request, actor_id: setup.denied_actor_id, idempotency_key: randomUUID() }, [403, 404])
      const deniedAfter = view(await snapshot(), target.created.mission_id)
      check('actual nonmember actor denial preserves target', () => same(deniedAfter, target.before))
    }
    const applied = await apply('target-applied', proposal, sourceReceiptFile, env)
    const after = view(await snapshot(), target.created.mission_id)
    check('one native revision/event preserves all authority and remains unrun', () => {
      unchangedReferencesOnly(target.before, after, proposal.result)
      assert.equal(applied.result.native_revision_id, after.revisions[0].id)
      assert.equal(applied.result.native_revision_version, after.task.contract_version)
    })
    const replayed = await apply('target-replayed', proposal, sourceReceiptFile, env)
    check('exact native idempotency replay creates no second revision', () => { assert.equal(replayed.result.replayed, true); assert.equal(replayed.result.native_revision_id, applied.result.native_revision_id) })
    same(view(await snapshot(), target.created.mission_id), after)
    const targetRun = await launchAndAccept(target, 'target')
    const targetReceipt = await exportOperationReceipt({ env, runId: targetRun.id, timeoutMs: 30000 })
    save('target-operation-receipt.json', targetReceipt)
    const observed = await exportOperationEvidence({ env, runId: targetRun.id, artifactIds: [targetRun.artifact_id], timeoutMs: 30000 })
    assert.equal(observed.artifactBytes.length, 1)
    const observationBytes = observed.artifactBytes[0].bytes, observation = JSON.parse(observationBytes)
    saveBytes('native-guidance-observation.json', observationBytes)
    check('native runner received each prepared advisory reference exactly once', () => {
      assert.equal(observation.run_id, targetRun.id); assert.equal(observation.kind, 'ecorp-feedback-guidance-observation')
      assert.equal(observation.deterministic_fixture, true); assert.equal(observation.provider_inference, false)
      assert.deepEqual(observation.references, proposal.result.reference_suffix)
      assert.deepEqual(observation.rule_ids, [seed.record.id]); assert.ok(HASH.test(observation.prompt_sha256))
      for (const reference of proposal.result.reference_suffix) assert.equal(observation.references.filter(item => item === reference).length, 1)
    })

    const typedTarget = await createMission('typed-target')
    const typedProposal = await prepare('typed-target-proposal', typedTarget, sourceReceiptFile, env, reviewFile, { id: typedArtifactId, path: 'corpus.json' })
    check('typed selection binds exact declared corpus file from the same accepted source run', () => {
      assert.equal(typedProposal.result.inputs.artifact_path, 'corpus.json')
      assert.equal(typedProposal.result.source.scope.run_id, sourceRun.id)
      assert.equal(typedProposal.result.source.artifact.id, typedArtifactId)
      same(typedProposal.result.source.corpus_binding, { kind: 'typed-artifact-set-file', path: 'corpus.json',
        artifact_sha256: typedArtifacts[0].sha256, content_sha256: seed.corpus.sha256, content_bytes: corpusBytes.length })
    })
    const typedApplied = await apply('typed-target-applied', typedProposal, sourceReceiptFile, env)
    const typedAfter = view(await snapshot(), typedTarget.created.mission_id)
    check('typed artifact application preserves native authority and remains unrun', () => {
      unchangedReferencesOnly(typedTarget.before, typedAfter, typedProposal.result)
      assert.equal(typedApplied.result.native_revision_id, typedAfter.revisions[0].id)
    })
    const typedReplay = await apply('typed-target-replayed', typedProposal, sourceReceiptFile, env)
    assert.equal(typedReplay.result.replayed, true)
    same(view(await snapshot(), typedTarget.created.mission_id), typedAfter)
    const typedRun = await launchAndAccept(typedTarget, 'typed-target')
    const typedObservation = await exportOperationEvidence({ env, runId: typedRun.id, artifactIds: [typedRun.artifact_id], timeoutMs: 30000 })
    save('typed-target-operation-receipt.json', typedObservation.receipt)
    assert.equal(typedObservation.artifactBytes.length, 1)
    const typedObservedBytes = typedObservation.artifactBytes[0].bytes, typedObserved = JSON.parse(typedObservedBytes)
    saveBytes('native-typed-guidance-observation.json', typedObservedBytes)
    check('later native target consumes each typed-corpus advisory reference exactly once', () => {
      assert.equal(typedObserved.run_id, typedRun.id)
      assert.equal(typedObserved.kind, 'ecorp-feedback-guidance-observation')
      assert.equal(typedObserved.deterministic_fixture, true); assert.equal(typedObserved.provider_inference, false)
      assert.deepEqual(typedObserved.references, typedProposal.result.reference_suffix)
      assert.deepEqual(typedObserved.rule_ids, [seed.record.id]); assert.ok(HASH.test(typedObserved.prompt_sha256))
      for (const reference of typedProposal.result.reference_suffix) assert.equal(typedObserved.references.filter(item => item === reference).length, 1)
    })

    if (args['--proxy-fault']) {
      const faultTarget = await createMission('fault-target')
      proxy = await revisionFaultProxy({ server: setup.server_url, corpId: setup.corp_id, actorId: setup.actor_id, missionId: faultTarget.created.mission_id,
        record: event => trace('proxy', event) })
      const proxyEnv = scopedEnvironment(setup, proxy.origin)
      const proxyReceipt = await exportOperationReceipt({ env: proxyEnv, runId: sourceRun.id, timeoutMs: 30000 })
      assert.equal(proxyReceipt.scope.server_origin_sha256, sha(proxy.origin))
      const proxyReceiptFile = save('proxy-origin-operation-receipt.json', proxyReceipt)
      const faultProposal = await prepare('fault-target-proposal', faultTarget, proxyReceiptFile, proxyEnv)
      proxy.arm()
      const unknown = await apply('fault-target-ambiguous', faultProposal, proxyReceiptFile, proxyEnv, 'outcome-unknown')
      const committed = view(await snapshot(), faultTarget.created.mission_id)
      check('generic HTTP 400 after real commit remains unknown and unlaunched', () => {
        assert.equal(proxy.faults(), 1); assert.equal(unknown.result.mutation_requests, 1)
        unchangedReferencesOnly(faultTarget.before, committed, faultProposal.result)
      })
      const reconciled = await apply('fault-target-reconciled', faultProposal, proxyReceiptFile, proxyEnv)
      check('exact replay reconciles one actual revision after controlled response loss', () => {
        assert.equal(reconciled.result.replayed, true); assert.equal(reconciled.result.native_revision_id, committed.revisions[0].id)
        assert.equal(proxy.faults(), 1)
      })
      same(view(await snapshot(), faultTarget.created.mission_id), committed)
      await proxy.close(); proxy = null
    }
    await verifyOwner('after')
    assert.equal(await git(['rev-parse', 'HEAD']), source.base_commit); assert.equal(await git(['status', '--porcelain=v1']), '')
    assert.equal(sha(plainFile(corpusFile)), sha(corpusBytes)); assert.equal(sha(plainFile(reviewFile)), sha(reviewBytes))
    assert.equal(sha(plainFile(path.join(inputRoot, 'manifest.json'))), sha(seedBytes))
    for (const pin of pins) assert.equal(sha(plainFile(path.join(ROOT, pin.file))), pin.sha256, `Acceptance implementation changed: ${pin.file}`)
    for (const pin of runtimePins) assert.equal(sha(plainFile(pin.path, 256 * 1024 * 1024)), pin.sha256, 'QA runtime or deterministic script changed')
    const result = { schema_version: 1, status: 'passed', started_at: started, finished_at: new Date().toISOString(), assertions,
      native_ids: owned, source_run_id: sourceRun.id, target_run_id: targetRun.id, typed_target_run_id: typedRun.id,
      source_artifact_id: artifactId, typed_source_artifact_id: typedArtifactId, typed_native_revision_id: typedApplied.result.native_revision_id,
      native_revision_id: applied.result.native_revision_id, source, source_files: pins,
      browser_followup: { observed: false, web_url: setup.web_url ?? null, corp_id: setup.corp_id, actor_id: setup.actor_id, room_id: setup.room_id, missions: owned },
      scope: 'Owned native HTTP/MCP/CLI/runner/verifier transport with synthetic data and deterministic fake-process. Advisory reference consumption only.',
      provider_inference: false, authenticated_independent_review: false, production_identity_verified: false, remote_github_effects: 0,
      database_reset: false, process_restart: false, all_failed_and_unrun_lineage_preserved: true }
    save('result.json', result)
    return { status: result.status, passed: assertions.length, output, native_ids: owned }
  } catch (error) {
    save('failure.json', { status: 'failed', started_at: started, failed_at: new Date().toISOString(), assertions, native_ids: owned,
      error: error instanceof assert.AssertionError ? 'acceptance_assertion_failed' : 'acceptance_incomplete',
      message: 'Preserve all attempts, native missions and output files. No automatic retry, reset, resume or teardown was performed.',
      evidence_preserved: true })
    throw error
  } finally { if (proxy) await proxy.close() }
}

// One explicitly owned loopback forwarding proxy. It changes transport only,
// after a real successful native revision response; it never invents native state.
export async function revisionFaultProxy({ server, corpId, actorId, missionId, record }) {
  loopback(server)
  assert.ok([corpId, actorId, missionId].every(value => UUID.test(value)))
  let armed = false, faults = 0
  const prefix = `/api/corps/${corpId}`, target = `${prefix}/missions/${missionId}/contract-revisions`
  const proxy = createServer(async (incoming, outgoing) => {
    try {
      const route = new URL(incoming.url, 'http://127.0.0.1')
      const isRevision = incoming.method === 'POST' && route.pathname === target && !route.search
      assert.ok(incoming.method === 'GET' && route.pathname.startsWith(`${prefix}/`) && route.searchParams.get('actor_id') === actorId || isRevision)
      let body = Buffer.alloc(0)
      for await (const chunk of incoming) { assert.ok(body.length + chunk.length <= 1024 * 1024); body = Buffer.concat([body, chunk]) }
      if (isRevision) assert.equal(JSON.parse(body).actor_id, actorId)
      const headers = { ...(incoming.headers['content-type'] ? { 'content-type': incoming.headers['content-type'] } : {}),
        ...(incoming.headers.authorization ? { authorization: incoming.headers.authorization } : {}) }
      const response = await fetch(`${server}${route.pathname}${route.search}`, { method: incoming.method, headers, redirect: 'error', signal: AbortSignal.timeout(20000),
        ...(isRevision ? { body } : {}) })
      const chunks = []; let length = 0
      for await (const chunk of response.body) { length += chunk.length; assert.ok(length <= 16 * 1024 * 1024); chunks.push(chunk) }
      const bytes = Buffer.concat(chunks)
      if (armed && isRevision && response.ok) {
        const actual = JSON.parse(bytes)
        assert.equal(actual.replayed, false); assert.ok(UUID.test(actual.revision.id))
        armed = false; faults++
        record({ kind: 'successful-native-response-replaced-once', native_status: response.status, injected_status: 400,
          native_revision_id: actual.revision.id, native_response_sha256: sha(bytes), request_sha256: sha(body), idempotency_key: JSON.parse(body).idempotency_key })
        outgoing.writeHead(400, { 'content-type': 'application/json' }); outgoing.end('{"error":"controlled post-commit response fault"}\n')
        return
      }
      const retained = Object.fromEntries([...response.headers].filter(([key]) => !['connection', 'content-encoding', 'content-length', 'transfer-encoding', 'keep-alive'].includes(key)))
      retained['content-length'] = String(bytes.length)
      outgoing.writeHead(response.status, retained); outgoing.end(bytes)
    } catch {
      if (!outgoing.headersSent) outgoing.writeHead(502, { 'content-type': 'application/json' })
      outgoing.end('{"error":"owned transport unavailable"}\n')
    }
  })
  await new Promise((resolve, reject) => { proxy.once('error', reject); proxy.listen(0, '127.0.0.1', resolve) })
  const origin = `http://127.0.0.1:${proxy.address().port}`
  record({ kind: 'owned-loopback-proxy-started', origin, process_id: process.pid, upstream_origin: server, target_mission_id: missionId })
  return { origin, arm: () => { assert.equal(faults, 0); assert.equal(armed, false); armed = true }, faults: () => faults,
    close: () => new Promise((resolve, reject) => { proxy.close(error => error ? reject(error) : resolve()); proxy.closeIdleConnections() }) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const argv = process.argv.slice(2)
  const run = argv[0]?.startsWith('--verify-')
    ? Promise.resolve().then(() => { assert.equal(argv.length, 3); return verifyFixtureFile(...argv) })
    : runAcceptance(argv)
  run.then(result => process.stdout.write(`${JSON.stringify(result)}\n`)).catch(() => {
    process.stderr.write('{"status":"failed","error":"operation_feedback_acceptance_failed","raw_details_withheld":true}\n')
    process.exitCode = 1
  })
}
