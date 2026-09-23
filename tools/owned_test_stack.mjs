import { execFile as execFileCallback, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  closeSync, existsSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync,
  renameSync, unlinkSync, writeFileSync,
} from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { promisify } from 'node:util'

const execFile = promisify(execFileCallback)
const refusal = 'QA process ownership changed or is unverifiable; refusing server restart.'
const manualPorts = new Set(['5432', '54329', '8791', '8793', '5187', '5291', '15191', '15193'])
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))

function nativeCreationTicks(value) {
  return typeof value === 'string' && /^[1-9][0-9]{0,18}$/u.test(value) &&
    BigInt(value) <= 3155378975999999999n
}

export function assertTestEndpoint(server) {
  const endpoint = new URL(server)
  if (endpoint.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname) ||
    !endpoint.port || manualPorts.has(endpoint.port) ||
    endpoint.pathname !== '/' || endpoint.search || endpoint.hash || endpoint.username || endpoint.password) {
    throw new Error(refusal)
  }
  return endpoint
}

function assertOwnedProcessIdentity(manifest, identity, { root, server, binary, platform = process.platform }) {
  assertTestEndpoint(server)
  const paths = platform === 'win32' ? path.win32 : path.posix
  const samePath = (left, right) => typeof left === 'string' && typeof right === 'string' &&
    (platform === 'win32'
      ? paths.resolve(left).toLowerCase() === paths.resolve(right).toLowerCase()
      : paths.resolve(left) === paths.resolve(right))
  if (!manifest || !identity || !['win32', 'linux'].includes(platform) ||
    manifest.test_owned !== true || manifest.server_url !== server ||
    !samePath(manifest.workspace, root) ||
    !Number.isSafeInteger(manifest.server) || manifest.server <= 1 ||
    identity.pid !== manifest.server || identity.platform !== platform ||
    !Number.isFinite(Date.parse(manifest.server_creation)) ||
    !Number.isFinite(Date.parse(identity.creation)) ||
    !samePath(identity.executable, binary) ||
    Math.abs(Date.parse(identity.creation) - Date.parse(manifest.server_creation)) > 20 ||
    (manifest.server_state !== undefined && manifest.server_state !== 'running')) {
    throw new Error(refusal)
  }
  if (platform === 'linux') {
    // Wall-clock timestamps alone are not process identity. Match boot ID and
    // kernel start ticks exactly, and never case-fold a Linux executable path.
    const recorded = manifest.server_identity
    const fields = ['platform', 'pid', 'executable', 'cwd', 'uid', 'creation',
      'boot_id', 'start_ticks', 'network_namespace']
    if (!recorded || fields.some(field => recorded[field] !== identity[field]) ||
      !samePath(identity.cwd, root) || !Number.isSafeInteger(identity.uid) || identity.uid < 0 ||
      !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(identity.boot_id ?? '') ||
      !/^[0-9]+$/u.test(identity.start_ticks ?? '') || !/^net:\[[0-9]+\]$/u.test(identity.network_namespace ?? '')) {
      throw new Error(refusal)
    }
  }
  if (platform === 'win32' && manifest.server_identity !== undefined) {
    // New receipts bind the exact 100 ns native identity, not Date.parse's
    // millisecond precision or CIM's truncated microsecond timestamp. Keep
    // ISO-only legacy manifests compatible, but never downgrade a new receipt.
    const recorded = manifest.server_identity?.native_creation_ticks
    if (!nativeCreationTicks(recorded) || !nativeCreationTicks(identity.native_creation_ticks) ||
      recorded !== identity.native_creation_ticks) throw new Error(refusal)
  }
}

export function assertOwnedRestart(manifest, identity, context) {
  assertOwnedProcessIdentity(manifest, identity, context)
  if (identity.port_owned !== true ||
    (identity.port !== undefined && identity.port !== Number(new URL(context.server).port))) throw new Error(refusal)
}

// Read-only admission for an existing QA server or outbound runner. This never
// writes a manifest or sends a signal. Outbound runners claim no listener.
export async function verifyOwnedTestProcess({ root, server, binary, manifest, requireListener = true }) {
  if (![root, binary].every(value => typeof value === 'string' && path.isAbsolute(value)) ||
    typeof requireListener !== 'boolean') throw new Error(refusal)
  assertTestEndpoint(server)
  const context = { root: realpathSync(root), server, binary: realpathSync(binary) }
  const identity = await serverIdentity(manifest?.server, context)
  if (requireListener) assertOwnedRestart(manifest, identity, context)
  else assertOwnedProcessIdentity(manifest, identity, context)
}

