// Numeric regressions execute the production Rust and frontend test suites.
// Web gates retain a disposable, Git-bounded copy and never edit the primary lock.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { invocationFor } from './run_checks.mjs'
import { sourceFingerprint } from './research_handoff_native.mjs'

export const MAX_TOKEN_BUDGET = 999_999_999_999_999
export const APPROVED_FEED_PREFIX = 'https://ms-feed-25.pkgs.visualstudio.com/1es-public/_packaging/npm-public/npm/registry/'
const PUBLIC_FEED_PREFIX = 'https://registry.npmjs.org/'
const root = path.resolve(import.meta.dirname, '..')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')

export function qualifyFeedLock(primary, descriptor) {
  assert.ok(Buffer.isBuffer(primary) && Buffer.isBuffer(descriptor), 'Compare exact lockfile bytes')
  const text = primary.toString('utf8')
  assert.ok(Buffer.from(text).equals(primary), 'Lockfile is not valid UTF-8')
  const replacements = text.split(PUBLIC_FEED_PREFIX).length - 1
  const expected = Buffer.from(text.replaceAll(PUBLIC_FEED_PREFIX, APPROVED_FEED_PREFIX))
  assert.ok(expected.equals(descriptor),
    'Descriptor may change only the approved feed prefix, with all other bytes unchanged')
  return { primary_sha256: sha(primary), descriptor_sha256: sha(descriptor), replacements,
    qualification: replacements === 0 ? 'Current lock has no explicit public tarball URLs; identical descriptor required'
      : 'Exact approved feed-prefix replacement only' }
}

function command(program, args, cwd, timeout = 120_000) {
  return spawnSync(program, args, { cwd, encoding: 'utf8', windowsHide: true, shell: false,
    timeout, maxBuffer: 64 * 1024 * 1024 })
}

function success(result, label) {
  assert.ok(!result.error && result.signal == null && result.status === 0,
    `${label} failed (exit=${result.status}, signal=${result.signal}, error=${result.error?.code ?? null})`)
}

