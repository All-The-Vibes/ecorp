// Begin after the final restart, then read back runtime, archive and browser in that order.
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFile, writeFile, mkdir, copyFile, readdir } from 'node:fs/promises'
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const root = "C:\\Users\\shyamsridhar\\code\\ecorp-pr293-completion-20260922"
export const output = path.join(root, 'output', 'native-qualification', 'phase2-r5')
export const reportFiles = {
  runtime: 'runtime-qualification.json', browser: 'browser-qualification.json',
  archive: 'github-archive-qualification.json',
}
const currentPath = path.join(output, 'current-attempt.json')
const lockPath = path.join(output, 'active-attempt.lock')
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const json = (value) => `${JSON.stringify(value, null, 2)}\n`
const load = async (file) => JSON.parse(await readFile(file, 'utf8'))
const optional = async (file) => {
  try { return await load(file) } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

function acquireLock(purpose, beforeRelease = () => {}) {
  const claim = { purpose, pid: process.pid, nonce: randomUUID() }
  writeFileSync(lockPath, json(claim), { flag: 'wx' })
  let owned = true
  const release = () => {
    if (!owned) return
    assert.deepEqual(JSON.parse(readFileSync(lockPath, 'utf8')), claim, 'Evidence lock ownership changed')
    unlinkSync(lockPath)
    owned = false
  }
  process.once('exit', (code) => { try { beforeRelease(code) } finally { release() } })
  return release
}

// Held through both checks and acceptance emission; competing invocations are not admitted.
export function lockAcceptance() { return acquireLock('acceptance') }

export async function sourceIdentity(sourceRoot) {
  const git = (args) => execFileSync('git', args, { cwd: sourceRoot, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).trim()
  // Include all Git source inputs; runtime evidence and build output are not source.
  const paths = git(['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--',
    ':(top,exclude)output', ':(top,exclude)target-native-qualification'])
    .split('\0').filter(Boolean)
  const source_files = []
  for (const file of [...new Set(paths)].sort()) {
    const bytes = await readFile(path.join(sourceRoot, file))
    source_files.push({ path: file.replaceAll('/', '\\'), sha256: hash(bytes), bytes: bytes.length })
  }
  return source_files
}

export async function identity() {
  const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).trim()
  const source_files = await sourceIdentity(root)
  const binaries = []
  for (const name of ['crony-server', 'crony-base-worker', 'crony-runner', 'crony-cli', 'crony-native-fixture']) {
    const bytes = await readFile(path.join(root, 'target-native-qualification', 'debug', `${name}.exe`))
    binaries.push({ name, sha256: hash(bytes), bytes: bytes.length })
  }
  const processes = (await load(path.join(output, 'processes.json'))).processes
  execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command',
    "$ErrorActionPreference='Stop'; Import-Module .\\tools\\local_stack.psm1 -Force; " +
    "$s=Get-Content .\\output\\native-qualification\\phase2-r5\\processes.json -Raw | ConvertFrom-Json -AsHashtable; " +
    "foreach($role in @('server','runner','gateway','github','web','anvilNode')) { " +
    "if (!(Test-LocalOwnedProcess -Record $s.processes[$role] -Workspace (Get-Location).Path)) { throw 'Owned runtime identity is not live' } }"],
  { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 })
  const proxy = await optional(path.join(output, '..', 'phase3-runtime', 'rpc-process.json'))
  const supplemental = await optional(path.join(output, '..', 'phase3-runtime', 'acceptance.json'))
  const value = { base_commit: git(['rev-parse', 'HEAD']), branch: git(['branch', '--show-current']),
    source_files, binaries, processes, proxy,
    supplemental_evidence_sha256: supplemental ? hash(json(supplemental)) : null,
    original_destination_sha256: hash(await readFile(path.join(output, 'destination.json'))) }
  return { ...value, sha256: hash(json(value)) }
}