async function linuxProcess(request) {
  // CPython's stdlib exposes pidfd_open/pidfd_send_signal; Node 22 does not.
  // No shell, environment dump, credential argument, or numeric kill fallback.
  const operation = execFile('python3', ['-B', path.join(import.meta.dirname, 'owned_test_process_linux.py')], {
    timeout: 40_000, maxBuffer: 64 * 1024, windowsHide: true,
  })
  operation.child.stdin.end(JSON.stringify(request))
  const { stdout } = await operation
  return JSON.parse(stdout)
}

export async function serverIdentity(pid, context) {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error(refusal)
  const endpoint = assertTestEndpoint(context.server)
  if (process.platform === 'linux') {
    return linuxProcess({ action: 'inspect', pid, root: context.root, server: context.server, binary: context.binary })
  }
  if (process.platform !== 'win32') throw new Error('Owned test process receipts are supported only on Windows and Linux.')
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '$processId = [int]$env:ECORP_QA_PROCESS_ID',
    '$port = [int]$env:ECORP_QA_PROCESS_PORT',
    '$process = Get-Process -Id $processId -ErrorAction Stop',
    'try {',
    '[void]$process.Handle',
    "if ($process.HasExited) { throw 'Recorded QA server is absent' }",
    '$listeners = @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)',
    "if ($process.HasExited) { throw 'Recorded QA server exited during verification' }",
    '$creation = $process.StartTime.ToUniversalTime()',
    "@{ platform='win32'; pid=$processId; executable=$process.Path; creation=$creation.ToString('o'); native_creation_ticks=$creation.Ticks.ToString();",
    'port_owned=[bool]($listeners | Where-Object OwningProcess -eq $processId) } | ConvertTo-Json -Compress',
    '} finally { $process.Dispose() }',
  ].join('\n')
  const { stdout } = await execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true, timeout: 20_000,
    env: { ...process.env, ECORP_QA_PROCESS_ID: String(pid), ECORP_QA_PROCESS_PORT: endpoint.port },
  })
  return JSON.parse(stdout)
}

// Read-only compatibility entry points used by the browser and operation
// evidence drivers. Capturing a receipt never starts or stops a process.
export function parseOwnedTestServerManifest(text, { root, server, binary, platform = process.platform }) {
  try {
    assertTestEndpoint(server)
    const paths = platform === 'win32' ? path.win32 : path.posix
    const normalize = value => {
      if (typeof value !== 'string' || !paths.isAbsolute(value)) throw new Error(refusal)
      return platform === 'win32' ? paths.resolve(value).toLowerCase() : paths.resolve(value)
    }
    if (!['win32', 'linux'].includes(platform) || typeof text !== 'string' || text.length > 16_384) throw new Error(refusal)
    const manifest = JSON.parse(text)
    if (!manifest || Array.isArray(manifest) || manifest.test_owned !== true ||
        manifest.server_url !== server || normalize(manifest.workspace) !== normalize(root) ||
        !Number.isSafeInteger(manifest.server) || manifest.server <= 1 ||
        (manifest.platform !== undefined && manifest.platform !== platform)) throw new Error(refusal)
    normalize(binary)
    if (manifest.server_identity !== undefined) {
      assertOwnedRestart(manifest, manifest.server_identity, { root, server, binary, platform })
      return manifest
    }
    if (platform === 'win32') {
      if (typeof manifest.server_creation !== 'string' || !Number.isFinite(Date.parse(manifest.server_creation))) throw new Error(refusal)
    } else if (manifest.platform !== 'linux' ||
        !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(manifest.server_boot_id ?? '') ||
        !/^[0-9]{1,20}$/u.test(manifest.server_start_ticks ?? '') ||
        BigInt(manifest.server_start_ticks) > 18446744073709551615n ||
        normalize(manifest.server_executable) !== normalize(binary)) throw new Error(refusal)
    return manifest
  } catch { throw new Error(refusal) }
}

