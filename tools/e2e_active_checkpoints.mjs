// Opt-in native acceptance for #72. Importing this file never starts work.
// Deterministic child processes, local Git and fake GitHub are not hosted evidence.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { captureOwnedTestServerManifest, verifyOwnedTestProcess } from './owned_test_stack.mjs'

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const terminal = run => ['completed', 'failed', 'cancelled', 'lost'].includes(run?.status)
const contains = (root, target) => {
  const relative = path.relative(root, target)
  return !relative || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}
function loopback(value) {
  const url = new URL(value)
  assert.equal(url.protocol, 'http:'); assert.equal(url.hostname, '127.0.0.1')
  assert.ok(Number(url.port) >= 10000 && !url.username && !url.password && !url.search && !url.hash)
  assert.equal(url.pathname, '/')
  return url.origin
}
export function validateCheckpointFixture(setup, optIn) {
  assert.equal(optIn, '1', 'Explicit ECORP_ACTIVE_CHECKPOINT_TEST=1 is required')
  assert.equal(setup.test_owned, true); assert.equal(setup.provider_fixture, 'native-fake-process')
  for (const key of ['qa_root', 'repository', 'source']) assert.ok(path.isAbsolute(setup[key] ?? ''))
  assert.match(path.basename(setup.qa_root), /^issue72-active-checkpoints-[a-zA-Z0-9-]+$/u)
  assert.equal(path.basename(path.dirname(setup.qa_root)), 'qa')
  assert.equal(path.resolve(setup.source), path.join(path.resolve(setup.qa_root), 'source'))
  assert.ok(!contains(setup.repository, setup.qa_root) && !contains(setup.qa_root, setup.repository))
  assert.equal(setup.source_repository, 'ecorp-fixture/active-checkpoints-fixture')
  assert.match(setup.source_commit ?? '', /^[0-9a-f]{40}$/u)
  assert.match(setup.source_binding?.source_fingerprint ?? '', /^[0-9a-f]{64}$/u)
  assert.equal(setup.runner_id, 'issue72-checkpoint-qa')
  for (const key of ['corp_id', 'alice_actor_id']) assert.match(setup.demo?.[key] ?? '', uuid)
  const server = loopback(setup.server_url), web = loopback(setup.web_url)
  assert.notEqual(server, web)
  for (const role of ['server', 'runner', 'web']) {
    const owned = setup.processes?.[role]
    assert.ok(Number.isSafeInteger(owned?.pid) && owned.pid > 1)
    assert.ok(path.isAbsolute(owned.executable))
    assert.ok(Number.isFinite(Date.parse(owned.started_utc)))
  }
  return { server, web }
}
async function canonicalDirectory(value) {
  const declared = path.resolve(value), info = await lstat(declared)
  assert.ok(info.isDirectory() && !info.isSymbolicLink(), 'Owned directories cannot be links')
  assert.equal(path.resolve(await realpath(declared)), declared, 'Owned paths cannot use aliases')
  return declared
}
export async function validateCheckpointPaths(setup) {
  const product = await canonicalDirectory(path.resolve(import.meta.dirname, '..'))
  assert.equal(await canonicalDirectory(setup.repository), product)
  const qa = await canonicalDirectory(setup.qa_root), source = await canonicalDirectory(setup.source)
  assert.ok(!contains(product, qa) && !contains(qa, product))
  assert.equal(source, path.join(qa, 'source'))
  for (const name of ['evidence', 'credentials']) await canonicalDirectory(path.join(qa, name))
  const output = path.join(qa, 'evidence', 'active-checkpoints')
  await assert.rejects(lstat(output), { code: 'ENOENT' }, 'Never overwrite a prior attempt')
  return output
}
export function checkpointChildEnvironment(inherited) {
  const names = new Map([['PATH', 'PATH'], ['PATHEXT', 'PATHEXT'], ['SYSTEMROOT', 'SystemRoot'],
    ['SYSTEMDRIVE', 'SystemDrive'], ['WINDIR', 'WINDIR'], ['COMSPEC', 'ComSpec']])
  const environment = {}
  for (const [key, value] of Object.entries(inherited)) {
    const name = names.get(key.toUpperCase())
    if (!name) continue
    assert.ok(!Object.hasOwn(environment, name), 'Ambiguous environment variable casing')
    assert.equal(typeof value, 'string', 'Executable lookup and OS variables must be strings')
    environment[name] = value
  }
  return environment
}
export async function checkpointFixtureEnvironment(inherited, directory) {
  const environment = checkpointChildEnvironment(inherited)
  assert.ok(path.isAbsolute(directory), 'An absolute owned environment directory is required')
  const parent = await canonicalDirectory(path.dirname(directory))
  const root = path.resolve(directory)
  assert.equal(path.dirname(root), parent)
  // No recursive mkdir: an existing directory, file or link must never be adopted.
  await mkdir(root, { mode: 0o700 })
  await canonicalDirectory(root)
  for (const name of ['home', 'config', 'cache', 'data', 'state', 'runtime', 'tmp']) {
    await mkdir(path.join(root, name), { mode: 0o700 })
  }
  // Windows native known-folder lookup expands USERPROFILE, not APPDATA overrides.
  const appData = path.join(root, 'home', 'AppData')
  await mkdir(appData, { mode: 0o700 })
  for (const name of ['Roaming', 'Local']) await mkdir(path.join(appData, name), { mode: 0o700 })
  const globalConfig = path.join(root, 'empty-gitconfig')
  await writeFile(globalConfig, '', { flag: 'wx', mode: 0o600 })
  return { ...environment, HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'),
    APPDATA: path.join(appData, 'Roaming'), LOCALAPPDATA: path.join(appData, 'Local'),
    XDG_CONFIG_HOME: path.join(root, 'config'), XDG_CACHE_HOME: path.join(root, 'cache'),
    XDG_DATA_HOME: path.join(root, 'data'), XDG_STATE_HOME: path.join(root, 'state'),
    XDG_RUNTIME_DIR: path.join(root, 'runtime'), TEMP: path.join(root, 'tmp'),
    TMP: path.join(root, 'tmp'), TMPDIR: path.join(root, 'tmp'),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: globalConfig,
    GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: 'file' }
}