export function pnpmInvocation(args) {
  // Reuse the canonical gate's shell-free Windows invocation. The bundled CLI
  // beside Node is a fallback for the documented direct `node tools/...` call.
  const bundled = path.join(path.dirname(process.execPath), 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')
  const cli = process.env.npm_execpath || (existsSync(bundled) ? bundled : undefined)
  return invocationFor('pnpm', args, process.platform, cli)
}

async function recordCommand(report, directory, label, program, args, cwd, timeout) {
  const log = path.join(directory, `${label}.log`)
  const started = new Date().toISOString()
  const result = command(program, args, cwd, timeout)
  const bytes = Buffer.from((result.stdout ?? '') + (result.stderr ?? ''))
  await writeFile(log, bytes, { flag: 'wx' })
  report.commands.push({ label, program, args, cwd, started_at: started, finished_at: new Date().toISOString(),
    exit_code: result.status, signal: result.signal, error: result.error?.code ?? null,
    log, log_sha256: sha(bytes) })
  success(result, label)
  return result
}

export async function copyWebSource(source, destination) {
  const listing = command('git', ['ls-files', '-co', '--exclude-standard', '-z'], source)
  success(listing, 'source inventory')
  const files = [...new Set(listing.stdout.split('\0').filter(Boolean))].sort()
  assert.ok(files.length > 0 && files.length <= 25_000, 'Unexpected source inventory size')
  const resolved = await realpath(source)
  for (const relative of files) {
    assert.ok(!path.isAbsolute(relative) && relative.split(/[\\/]/u).every(part => part && part !== '..' && part !== '.git'),
      'Unsafe source path')
    const original = path.join(resolved, relative)
    const physical = await realpath(original)
    const contained = path.relative(resolved, physical)
    assert.ok(contained && !path.isAbsolute(contained) && contained !== '..' && !contained.startsWith(`..${path.sep}`),
      'Source escapes its checkout')
    const metadata = await lstat(original)
    assert.ok(metadata.isFile() && !metadata.isSymbolicLink(), 'Source must contain only regular files')
    const target = path.join(destination, relative)
    await mkdir(path.dirname(target), { recursive: true })
    await copyFile(original, target)
    assert.equal(sha(await readFile(target)), sha(await readFile(original)), 'Copy changed source bytes')
  }
  // Oxlint discovery must stop at this copy, even when its parent is another repo.
  const initialized = command('git', ['init', '--quiet', '--initial-branch=codex/token-ceiling-web-gate'], destination)
  success(initialized, 'disposable Git boundary')
  // Some retained fixtures are tracked despite .gitignore. Populate only this
  // disposable index so their presence in the copied source stays auditable.
  success(command('git', ['add', '--force', '--all'], destination), 'disposable source inventory')
  return files.length
}

export async function runTokenCeilingChecks(args) {
  const web = args[0] === '--web-gate'
  assert.ok(args.length === 0 || (web && args.length === 3 && ['build', 'lint'].includes(args[1])),
    'Usage: node tools/test_token_ceiling.mjs [--web-gate build|lint <approved-feed-lock>]')
  // Evidence and dependencies live outside the product checkout, and every run
  // gets its own retained directory. No existing directory is adopted or removed.
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ecorp-token-ceiling-'))
  const reportPath = path.join(directory, 'receipt.json')
  const report = { schema_version: 1, issue: 291, status: 'running', started_at: new Date().toISOString(),
    source: root, directory, commands: [], kind: web ? `web-${args[1]}` : 'numeric-regression',
    scope: 'Contributor regression only; no native Factory, real-provider or independent outcome acceptance' }
  const save = () => writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  const primaryPath = path.join(root, 'pnpm-lock.yaml')
  const primary = await readFile(primaryPath)
  try {
    report.source_before = await sourceFingerprint(root)
    const head = command('git', ['rev-parse', 'HEAD'], root)
    success(head, 'source HEAD')
    report.head = head.stdout.trim()
    await save()
    if (web) {
      const descriptor = await readFile(path.resolve(args[2]))
      report.feed = qualifyFeedLock(primary, descriptor)
      const copy = path.join(directory, 'source')
      await mkdir(copy)
      report.copy = copy
      report.copied_files = await copyWebSource(root, copy)
      assert.equal(await sourceFingerprint(copy), report.source_before, 'Disposable copy differs from source')
      await writeFile(path.join(copy, 'pnpm-lock.yaml'), descriptor)
      const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
      const versionCommand = pnpmInvocation(['--version'])
      const version = await recordCommand(report, directory, 'pnpm-version', versionCommand.program,
        versionCommand.args, copy)
      assert.equal(`pnpm@${version.stdout.trim()}`, pkg.packageManager, 'Use the selected pinned package manager')
      const install = pnpmInvocation(['install', '--frozen-lockfile', '--offline',
        '--config.node-linker=hoisted', '--config.package-import-method=copy'])
      await recordCommand(report, directory, 'locked-install', install.program, install.args, copy, 600_000)
      const gate = pnpmInvocation([`${args[1]}:web`])
      await recordCommand(report, directory, `web-${args[1]}`, gate.program, gate.args, copy, 600_000)
      assert.ok((await readFile(path.join(copy, 'pnpm-lock.yaml'))).equals(descriptor), 'Web gate changed its descriptor')
      report.install_profile = { node_linker: 'hoisted', package_import_method: 'copy', frozen: true, offline: true }
    } else {
      for (const [label, program, commandArgs] of [
        ['store-numeric', 'cargo', ['test', '--locked', '--offline', '-p', 'crony-store', 'token_ceiling', '--', '--test-threads=1']],
        ['planning', 'cargo', ['test', '--locked', '--offline', '-p', 'crony-server', '--bin', 'crony-server',
          'token_ceiling_all_ordinary_strategies', '--', '--test-threads=1']],
        ['frontend', process.execPath, ['--test', 'apps/web/src/missionPreview.test.mjs']],
      ]) await recordCommand(report, directory, label, program, commandArgs, root, 1_200_000)
      report.database_scope = 'Ignored SQLx cases require a separate explicitly owned database execution; inspect actual logs'
    }
    report.status = 'passed'
  } catch (error) {
    report.status = 'failed'
    report.failure = error.message
  } finally {
    try {
      report.source_after = await sourceFingerprint(root)
      report.primary_lock_unchanged = (await readFile(primaryPath)).equals(primary)
      report.source_unchanged = report.source_before === report.source_after
      assert.ok(report.primary_lock_unchanged && report.source_unchanged, 'Source changed during regression')
    } catch (error) { report.status = 'failed'; report.source_failure = error.message }
    report.finished_at = new Date().toISOString()
    await save()
  }
  return { ...report, receipt: reportPath }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const result = await runTokenCeilingChecks(process.argv.slice(2))
    console.log(JSON.stringify({ status: result.status, receipt: result.receipt, failure: result.failure ?? null }))
    process.exitCode = result.status === 'passed' ? 0 : 1
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