export async function captureOwnedTestServerManifest({ root, server, binary, pidPath, pid }) {
  if (![root, binary, pidPath].every(value => typeof value === 'string' && path.isAbsolute(value))) throw new Error(refusal)
  assertTestEndpoint(server)
  const context = { root: realpathSync(root), server, binary: realpathSync(binary) }
  const identity = await serverIdentity(pid, context)
  const manifest = { test_owned: true, workspace: context.root, server_url: server,
    platform: process.platform, server: pid, server_executable: identity.executable,
    server_creation: identity.creation, server_identity: identity, server_state: 'running',
    ...(process.platform === 'linux' ? { server_boot_id: identity.boot_id, server_start_ticks: identity.start_ticks } : {}) }
  assertOwnedRestart(manifest, identity, context)
  writeFileSync(pidPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  return manifest
}

export function ownedServerEnvironment(environment = {}, databaseUrl, inherited = process.env) {
  const bounds = { CRONY_ARTIFACT_RECOVERY_GRACE_SECS: [0, 3600], CRONY_ARTIFACT_RECOVERY_INTERVAL_SECS: [1, 3600] }
  if (!environment || Array.isArray(environment) || typeof environment !== 'object') throw new Error(refusal)
  for (const [key, value] of Object.entries(environment)) {
    if (!Object.hasOwn(bounds, key) || typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)$/u.test(value) ||
      Number(value) < bounds[key][0] || Number(value) > bounds[key][1]) throw new Error(refusal)
  }
  return { ...inherited, ...environment, DATABASE_URL: databaseUrl }
}

function options({ root, server, databaseUrl, binary = process.env.CRONY_TEST_SERVER_BINARY,
  manifestPath = process.env.CRONY_TEST_SERVER_PID_FILE, logPrefix = 'owned-server-restart',
  args = [], environment = {}, minimumRunners = 1 }) {
  if (!manifestPath || !binary || !databaseUrl || !root ||
    !path.isAbsolute(manifestPath) || !path.isAbsolute(binary) || !path.isAbsolute(root) ||
    !/^[a-z0-9-]+$/u.test(logPrefix) || !Array.isArray(args) || args.some(arg => typeof arg !== 'string') ||
    !Number.isSafeInteger(minimumRunners) || minimumRunners < 0) {
    throw new Error('Owned restart requires explicit binary, database, and JSON process manifest.')
  }
  assertTestEndpoint(server)
  ownedServerEnvironment(environment, databaseUrl, {})
  if (!['win32', 'linux'].includes(process.platform)) throw new Error('Unsupported owned test platform.')
  let database
  try { database = new URL(databaseUrl) } catch { throw new Error('Invalid PostgreSQL test database URL; its value was not disclosed.') }
  if (!['postgres:', 'postgresql:'].includes(database.protocol)) throw new Error('Expected an explicit PostgreSQL test database.')
  // SQLx query options can override the target recorded from authority/path.
  if (database.search) throw new Error('PostgreSQL test database query options are not supported; refusing lifecycle operation.')
  // Passwords are deliberately not part of persisted receipts.
  const databaseTarget = { host: database.hostname, port: database.port || '5432',
    database: database.pathname, user: database.username }
  return { root: realpathSync(root), server, binary: realpathSync(binary), databaseUrl,
    databaseTarget, manifestPath: path.resolve(manifestPath), logPrefix, args, environment, minimumRunners }
}

function readManifest(file) {
  const metadata = lstatSync(file)
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 64 * 1024) throw new Error(refusal)
  const raw = readFileSync(file, 'utf8')
  const manifest = JSON.parse(raw)
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || manifest.test_owned !== true ||
    !Number.isSafeInteger(manifest.server) || manifest.server <= 1) throw new Error(refusal)
  return { raw, manifest }
}

function unchanged(context, raw) {
  if (readManifest(context.manifestPath).raw !== raw) throw new Error('Owned process manifest changed; preserve it for inspection.')
}

async function locked(context, action) {
  const lock = `${context.manifestPath}.lock`
  const nonce = JSON.stringify({ owner_pid: process.pid, nonce: randomUUID() })
  const fd = openSync(lock, 'wx', 0o600) // Never adopt or remove a pre-existing lock.
  const owned = fstatSync(fd)
  try {
    writeFileSync(fd, nonce)
    return await action()
  } finally {
    closeSync(fd)
    if (existsSync(lock) && !lstatSync(lock).isSymbolicLink() && lstatSync(lock).ino === owned.ino &&
      readFileSync(lock, 'utf8') === nonce) unlinkSync(lock)
  }
}

function publish(context, manifest, previousRaw) {
  const raw = `${JSON.stringify(manifest, null, 2)}\n`
  if (previousRaw === undefined) {
    writeFileSync(context.manifestPath, raw, { flag: 'wx', mode: 0o600 })
  } else {
    unchanged(context, previousRaw)
    const pending = `${context.manifestPath}.next-${randomUUID()}`
    writeFileSync(pending, raw, { flag: 'wx', mode: 0o600 })
    unchanged(context, previousRaw)
    renameSync(pending, context.manifestPath)
  }
  return raw
}