export async function runCheckpointAcceptance(setupPath, optIn) {
  assert.ok(path.isAbsolute(setupPath ?? ''), 'An explicit owned setup receipt is required')
  const setup = JSON.parse((await readFile(setupPath, 'utf8')).replace(/^\uFEFF/u, ''))
  const { server, web } = validateCheckpointFixture(setup, optIn)
  const output = await validateCheckpointPaths(setup)
  await mkdir(output)
  const reportPath = path.join(output, 'report.json')
  const report = { schema_version: 1, issue: 72, status: 'running', started_at: new Date().toISOString(),
    source_binding: setup.source_binding, server, web, corp_id: setup.demo.corp_id, runner_id: setup.runner_id,
    checks: [], scenarios: [], commands: [], screenshots: [], http_results: [], blocked_requests: [], page_errors: [],
    scope: 'Local deterministic acceptance: actual Edge, fresh private PostgreSQL, native server/runner/CLI, native Git and fake GitHub. Fixture owner decisions are synthetic. No human/independent review, hosted GitHub, provider inference or operating-system isolation claimed.' }
  const secrets = [], scrub = value => secrets.reduce((text, secret) => text.split(secret).join('[withheld]'), String(value))
  const save = () => writeFile(reportPath, `${scrub(JSON.stringify(report, null, 2))}\n`)
  const check = (name, fn, details = {}) => {
    try { fn(); report.checks.push({ name, passed: true, ...details }) }
    catch (error) { report.checks.push({ name, passed: false, error: scrub(error.message) }); throw error }
  }
  const baseEnvironment = await checkpointFixtureEnvironment(process.env, path.join(setup.qa_root, 'checkpoint-environment'))
  const statePath = path.join(output, 'fake-github.json'), remotePath = path.join(setup.qa_root, 'remote.git')
  const fakeGithub = path.join(setup.repository, 'tools', 'fake_github_cli.mjs')
  const binary = path.join(setup.repository, 'target', 'debug', `crony-cli${process.platform === 'win32' ? '.exe' : ''}`)
  const environment = { ...baseEnvironment, CRONY_SERVER_HTTP: server,
    ECORP_GITHUB_CLI_PREFIX_ARGS_JSON: JSON.stringify([fakeGithub]), ECORP_FAKE_GITHUB_STATE: statePath,
    ECORP_GITHUB_COMMAND_TIMEOUT_MS: '10000', ECORP_SOURCE_GIT_COMMAND_TIMEOUT_MS: '10000' }
  let sequence = 0
  async function command(name, program, args, env = baseEnvironment, expected = [0], timeout = 90_000) {
    const started = Date.now()
    const result = await new Promise((resolve, reject) => {
      const child = spawn(program, args, { cwd: setup.repository, env, windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'], timeout })
      let stdout = '', stderr = '', overflow = false
      child.stdout.on('data', bytes => { stdout += bytes; if (stdout.length > 8 * 1024 * 1024) { overflow = true; child.kill() } })
      child.stderr.on('data', bytes => { stderr += bytes; if (stderr.length > 8 * 1024 * 1024) { overflow = true; child.kill() } })
      child.once('error', reject)
      child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr, overflow }))
    })
    const leaked = secrets.some(secret => result.stdout.includes(secret) || result.stderr.includes(secret))
    result.stdout = scrub(result.stdout); result.stderr = scrub(result.stderr)
    const log = path.join(output, `${String(++sequence).padStart(3, '0')}-${name}.json`)
    await writeFile(log, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' })
    report.commands.push({ name, program, args, code: result.code, signal: result.signal,
      milliseconds: Date.now() - started, credential_leak: leaked, log, sha256: hash(await readFile(log)) })
    await save()
    assert.equal(leaked, false, 'Child output exposed a fixture credential; retained log is redacted')
    assert.equal(result.overflow, false, 'Child output exceeded its bounded capture')
    assert.ok(expected.includes(result.code), `${name}: unexpected exit ${result.code}; see sanitized log ${log}`)
    return result
  }
  const git = async args => (await command('git', 'git', args)).stdout.trim()
  const readFake = async () => JSON.parse(await readFile(statePath, 'utf8'))
  const writeFake = state => writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`)
  const api = suffix => `/api/corps/${setup.demo.corp_id}${suffix}`
  async function request(route, body, expected = [200]) {
    assert.ok(route.startsWith(api('/')), 'Only the owned Corp API is allowed')
    const response = await fetch(server + route, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error', signal: AbortSignal.timeout(15000) })
    const value = await response.json()
    if (body !== undefined || !expected.includes(response.status)) report.http_results.push({ route,
      method: body === undefined ? 'GET' : 'POST', status: response.status, expected })
    assert.ok(expected.includes(response.status), `${route}: unexpected HTTP ${response.status}`)
    return value
  }
  let browser, page, lastState, currentScenario, phase = 'owned process identity'
  const snapshot = async () => (lastState = await request(api(`/snapshot?actor_id=${setup.demo.alice_actor_id}`)))
  const context = scenario => request(api(`/factory/work-items/${scenario.work_item_id}/active-checkpoint?actor_id=${setup.demo.alice_actor_id}`))
  const finalPublication = async scenario => {
    const response = await request(api(`/factory/work-items/${scenario.work_item_id}/publication?actor_id=${setup.demo.alice_actor_id}`))
    assert.equal(response.publisher_token, null, 'Read-only publication evidence must not disclose a forward token')
    return response.publication
  }
  const remoteFor = (state, scenario) => {
    const matches = state.pull_requests.filter(pr => pr.headRefName === scenario.branch)
    assert.equal(matches.length, 1, 'The checkpoint must retain one PR')
    return matches[0]
  }
  const draftEffects = (state, scenario) => state.effect_log.filter(effect =>
    effect.kind === 'pull_request_draft_state' && effect.number === remoteFor(state, scenario).number)
  const runs = (state, scenario) => {
    const taskIds = new Set(state.snapshot.tasks.filter(task => task.mission_id === scenario.mission_id).map(task => task.id))
    return state.snapshot.runs.filter(run => taskIds.has(run.task_id))
  }
  async function until(label, observe, predicate, timeout = 35_000) {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) { const value = await observe(); if (await predicate(value)) return value; await delay(300) }
    throw new Error(`Timed out waiting for ${label}`)
  }
  async function screenshot(name) {
    const file = path.join(output, `${name}.png`)
    await page.screenshot({ path: file, fullPage: true })
    report.screenshots.push({ file, sha256: hash(await readFile(file)) })
  }
  async function showMission(scenario) {
    await page.goto(`${web}/#missions`, { waitUntil: 'networkidle' })
    await page.locator('.live-indicator.live-live').waitFor()
    const card = page.locator(`[data-mission-id="${scenario.mission_id}"]`)
    if (!(await card.isVisible())) {
      const state = await snapshot(), mission = state.snapshot.missions.find(row => row.id === scenario.mission_id)
      assert.ok(mission)
      await page.getByRole('button').filter({ hasText: mission.title }).click()
    }
    await card.waitFor(); return card
  }
  function factoryArgs(scenario) {
    return ['factory', setup.demo.corp_id, setup.demo.alice_actor_id, '--owner', 'acme', '--project-number', '7',
      '--repository', setup.source_repository, '--source-repository-path', setup.source, '--source-base-ref', 'main',
      '--publication-base-ref', 'main', '--adapter', 'fake-process', '--strategy', 'single', '--budget-tokens', '20000',
      '--budget-cost-microusd', '1000000', '--lease-seconds', '300', '--issue', String(scenario.issue),
      '--verification-policy-file', scenario.policy_file, '--checkpoint-check-index', '0', '--github-cli', process.execPath]
  }
  let publisherEnvironment, credentialPath
  async function publish(scenario, crashAfter, expected = [0]) {
    return command('checkpoint-publisher', binary, ['factory-checkpoint', setup.demo.corp_id,
      setup.demo.alice_actor_id, scenario.work_item_id, '--publisher-id', 'owned-checkpoint-publisher',
      '--publisher-credential-file', credentialPath, '--github-cli', process.execPath,
      '--wait-seconds', '1', '--poll-seconds', '1'], { ...publisherEnvironment,
      ...(crashAfter ? { ECORP_PUBLICATION_TEST_CRASH_AFTER: crashAfter } : {}) }, expected)
  }
  const finalArgs = scenario => ['factory-publish', setup.demo.corp_id, setup.demo.alice_actor_id, scenario.work_item_id,
    '--authorization-id', scenario.authorization_id, '--authorization-reason', 'Synthetic fixture review publication; no merge or deployment.',
    '--publisher-id', 'owned-checkpoint-publisher', '--publisher-credential-file', credentialPath,
    '--lease-seconds', '5', '--wait-seconds', '60', '--github-cli', process.execPath]
  const promote = (scenario, expected = [0], crashAfter) => command(`${scenario.name}-final-publisher`,
    binary, finalArgs(scenario), { ...publisherEnvironment,
      ...(crashAfter ? { ECORP_PUBLICATION_TEST_CRASH_AFTER: crashAfter } : {}) }, expected)
  async function waitForPublicationLease(scenario) {
    const publication = await finalPublication(scenario)
    const expiry = Date.parse(publication.publisher_lease_expires_at)
    assert.ok(Number.isFinite(expiry) && expiry - Date.now() <= 120_000)
    scenario.natural_lease_expiry = { publication_id: publication.id, expires_at: publication.publisher_lease_expires_at }
    await save()
    // Do not rewrite stored clocks to manufacture restart authority.
    while (Date.now() <= expiry + 400) await delay(Math.min(1000, expiry + 401 - Date.now()))
  }
  async function launch(issue, name, focusedPass, fullPass, manual) {
    phase = `launch ${name}`
    const scenario = { issue, name, authorization_id: randomUUID(),
      policy_file: path.join(output, `policy-${issue}.json`) }
    report.scenarios.push(scenario); currentScenario = scenario
    const policy = { checks: [{ type: 'file', path: focusedPass ? 'README.md' : 'missing-focused.txt', min_bytes: 1 },
      { type: 'file', path: fullPass ? 'portable-untracked.txt' : 'missing-full.txt', min_bytes: 1 },
      { type: 'command', program: process.execPath, timeout_ms: 5000,
        args: ['-e', "const p=JSON.parse(require('node:fs').readFileSync('checkpoint-credential-probe.json','utf8'));if(Object.keys(p).length!==5||Object.values(p).some(v=>v!==false))process.exit(1)"] }],
    manual_gate: manual ? { type: 'human_approval', roles: ['owner', 'admin'] } : null }
    await writeFile(scenario.policy_file, `${JSON.stringify(policy, null, 2)}\n`, { flag: 'wx' })
    const result = await command('factory-launch', binary, factoryArgs(scenario), environment)
    scenario.launch = JSON.parse(result.stdout)
    scenario.work_item_id = scenario.launch.factory_work_item_id; scenario.mission_id = scenario.launch.mission_id
    assert.match(scenario.work_item_id, uuid); assert.match(scenario.mission_id, uuid)
    const state = await until('owned active run', snapshot, value => runs(value, scenario).length === 1)
    scenario.run_id = runs(state, scenario)[0].id
    await save(); return scenario
  }
  async function completedDraft(issue, name) {
    const scenario = await launch(issue, name, true, true, false)
    const stored = await until('signed source checkpoint', () => context(scenario), value => value.artifacts.length === 1)
    scenario.artifact = stored.artifacts[0]
    scenario.commit = scenario.artifact.metadata.head_commit
    scenario.branch = `${stored.work_item.policy.publication.branch_prefix}issue-${scenario.issue}-${scenario.work_item_id.slice(0, 8)}`
    const fake = await readFake(); fake.branch_heads[scenario.branch] = scenario.commit; await writeFake(fake)
    await publish(scenario)
    await until('persisted completed verification', snapshot, state => runs(state, scenario)[0]?.status === 'completed')
    await command(`${name}-factory-refresh`, binary, factoryArgs(scenario), environment)
    await publish(scenario)
    const observed = await context(scenario), remote = await readFake()
    scenario.initial_pr = structuredClone(remoteFor(remote, scenario))
    check(`${name}: completed verification alone retains the source-bound draft`, () => {
      assert.equal(observed.publication.phase, 'project_synchronized')
      assert.equal(scenario.initial_pr.isDraft, true)
      assert.equal(scenario.initial_pr.headRefOid, scenario.commit)
      assert.equal(remote.items.find(item => item.content.number === issue).status, 'In Progress')
      assert.ok(observed.publication.pull_request.evidence_comment)
    })
    assert.equal(await git(['--git-dir', remotePath, 'rev-list', '--count', `${setup.source_commit}..refs/heads/${scenario.branch}`]), '1')
    await showMission(scenario); await screenshot(`${name}-verified-draft`); await save()
    return scenario
  }
  async function assertUnacceptedDraft(scenario, expectedState, expectedAcknowledgement, expectedUndo) {
    const publication = await finalPublication(scenario), fake = await readFake(), remote = remoteFor(fake, scenario)
    const journal = publication.provenance.active_checkpoint_readiness
    scenario.readiness_observations ??= []
    scenario.readiness_observations.push(structuredClone(publication))
    check(`${scenario.name}: observed draft is ${expectedState} with truthful command receipts`, () => {
      assert.equal(publication.state, 'branch_pushed')
      assert.equal(journal.state, expectedState)
      assert.equal(journal.ready_succeeded, expectedAcknowledgement)
      assert.equal(journal.undo.length, expectedUndo)
      assert.equal(journal.pull_request.number, scenario.initial_pr.number)
      assert.equal(journal.pull_request.node_id, scenario.initial_pr.id)
      assert.equal(remote.isDraft, true)
      assert.equal(fake.items.find(item => item.content.number === scenario.issue).status, 'In Progress')
      assert.equal(remote.autoMergeRequest, null)
      assert.equal(remote.state, 'OPEN')
    })
    await save(); return { publication, journal, fake, remote }
  }
  async function checkpointAndCrash(scenario, crashAfter) {
    phase = `${scenario.name}: authentic checkpoint and ${crashAfter}`
    const stored = await until('signed source checkpoint', () => context(scenario), value => value.artifacts.length === 1)
    const artifact = stored.artifacts[0]
    scenario.artifact = artifact
    scenario.commit = artifact.metadata.head_commit
    scenario.branch = `${stored.work_item.policy.publication.branch_prefix}issue-${scenario.issue}-${scenario.work_item_id.slice(0, 8)}`
    assert.match(scenario.commit, /^[0-9a-f]{40}$/u)
    const fake = await readFake(); fake.branch_heads[scenario.branch] = scenario.commit; await writeFake(fake)
    await publish(scenario, crashAfter, [86])
    const crashed = await context(scenario), state = await snapshot(), remote = await readFake()
    scenario.crashed_publication = crashed.publication
    const expectDraft = crashAfter === 'after_active_checkpoint_draft_remote'
    check(`${scenario.name}: partial remote effect is not a runner completion receipt`, () => {
      assert.equal(crashed.publication.phase, expectDraft ? 'branch_pushed' : 'pending')
      assert.equal(crashed.publication.pull_request, null)
      // Provider artifact intake enters the broad verifying state before the
      // immutable policy starts. Its persisted verification status stays pending.
      assert.equal(runs(state, scenario)[0].status, 'verifying')
      assert.equal(runs(state, scenario)[0].verification_status, 'pending')
      assert.ok(!state.snapshot.events.some(event => event.aggregate_id === scenario.run_id &&
        ['run.verification_started', 'run.verification_passed', 'run.completed'].includes(event.type)))
      assert.equal(remote.pull_requests.filter(pr => pr.headRefName === scenario.branch).length, expectDraft ? 1 : 0)
      assert.equal(remote.items.find(item => item.content.number === scenario.issue).status, 'In Progress')
    })
    assert.equal(await git(['--git-dir', remotePath, 'rev-parse', `refs/heads/${scenario.branch}`]), scenario.commit)
    const probe = JSON.parse(await git(['--git-dir', remotePath, 'show', `${scenario.commit}:checkpoint-credential-probe.json`]))
    check(`${scenario.name}: producing process received no repository or publisher credential environment`, () => {
      assert.equal(Object.keys(probe).length, 5); assert.ok(Object.values(probe).every(value => value === false))
    }, { assurance: 'Environment boundary only; no operating-system isolation claimed' })
    await showMission(scenario); await screenshot(`${scenario.name}-remote-wait`); await save()
    // Exercise actual expiry, never rewrite database clocks or shorten production leases.
    phase = `${scenario.name}: natural publisher lease expiry`
    const expiry = Date.parse(crashed.publication.lease_expires_at)
    assert.ok(expiry > Date.now() && expiry - Date.now() <= 120_000)
    while (Date.now() <= expiry + 400) await delay(Math.min(1000, expiry + 401 - Date.now()))
    await publish(scenario)
    const resumed = await context(scenario), adopted = await readFake()
    scenario.resumed_publication = resumed.publication
    check(`${scenario.name}: restarted publisher adopts the same source and one draft`, () => {
      assert.equal(resumed.publication.phase, 'project_synchronized')
      assert.equal(resumed.publication.id, crashed.publication.id)
      assert.equal(resumed.publication.commit_sha, scenario.commit)
      const drafts = adopted.pull_requests.filter(pr => pr.headRefName === scenario.branch)
      assert.equal(drafts.length, 1); assert.equal(drafts[0].isDraft, true); assert.equal(drafts[0].autoMergeRequest, null)
      assert.equal(adopted.items.find(item => item.content.number === scenario.issue).status, 'In Progress')
    })
    assert.equal(await git(['--git-dir', remotePath, 'rev-list', '--count', `${setup.source_commit}..${scenario.commit}`]), '1')
    await save()
  }
  try {
    await save()
    for (const [role, endpoint] of [['server', server], ['web', web]]) {
      const owned = setup.processes[role]
      const live = await captureOwnedTestServerManifest({ root: setup.qa_root, server: endpoint,
        binary: owned.executable, pid: owned.pid, pidPath: path.join(output, `${role}-ownership.json`) })
      assert.ok(Math.abs(Date.parse(live.server_creation) - Date.parse(owned.started_utc)) <= 20)
    }
    const runner = setup.processes.runner
    await verifyOwnedTestProcess({ root: setup.qa_root, server, binary: runner.executable, requireListener: false,
      manifest: { test_owned: true, workspace: setup.qa_root, server_url: server, server: runner.pid, server_creation: runner.started_utc } })
    const before = await snapshot()
    assert.equal(before.snapshot.missions.length, 0); assert.equal(before.snapshot.runs.length, 0)
    const connected = before.runners.find(row => row.id === setup.runner_id && row.corp_id === setup.demo.corp_id && row.connected)
    assert.ok(connected && JSON.stringify(connected.capabilities).includes('active-source-checkpoint-v1'))
    report.initial_runner = connected
    assert.equal(await git(['-C', setup.source, 'rev-parse', 'HEAD']), setup.source_commit)
    assert.equal(await git(['-C', setup.source, 'status', '--porcelain']), '')
    await assert.rejects(lstat(remotePath), { code: 'ENOENT' })
    await git(['clone', '--quiet', '--bare', '--no-hardlinks', setup.source, remotePath])
    assert.equal(await git(['--git-dir', remotePath, 'symbolic-ref', '--short', 'HEAD']), 'main')
    const issues = Array.from({ length: 9 }, (_, index) => 7201 + index).map((number, index) => ({ id: `I_ACTIVE_${number}`, number,
      title: `Owned active checkpoint scenario ${index + 1}`, state: 'OPEN',
      body: '## Outcome\n\nExercise owned native source checkpoint acceptance. [active-checkpoint-credentials]\n\n## Acceptance criteria\n\n- [ ] Keep a source-bound draft without granting merge authority.\n\n## Dependencies\n\nNo blockers.\n',
      url: `https://github.com/${setup.source_repository}/issues/${number}`,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), labels: [{ name: 'factory:ready' }] }))
    await writeFile(statePath, `${JSON.stringify({ repository: setup.source_repository, canonical_repository: setup.source_repository,
      project: { id: 'PVT_ACTIVE', owner: 'acme', number: 7, title: 'Owned active checkpoints', status_field_id: 'PVTF_STATUS',
        status_options: [{ id: 'todo', name: 'Todo' }, { id: 'in-progress', name: 'In Progress' }, { id: 'in-review', name: 'In Review' }, { id: 'done', name: 'Done' }] },
      issues: Object.fromEntries(issues.map(issue => [String(issue.number), issue])),
      items: issues.map(issue => ({ id: `PVTI_${issue.number}`, status: 'Todo', content: {
        type: 'Issue', repository: setup.source_repository, number: issue.number, title: issue.title, body: issue.body, url: issue.url } })),
      pull_requests: [], branch_heads: {}, next_pr_number: 1, effect_log: [], pr_create_calls: 0, item_edits: 0 }, null, 2)}\n`, { flag: 'wx' })
    const enrollment = await request(api('/factory/publication-publishers/credentials'), {
      actor_id: setup.demo.alice_actor_id, publisher_id: 'owned-checkpoint-publisher', expires_in_seconds: 3600 })
    assert.equal(enrollment.publisher_id, 'owned-checkpoint-publisher'); assert.ok(enrollment.credential)
    secrets.push(enrollment.credential)
    credentialPath = path.join(setup.qa_root, 'credentials', 'publisher.credential')
    await writeFile(credentialPath, enrollment.credential, { flag: 'wx', mode: 0o600 })
    enrollment.credential = undefined
    const syntheticToken = `owned-fixture-${randomUUID()}`; secrets.push(syntheticToken)
    publisherEnvironment = { ...environment, GH_TOKEN: syntheticToken, ECORP_FAKE_GITHUB_EXPECT_TOKEN: syntheticToken,
      ECORP_PUBLICATION_TEST_REMOTE_URL: remotePath }
    const { chromium } = createRequire(import.meta.url)(process.env.CRONY_PLAYWRIGHT_MODULE || 'playwright')
    browser = await chromium.launch({ channel: 'msedge', headless: true, env: baseEnvironment })
    const browserContext = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: 'UTC',
      reducedMotion: 'reduce', serviceWorkers: 'block' })
    await browserContext.route('**/*', async route => {
      const req = route.request(), url = new URL(req.url()), method = req.method()
      const read = ['GET', 'HEAD', 'OPTIONS'].includes(method)
      const bootstrap = url.origin === server && method === 'POST' && url.pathname === '/api/demo/bootstrap' && url.searchParams.get('seed_crew') === 'false'
      const decision = currentScenario?.run_id && url.origin === server && method === 'POST' &&
        url.pathname === api(`/runs/${currentScenario.run_id}/verification-decision`) &&
        req.postDataJSON()?.actor_id === setup.demo.alice_actor_id && req.postDataJSON()?.approved === true
      if (![server, web].includes(url.origin) || (!read && !bootstrap && !decision)) {
        report.blocked_requests.push({ method, origin: url.origin, path: url.pathname }); await route.abort(); return
      }
      await route.continue()
    })
    page = await browserContext.newPage(); page.setDefaultTimeout(20_000)
    page.on('pageerror', error => report.page_errors.push(scrub(error.message).slice(0, 1000)))
    await page.goto(`${web}/#missions`, { waitUntil: 'networkidle' })
    await page.locator('.live-indicator.live-live').waitFor()
    await page.locator('#operator-actor').selectOption(setup.demo.alice_actor_id)
    const success = await launch(7201, 'manual-gate', true, true, true)
    await checkpointAndCrash(success, 'after_active_checkpoint_branch_remote')
    phase = 'passed automated checks remain a draft until the synthetic browser decision'
    await until('persisted manual verification wait', snapshot, state =>
      runs(state, success)[0]?.status === 'waiting_for_approval' &&
      runs(state, success)[0]?.verification_status === 'waiting_for_approval')
    // Put the real receipt on page two. A different author can copy its entire
    // payload; that must not replace the authenticated publisher's receipt.
    const beforeRefresh = await readFake(), firstPr = remoteFor(beforeRefresh, success)
    success.initial_pr = structuredClone(firstPr)
    const originalComments = beforeRefresh.pull_request_comments[firstPr.number]
    assert.ok(originalComments.length > 0)
    beforeRefresh.pull_request_comments[firstPr.number] = [
      ...Array.from({ length: 100 }, (_, index) => ({ id: 8_000_000 + index, node_id: `IC_COLLAB_${index}`,
        html_url: `${firstPr.url}#issuecomment-${8_000_000 + index}`,
        user: { id: 72002, login: 'fixture-collaborator' },
        body: index === 0 ? originalComments[0].body : `Retained collaborator note ${index}\r\n` })),
      ...originalComments,
    ]
    beforeRefresh.fail_pr_comment_after_success = true
    await writeFake(beforeRefresh)
    await publish(success)
    let observed = await context(success), fake = await readFake()
    check('Automated verification refresh preserves the pending manual gate and draft authority', () => {
      assert.match(observed.publication.body, /\| Complete immutable verification policy \| passed \|/u)
      assert.match(observed.publication.body, /\| Persisted manual verification gate \| pending \|/u)
      assert.equal(fake.pull_requests[0].isDraft, true)
      assert.equal(fake.pr_comment_external_success_failures, 1)
      assert.equal(observed.publication.pull_request.evidence_comment.author_id, 72001)
      assert.ok(fake.comment_list_pages.some(page => page.number === firstPr.number && page.page === 2))
      assert.equal(fake.pr_edit_calls ?? 0, 0)
      assert.equal(fake.pull_requests[0].title, firstPr.title)
      assert.equal(fake.pull_requests[0].body, firstPr.body)
    })
    await showMission(success)
    const accepted = page.waitForResponse(response => response.url() === server + api(`/runs/${success.run_id}/verification-decision`) && response.request().method() === 'POST')
    await page.locator(`[data-review-run-id="${success.run_id}"]`).getByRole('button', { name: 'Accept evidence', exact: true }).click()
    const acceptedResponse = await accepted; assert.equal(acceptedResponse.status(), 200)
    success.fixture_decision = { kind: 'synthetic development owner through actual Edge', run_id: success.run_id,
      actor_id: setup.demo.alice_actor_id, response: await acceptedResponse.json(), human_decision: false }
    await until('accepted run completion', snapshot, state => runs(state, success)[0]?.status === 'completed')
    const refresh = await command('factory-refresh', binary, factoryArgs(success), environment)
    success.refresh = JSON.parse(refresh.stdout)
    await publish(success)
    observed = await context(success)
    check('Persisted decision refreshes the same draft without promoting it', () => {
      assert.match(observed.publication.body, /\| Persisted manual verification gate \| approved \|/u)
      assert.equal(observed.publication.pull_request.draft, true)
    })
    phase = 'separate final publisher adopts the checkpoint'
    const final = await command('final-publisher', binary, finalArgs(success), publisherEnvironment)
    success.final = JSON.parse(final.stdout)
    fake = await readFake(); observed = await context(success)
    check('Final publication reuses one branch, commit and PR and alone moves the Project into review', () => {
      assert.equal(fake.pull_requests.length, 1); assert.equal(fake.pr_create_calls, 1)
      assert.equal(fake.pull_requests[0].isDraft, false); assert.equal(fake.pull_requests[0].autoMergeRequest, null)
      assert.equal(fake.pull_requests[0].headRefOid, success.commit)
      assert.equal(fake.items.find(item => item.content.number === success.issue).status, 'In Review')
      assert.equal(observed.final_publication_started, true)
      assert.equal(fake.pull_requests[0].state, 'OPEN')
    })
    const afterFinal = await publish(success)
    assert.equal(JSON.parse(afterFinal.stdout).status, 'final_publication_owns_branch')
    const acceptedPublication = await finalPublication(success)
    const acceptedEffects = draftEffects(await readFake(), success)
    await promote(success)
    check('An accepted readiness intent is never compensated by a restarted final publisher', () => {
      assert.equal(acceptedPublication.provenance.active_checkpoint_readiness.state, 'accepted')
      assert.equal(acceptedPublication.provenance.active_checkpoint_readiness.ready_succeeded, true)
      assert.deepEqual(acceptedPublication.provenance.active_checkpoint_readiness.undo, [])
      assert.equal(acceptedEffects.filter(effect => effect.is_draft === true).length, 0)
    })
    assert.deepEqual(draftEffects(await readFake(), success), acceptedEffects)
    assert.equal(await git(['--git-dir', remotePath, 'rev-list', '--count', `${setup.source_commit}..refs/heads/${success.branch}`]), '1')
    await showMission(success); await screenshot('manual-gate-final'); await save()
    const failure = await launch(7202, 'full-failure', true, false, false)
    await checkpointAndCrash(failure, 'after_active_checkpoint_draft_remote')
    phase = 'failed full validation is truthful and cannot promote the durable draft'
    await until('full verification failure', snapshot, state => runs(state, failure)[0]?.status === 'failed')
    await command('factory-failed-refresh', binary, factoryArgs(failure), environment, [0, 1])
    await publish(failure)
    observed = await context(failure); fake = await readFake()
    check('Failed immutable policy refresh keeps one preserved draft and In Progress status', () => {
      assert.match(observed.publication.body, /\| Complete immutable verification policy \| failed \|/u)
      assert.match(observed.publication.body, /\| 1 \(file\) \| failed \|/u)
      assert.equal(fake.pull_requests.filter(pr => pr.headRefName === failure.branch).length, 1)
      assert.equal(fake.pull_requests.find(pr => pr.headRefName === failure.branch).isDraft, true)
      assert.equal(fake.items.find(item => item.content.number === failure.issue).status, 'In Progress')
    })
    await command('final-publisher-rejected', binary, finalArgs(failure), publisherEnvironment, [1])
    const failedRun = runs(await snapshot(), failure)[0]
    check('Failed run source remains preserved', () => {
      assert.equal(failedRun.workspace_disposition, 'preserved'); assert.ok(contains(setup.qa_root, failedRun.workspace_path))
    })
    assert.equal(await git(['-C', failedRun.workspace_path, 'rev-parse', 'HEAD']), failure.commit)
    await showMission(failure); await screenshot('full-failure-draft'); await save()
    const focused = await launch(7203, 'focused-failure', false, true, false)
    phase = 'failed focused gate preserves uncommitted work without remote effects'
    await until('focused verification failure', snapshot, state => runs(state, focused)[0]?.status === 'failed')
    observed = await context(focused); const focusedRun = runs(await snapshot(), focused)[0]
    await publish(focused); fake = await readFake()
    check('Failed focused gate produces no checkpoint or third PR and retains its dirty workspace', () => {
      assert.equal(observed.artifacts.length, 0); assert.equal(observed.publication, null)
      assert.equal(fake.pull_requests.length, 2); assert.equal(fake.pr_create_calls, 2)
      assert.equal(focusedRun.workspace_disposition, 'preserved'); assert.ok(contains(setup.qa_root, focusedRun.workspace_path))
    })
    assert.equal(await git(['-C', focusedRun.workspace_path, 'rev-parse', 'HEAD']), setup.source_commit)
    assert.notEqual(await git(['-C', focusedRun.workspace_path, 'status', '--porcelain']), '')
    await showMission(focused); await screenshot('focused-failure-preserved')

    const editRace = await completedDraft(7204, 'concurrent-comment-edit')
    phase = 'collaborator text changes during native comment append'
    fake = await readFake()
    const collaboratorText = { title: 'Collaborator review title', body: 'Keep these review notes.\r\nRésumé 🚀\n' }
    fake.pr_comment_mutation = { number: editRace.initial_pr.number, patch: collaboratorText }
    await writeFake(fake)
    await promote(editRace, [1])
    fake = await readFake()
    const editPublication = await finalPublication(editRace)
    check('Concurrent comment publication preserves collaborator bytes and cannot promote', () => {
      assert.equal(remoteFor(fake, editRace).title, collaboratorText.title)
      assert.equal(remoteFor(fake, editRace).body, collaboratorText.body)
      assert.equal(remoteFor(fake, editRace).isDraft, true)
      assert.deepEqual(draftEffects(fake, editRace), [])
      assert.equal(editPublication.provenance.active_checkpoint_readiness ?? null, null)
      assert.equal(fake.items.find(item => item.content.number === editRace.issue).status, 'In Progress')
      assert.equal(fake.pr_edit_calls ?? 0, 0)
    })
    // The fixture collaborator explicitly restores their own text so the same
    // contribution can finish. The product never edits that shared surface.
    Object.assign(remoteFor(fake, editRace), { title: editRace.initial_pr.title, body: editRace.initial_pr.body })
    await writeFake(fake)
    await promote(editRace)
    assert.equal(remoteFor(await readFake(), editRace).isDraft, false)
    await showMission(editRace); await screenshot('concurrent-comment-edit-recovered')

    const readyRace = await completedDraft(7205, 'concurrent-ready-change')
    phase = 'native ready changes source and shared text before its success response'
    fake = await readFake()
    const changedReady = { headRefOid: 'b'.repeat(40), title: 'Concurrent ready title', body: 'Retained concurrent body\r\n' }
    fake.pr_ready_mutation = { number: readyRace.initial_pr.number, patch: changedReady }
    await writeFake(fake)
    await promote(readyRace, [1])
    let recovery = await assertUnacceptedDraft(readyRace, 'compensated', true, 1)
    check('Successful native ready is durably undone without overwriting changed source or text', () => {
      for (const [key, value] of Object.entries(changedReady)) assert.equal(recovery.remote[key], value)
      assert.equal(recovery.journal.undo[0].succeeded, true)
      assert.deepEqual(draftEffects(recovery.fake, readyRace).map(effect => effect.is_draft), [false, true])
    })
    await promote(readyRace, [1])
    assert.deepEqual(draftEffects(await readFake(), readyRace), draftEffects(recovery.fake, readyRace))
    await showMission(readyRace); await screenshot('concurrent-ready-change-compensated')

    const crash = await completedDraft(7206, 'acknowledged-ready-crash')
    phase = 'process crash after durable successful ready acknowledgement'
    await promote(crash, [86], 'after_checkpoint_ready_remote')
    let crashedFinal = await finalPublication(crash)
    check('An acknowledged remote ready is still unaccepted across a publisher crash', () => {
      assert.equal(crashedFinal.state, 'branch_pushed')
      assert.equal(crashedFinal.provenance.active_checkpoint_readiness.state, 'prepared')
      assert.equal(crashedFinal.provenance.active_checkpoint_readiness.ready_succeeded, true)
    })
    assert.equal(remoteFor(await readFake(), crash).isDraft, false)
    await waitForPublicationLease(crash)
    // A vanished forward-only input must not skip recovery of the old effect.
    const missingBody = path.join(output, 'absent-forward-body.md')
    await assert.rejects(lstat(missingBody), { code: 'ENOENT' })
    const repairedBeforePlan = await command('restart-repairs-before-invalid-input', binary,
      [...finalArgs(crash), '--body-file', missingBody], publisherEnvironment, [1])
    assert.match(repairedBeforePlan.stderr, /body file does not exist/u)
    await assertUnacceptedDraft(crash, 'compensated', true, 1)
    await promote(crash)
    fake = await readFake()
    const repairedPublication = await finalPublication(crash)
    check('The repaired contribution can finish with its original PR and source', () => {
      const repairedPr = remoteFor(fake, crash)
      assert.equal(repairedPr.number, crash.initial_pr.number)
      assert.equal(repairedPr.id, crash.initial_pr.id)
      assert.equal(repairedPr.headRefOid, crash.commit)
      assert.equal(repairedPr.isDraft, false)
      assert.equal(repairedPublication.provenance.active_checkpoint_readiness.state, 'accepted')
      assert.equal(fake.items.find(item => item.content.number === crash.issue).status, 'In Review')
    })
    await showMission(crash); await screenshot('acknowledged-ready-crash-recovered')

    const delayed = await completedDraft(7207, 'delayed-unknown-ready')
    phase = 'native failure followed by a delayed GitHub ready effect'
    fake = await readFake(); fake.defer_next_pr_ready = { undo: false, after_views: 2 }; await writeFake(fake)
    await promote(delayed, [1])
    recovery = await assertUnacceptedDraft(delayed, 'recovering', false, 0)
    assert.ok(recovery.fake.deferred_draft_effect, 'The first draft observation precedes the pending provider effect')
    await promote(delayed, [1])
    recovery = await assertUnacceptedDraft(delayed, 'recovering', false, 1)
    check('A later ready effect is undone, but the unknown original command never grants retry authority', () => {
      assert.equal(recovery.journal.undo[0].succeeded, true)
      assert.equal(draftEffects(recovery.fake, delayed).filter(effect => effect.delayed).length, 1)
      assert.equal(recovery.fake.pr_ready_deferred_calls, 1)
    })
    await promote(delayed, [1])
    assert.deepEqual(draftEffects(await readFake(), delayed), draftEffects(recovery.fake, delayed))
    await showMission(delayed); await screenshot('delayed-unknown-ready-blocked')

    const unknownUndo = await completedDraft(7208, 'unknown-undo-response')
    phase = 'native undo succeeds remotely but its success response is lost'
    fake = await readFake()
    fake.pr_ready_mutation = { number: unknownUndo.initial_pr.number, patch: { body: 'Keep this changed body.\n' } }
    fake.fail_pr_undo_after_success = true
    await writeFake(fake)
    await promote(unknownUndo, [1])
    recovery = await assertUnacceptedDraft(unknownUndo, 'recovering', true, 1)
    check('An observed draft never invents an acknowledgement for a lost undo response', () => {
      assert.equal(recovery.journal.undo[0].succeeded, false)
      assert.equal(recovery.remote.body, 'Keep this changed body.\n')
    })
    await promote(unknownUndo, [1])
    assert.deepEqual(draftEffects(await readFake(), unknownUndo), draftEffects(recovery.fake, unknownUndo))
    await showMission(unknownUndo); await screenshot('unknown-undo-response-blocked')

    const unacknowledged = await completedDraft(7209, 'unacknowledged-ready-crash')
    phase = 'process crash after remote ready and before durable acknowledgement'
    await promote(unacknowledged, [86], 'after_checkpoint_ready_unacknowledged')
    crashedFinal = await finalPublication(unacknowledged)
    assert.equal(crashedFinal.provenance.active_checkpoint_readiness.ready_succeeded, false)
    assert.equal(remoteFor(await readFake(), unacknowledged).isDraft, false)
    await waitForPublicationLease(unacknowledged)
    await promote(unacknowledged, [1])
    recovery = await assertUnacceptedDraft(unacknowledged, 'recovering', false, 1)
    await promote(unacknowledged, [1])
    assert.deepEqual(draftEffects(await readFake(), unacknowledged), draftEffects(recovery.fake, unacknowledged))
    await showMission(unacknowledged); await screenshot('unacknowledged-ready-crash-blocked')

    const finalState = await snapshot()
    check('Fixture is bounded and leaves the configured source and native base unchanged', () => {
      assert.equal(finalState.snapshot.missions.length, 9); assert.equal(finalState.snapshot.runs.length, 9)
      assert.deepEqual(report.page_errors, []); assert.deepEqual(report.blocked_requests, [])
    })
    fake = await readFake()
    check('All scenarios keep one PR and one commit per successful checkpoint without PR body edits or merges', () => {
      assert.equal(fake.pull_requests.length, 8); assert.equal(fake.pr_create_calls, 8)
      assert.equal(fake.pr_edit_calls ?? 0, 0)
      assert.ok(fake.pull_requests.every(pr => pr.state === 'OPEN' && pr.autoMergeRequest === null))
    })
    for (const scenario of report.scenarios.filter(item => item.commit)) {
      assert.equal(await git(['--git-dir', remotePath, 'rev-list', '--count', `${setup.source_commit}..refs/heads/${scenario.branch}`]), '1')
    }
    assert.equal(await git(['-C', setup.source, 'rev-parse', 'HEAD']), setup.source_commit)
    assert.equal(await git(['-C', setup.source, 'status', '--porcelain']), '')
    assert.equal(await git(['--git-dir', remotePath, 'rev-parse', 'refs/heads/main']), setup.source_commit)
    report.final_remote_state = await readFake(); report.status = 'passed'
  } catch (error) {
    report.status = 'failed'; report.failed_phase = phase; report.error = scrub(error.message).slice(0, 3000)
    if (page) await screenshot('failed-phase').catch(() => {})
    report.failure_stops = []
    try {
      const state = await snapshot()
      for (const scenario of report.scenarios.filter(item => item.mission_id)) {
        for (const run of runs(state, scenario).filter(run => !terminal(run))) {
          const fresh = await snapshot()
          if (terminal(fresh.snapshot.runs.find(row => row.id === run.id))) continue
          const agent = fresh.snapshot.agents.find(row => row.id === run.agent_id)
          assert.equal(agent?.current_run_id, run.id, 'Do not stop another run lease')
          report.failure_stops.push({ run_id: run.id, response: await request(api(`/agents/${run.agent_id}/emergency-stop`), {
            actor_id: setup.demo.alice_actor_id, reason: 'Owned active-checkpoint fixture failed; stop this exact run.' }) })
        }
      }
      if (report.failure_stops.length) await until('exact owned failure stops', snapshot,
        state => report.failure_stops.every(stop => terminal(state.snapshot.runs.find(run => run.id === stop.run_id))))
    } catch (cleanupError) { report.failure_stop_error = scrub(cleanupError.message).slice(0, 1000) }
  } finally {
    if (lastState) report.final_snapshot = lastState
    if (browser) await browser.close().catch(error => { report.status = 'failed'; report.browser_close_error = scrub(error.message) })
    report.finished_at = new Date().toISOString()
    report.counts = { passed: report.checks.filter(item => item.passed).length, failed: report.checks.filter(item => !item.passed).length }
    await save()
    publisherEnvironment = undefined; secrets.fill(''); secrets.length = 0
    console.log(JSON.stringify({ status: report.status, counts: report.counts, report: reportPath,
      failed_phase: report.failed_phase, error: report.error }))
  }
  return report
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const report = await runCheckpointAcceptance(process.env.ECORP_ACTIVE_CHECKPOINT_SETUP, process.env.ECORP_ACTIVE_CHECKPOINT_TEST)
  process.exitCode = report.status === 'passed' ? 0 : 1
}