export async function beginAttempt() {
  const release = acquireLock('begin')
  const attempt_id = randomUUID()
  const directory = path.join(output, 'attempts', attempt_id)
  await mkdir(path.join(directory, 'historical'), { recursive: true })
  const preserved = []
  for (const file of [...Object.values(reportFiles), 'acceptance.json', 'current-attempt.json',
    'github-native-archive.json', 'github-archive-restart-readback.json', 'retained-finality-headers.json']) {
    const source = path.join(output, file)
    try {
      await copyFile(source, path.join(directory, 'historical', file), 1)
      preserved.push({ file, sha256: hash(await readFile(source)) })
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  const boundIdentity = await identity()
  const supplemental = await optional(path.join(output, '..', 'phase3-runtime', 'acceptance.json'))
  assert.equal(supplemental ? hash(json(supplemental)) : null, boundIdentity.supplemental_evidence_sha256)
  if (supplemental) await writeFile(path.join(directory, 'supplemental-acceptance.json'), json(supplemental), { flag: 'wx' })
  const current = { schema_version: 1, attempt_id, started_at: new Date().toISOString(),
    scope: 'New readback of retained original execution and supplemental state, not re-execution of historical lanes.',
    identity: boundIdentity, preserved,
    surfaces: Object.fromEntries(Object.keys(reportFiles).map((name) => [name, { status: 'pending' }])) }
  await writeFile(path.join(directory, 'attempt.json'), json(current), { flag: 'wx' })
  await writeFile(currentPath, json(current))
  release()
  return current
}

export function validateReports(current, observedIdentity, reports) {
  assert.ok(current?.attempt_id && current.identity?.sha256, 'Begin a current qualification attempt first')
  assert.equal(current.identity.sha256, observedIdentity.sha256, 'Source/binary/process identity changed during readback')
  for (const name of Object.keys(reportFiles)) {
    const report = reports[name]
    const marker = current.surfaces[name]
    assert.equal(marker?.status, 'succeeded', `Current ${name} attempt did not succeed`)
    assert.ok(report && !Object.hasOwn(report, 'failure') && !Object.hasOwn(report, 'error'),
      `Current ${name} report contains failure`)
    assert.equal(report.current_attempt?.attempt_id, current.attempt_id, `${name} attempt mismatch`)
    assert.equal(report.current_attempt?.identity_sha256, current.identity.sha256, `${name} identity mismatch`)
    assert.equal(report.current_attempt?.status, 'succeeded', `${name} report incomplete`)
    assert.equal(marker.report_sha256, hash(json(report)), `${name} report changed after success`)
    if (name === 'archive') assert.equal(report.complete, true)
    else assert.equal(report.phase, 'readback_complete')
  }
}

export async function requireCurrentReports() {
  const claim = JSON.parse(readFileSync(lockPath, 'utf8'))
  assert.equal(claim.pid, process.pid)
  assert.equal(claim.purpose, 'acceptance', 'Acceptance must hold its exclusive lock through emission')
  const observedIdentity = await identity()
  const current = await load(currentPath)
  const files = await readdir(path.join(output, 'attempts', current.attempt_id))
  assert.ok(!files.some((file) => file.startsWith('invocation-failure-')), 'Current attempt contains a rejected/failed invocation')
  const reports = {}
  for (const [name, file] of Object.entries(reportFiles)) reports[name] = await load(path.join(output, file))
  validateReports(current, observedIdentity, reports)
  return { current, reports }
}

export async function startSurface(name) {
  assert.ok(Object.hasOwn(reportFiles, name))
  let onExit = () => {}
  acquireLock(`surface-${name}`, (code) => onExit(code))
  const current = await load(currentPath)
  const previousStatus = current.surfaces[name]?.status
  current.surfaces[name] = { status: 'running', started_at: new Date().toISOString() }
  await writeFile(currentPath, json(current))
  let finished = false
  // Covers failures before a harness loads its report, caught failures, and failures during browser cleanup.
  const fail = () => {
    const latest = JSON.parse(readFileSync(currentPath, 'utf8'))
    assert.equal(latest.attempt_id, current.attempt_id, 'Concurrent qualification attempts are prohibited')
    latest.surfaces[name] = { ...latest.surfaces[name], status: 'failed', finished_at: new Date().toISOString(),
      reason: 'Current process failed or did not finish its readback; no completion claimed.' }
    writeFileSync(currentPath, json(latest))
    writeFileSync(path.join(output, 'attempts', current.attempt_id, `${name}-failure.json`), json(latest.surfaces[name]))
  }
  process.once('uncaughtExceptionMonitor', fail)
  onExit = (code) => {
    if (code !== 0 || !finished) fail()
  }
  assert.equal(previousStatus, 'pending', 'Each surface runs once; begin a new attempt before retrying')
  assert.equal(current.identity.sha256, (await identity()).sha256, 'Attempt source/binary/process identity mismatch')
  const stamp = { attempt_id: current.attempt_id, identity_sha256: current.identity.sha256, status: 'running' }
  return {
    prepare(report) {
      if (Object.hasOwn(report, 'failure')) {
        report.retained_failures = [...(report.retained_failures ?? []), report.failure]
        delete report.failure
      }
      report.current_attempt = { ...stamp }
    },
    async succeed(report) {
      assert.ok(!Object.hasOwn(report, 'failure') && !Object.hasOwn(report, 'error'), 'Failure-bearing reports cannot pass')
      assert.equal(current.identity.sha256, (await identity()).sha256, 'Source/binary/process changed before completion')
      report.current_attempt = { ...stamp, status: 'succeeded', finished_at: new Date().toISOString() }
      const bytes = json(report)
      await writeFile(path.join(output, 'attempts', current.attempt_id, reportFiles[name]), bytes, { flag: 'wx' })
      await writeFile(path.join(output, reportFiles[name]), bytes)
      const latest = await load(currentPath)
      assert.equal(latest.attempt_id, current.attempt_id)
      assert.equal(latest.surfaces[name].status, 'running')
      latest.surfaces[name] = { ...latest.surfaces[name], status: 'succeeded',
        report_sha256: hash(bytes), finished_at: report.current_attempt.finished_at }
      await writeFile(currentPath, json(latest))
      finished = true
    },
  }
}

export async function supplementalState() {
  const current = await load(currentPath)
  if (current.identity.supplemental_evidence_sha256 === null) return null
  const snapshot = await load(path.join(output, 'attempts', current.attempt_id, 'supplemental-acceptance.json'))
  assert.equal(hash(json(snapshot)), current.identity.supplemental_evidence_sha256, 'Supplemental evidence snapshot changed')
  return snapshot
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv[2], '--begin')
  const current = await beginAttempt()
  console.log(JSON.stringify({ attempt_id: current.attempt_id, identity_sha256: current.identity.sha256,
    next: 'Run runtime --phase readback, archive, then browser --phase readback. Require all three current reports before emitting acceptance. No source or runtime restarts between commands.' }))
}