async function assertPortAvailable(server) {
  const endpoint = assertTestEndpoint(server)
  const probe = net.createServer()
  await new Promise((resolve, reject) => {
    probe.once('error', reject)
    probe.listen({ host: endpoint.hostname.replace(/^\[|\]$/gu, ''), port: Number(endpoint.port), exclusive: true }, resolve)
  })
  await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()))
}

async function stopVerified(context, manifest, identity) {
  assertOwnedRestart(manifest, identity, context)
  if (process.platform === 'linux') {
    // The helper revalidates the receipt while holding the kernel process handle.
    await linuxProcess({ action: 'stop', pid: manifest.server, expected: identity,
      root: context.root, server: context.server, binary: context.binary })
    return
  }
  if (!nativeCreationTicks(identity.native_creation_ticks)) throw new Error(refusal)
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '$processId = [int]$env:ECORP_QA_PROCESS_ID',
    '$process = Get-Process -Id $processId -ErrorAction Stop',
    'try {',
    '[void]$process.Handle',
    "if ($process.HasExited) { throw 'Owned server already exited during verification' }",
    '$currentPath = [IO.Path]::GetFullPath($process.Path)',
    '$expectedPath = [IO.Path]::GetFullPath($env:ECORP_QA_PROCESS_EXE)',
    '$currentTicks = $process.StartTime.ToUniversalTime().Ticks',
    '$expectedTicks = [long]$env:ECORP_QA_PROCESS_CREATION_TICKS',
    "if (!([string]::Equals($currentPath, $expectedPath, [StringComparison]::OrdinalIgnoreCase)) -or $currentTicks -ne $expectedTicks) { throw 'QA process ownership changed or is unverifiable; refusing server restart.' }",
    '$process.Kill()',
    "if (!$process.WaitForExit(30000)) { throw 'Owned server did not exit; no replacement or force-stop was attempted.' }",
    '} finally { $process.Dispose() }',
  ].join('\n')
  await execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true, timeout: 40_000,
    env: { ...process.env, ECORP_QA_PROCESS_ID: String(manifest.server),
      ECORP_QA_PROCESS_EXE: identity.executable, ECORP_QA_PROCESS_CREATION_TICKS: identity.native_creation_ticks },
  })
}

function sameDatabase(context, manifest) {
  if (manifest.database_target && JSON.stringify(manifest.database_target) !== JSON.stringify(context.databaseTarget)) {
    throw new Error('Owned test database target changed; refusing restart.')
  }
  if (process.platform === 'linux' && !manifest.database_target) throw new Error(refusal)
}

export async function stopLaunchedChild(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return
  // Keep the original ChildProcess referenced throughout admission. Its native
  // handle (and unreaped child on Unix) is the rollback authority, not a saved
  // numeric PID or an identity query that may itself have failed.
  await new Promise((resolve, reject) => {
    const done = error => {
      clearTimeout(timer)
      child.removeListener('exit', exited)
      child.removeListener('error', failed)
      if (error) reject(error)
      else resolve()
    }
    const exited = () => done()
    const failed = () => done(new Error('Owned launch rollback failed; preserve the diagnostic receipt and logs.'))
    const timer = setTimeout(() => done(new Error('Owned launch rollback did not confirm exit within 15 seconds.')), 15_000)
    child.once('exit', exited)
    child.once('error', failed)
    try {
      if (!child.kill('SIGKILL') && child.exitCode === null && child.signalCode === null) failed()
    } catch { failed() }
  })
}

async function launch(context, previous, previousRaw) {
  // Windows can report process exit before its listening socket is released.
  // Wait only after our verified stop; never stop or adopt a different listener.
  const releaseDeadline = Date.now() + (previous ? 10_000 : 0)
  for (;;) {
    try { await assertPortAvailable(context.server); break } catch (error) {
      if (error.code !== 'EADDRINUSE' || Date.now() >= releaseDeadline) throw error
      await pause(100)
    }
  }
  if (process.platform === 'linux') await linuxProcess({ action: 'capabilities' })
  const endpoint = assertTestEndpoint(context.server)
  const logRoot = path.dirname(context.manifestPath)
  const diagnostic = openSync(`${context.manifestPath}.launch-${randomUUID()}.jsonl`, 'wx', 0o600)
  const record = entry => writeFileSync(diagnostic, `${JSON.stringify({ lifecycle_authority: false, ...entry })}\n`)
  let child, next, raw
  try {
    // This append-only diagnostic is deliberately not a lifecycle manifest. It
    // survives even when identity capture or manifest publication cannot run.
    record({ state: 'pending', server_url: context.server, workspace: context.root,
      server_binary: context.binary, previous_server_pid: previous?.server ?? null })
    let stdout, stderr
    try {
      stdout = openSync(path.join(logRoot, `${context.logPrefix}.stdout.log`), 'a', 0o600)
      stderr = openSync(path.join(logRoot, `${context.logPrefix}.stderr.log`), 'a', 0o600)
      child = spawn(context.binary, [...context.args, '--bind', `${endpoint.hostname}:${endpoint.port}`], {
        cwd: context.root, env: ownedServerEnvironment(context.environment, context.databaseUrl),
        detached: true, windowsHide: true, stdio: ['ignore', stdout, stderr],
      })
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
    } finally {
      if (stdout !== undefined) closeSync(stdout)
      if (stderr !== undefined) closeSync(stderr)
    }
    record({ state: 'spawned', observed_child_pid: child.pid })
    const alive = () => { if (child.exitCode !== null || child.signalCode !== null) throw new Error('Owned test child exited; preserve its logs.') }
    const started = await serverIdentity(child.pid, context)
    alive() // Do not record a new process that reused an already reaped child PID.
    next = { ...previous, test_owned: true, workspace: context.root, server_url: context.server,
      server: child.pid, server_binary: context.binary, server_creation: started.creation,
      server_identity: started, server_state: 'starting', database_target: context.databaseTarget }
    if (previous) {
      next.previous_server_pid = previous.server
      next.previous_server_creation = previous.server_creation
    }
    raw = publish(context, next, previousRaw)
    const deadline = Date.now() + 60_000
    while (Date.now() < deadline) {
      alive()
      let healthy = false
      try {
        const response = await fetch(`${context.server}/health`, { redirect: 'error', signal: AbortSignal.timeout(3000) })
        const health = await response.json()
        healthy = response.ok && health.status === 'ok' && Number.isSafeInteger(health.runners) && health.runners >= context.minimumRunners
      } catch { /* Only readiness is retried; ownership errors below are terminal. */ }
      if (healthy) {
        const current = await serverIdentity(child.pid, context)
        alive()
        const running = { ...next, server_state: 'running' }
        assertOwnedRestart(running, current, context)
        running.server_identity = current
        raw = publish(context, running, raw)
        record({ state: 'running', observed_child_pid: child.pid })
        child.unref() // Detach from the parent only after durable admission.
        return child.pid
      }
      await pause(200)
    }
    throw new Error('Owned server/runner did not reconnect; preserve the process manifest and logs.')
  } catch (error) {
    let rollbackError, manifestError
    try { await stopLaunchedChild(child) } catch (failure) { rollbackError = failure }
    if (!rollbackError && raw !== undefined) {
      try { publish(context, { ...next, server_state: 'stopped', launch_failed: true }, raw) }
      catch (failure) { manifestError = failure }
    }
    try {
      record({ state: rollbackError ? 'cleanup_unconfirmed' : 'failed_stopped',
        observed_child_pid: child?.pid ?? null, manifest_update_failed: Boolean(manifestError) })
    } catch { /* Preserve the original diagnostic bytes and report the failure. */ }
    if (rollbackError || manifestError) {
      throw new AggregateError([error, rollbackError, manifestError].filter(Boolean),
        'Owned server launch failed; preserve the diagnostics and inspect incomplete cleanup or publication.')
    }
    throw error
  } finally {
    closeSync(diagnostic)
  }
}

export async function startOwnedTestServer(input) {
  const context = options({ ...input, minimumRunners: input.minimumRunners ?? 0 })
  return locked(context, async () => {
    if (existsSync(context.manifestPath)) throw new Error('A process manifest already exists; refusing adoption or replacement.')
    return launch(context)
  })
}

export async function restartOwnedTestServer(input) {
  const context = options(input)
  return locked(context, async () => {
    const { manifest, raw } = readManifest(context.manifestPath)
    sameDatabase(context, manifest)
    const identity = await serverIdentity(manifest.server, context)
    assertOwnedRestart(manifest, identity, context)
    unchanged(context, raw)
    await stopVerified(context, manifest, identity)
    const stopped = { ...manifest, server_state: 'stopped' }
    const stoppedRaw = publish(context, stopped, raw)
    return launch(context, stopped, stoppedRaw)
  })
}

export async function stopOwnedTestServer(input) {
  const context = options(input)
  return locked(context, async () => {
    const { manifest, raw } = readManifest(context.manifestPath)
    sameDatabase(context, manifest)
    if (manifest.server_state === 'stopped') return false
    const identity = await serverIdentity(manifest.server, context)
    assertOwnedRestart(manifest, identity, context)
    unchanged(context, raw)
    await stopVerified(context, manifest, identity)
    publish(context, { ...manifest, server_state: 'stopped' }, raw)
    return true
  })
}
