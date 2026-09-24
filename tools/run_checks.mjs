import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const configPath = new URL('../test.config.json', import.meta.url)
const configBytes = readFileSync(configPath)
const config = JSON.parse(configBytes.toString('utf8'))

export function selectNodeTests(files, settings = config) {
  const exclusions = settings.nodeTestExcludes ?? []
  if (settings.schemaVersion !== 1 || !Array.isArray(settings.nodeTestSuffixes) || !settings.nodeTestSuffixes.length ||
      settings.nodeTestSuffixes.some(suffix => !['.test.mjs', '.test.js'].includes(suffix)) ||
      !Array.isArray(settings.nodeTestRoots) || !settings.nodeTestRoots.length ||
      settings.nodeTestRoots.some(root => !/^[.\w/-]+\/$/u.test(root) || root.includes('..')) ||
      !Array.isArray(exclusions) || exclusions.some(file => typeof file !== 'string' ||
        !/^[.\w/-]+$/u.test(file) || file.includes('..') || !settings.nodeTestRoots.some(root => file.startsWith(root)))) {
    throw new Error('Unsupported test configuration')
  }
  return [...new Set(files)].filter(file => !file.startsWith('-') && !file.includes('..') &&
    settings.nodeTestSuffixes.some(suffix => file.endsWith(suffix)) && settings.nodeTestRoots.some(root => file.startsWith(root)) &&
    !exclusions.some(excluded => file === excluded || (excluded.endsWith('/') && file.startsWith(excluded)))).sort()
}

export function invocationFor(command, argv, platform = process.platform, pnpmPath = process.env.npm_execpath) {
  if (command === 'node') return { program: process.execPath, args: argv }
  if (command !== 'pnpm' || platform !== 'win32') return { program: command, args: argv }
  if (!pnpmPath || !path.win32.isAbsolute(pnpmPath) || !/\.([cm]?js|exe)$/iu.test(pnpmPath)) {
    throw new Error('Run the full Windows gate through pnpm check so its native CLI path is available')
  }
  return /\.exe$/iu.test(pnpmPath) ? { program: pnpmPath, args: argv } : { program: process.execPath, args: [pnpmPath, ...argv] }
}

export function checkPlan(group, files) {
  const tests = selectNodeTests(files)
  if (!tests.length) throw new Error('No Node test files discovered; refusing a false-green suite')
  if (JSON.stringify(config.rustCommand) !== JSON.stringify(['cargo', 'test', '--workspace', '--locked'])) {
    throw new Error('Rust test command differs from the reviewed workspace gate')
  }
  const checks = {
    migrations: ['node', 'tools/check_migrations.mjs'],
    'state-audit-compatibility': ['node', 'tools/check_state_audit_compatibility.mjs'],
    'state-audit-evm': ['cargo', 'test', '--locked', '-p', 'crony-audit', '--test', 'ethereum_local_chain'],
    docs: ['node', 'tools/check_docs.mjs'],
    'repository-docs': ['node', 'tools/check_documentation.mjs'],
    'node-tests': ['node', '--test', '--test-concurrency=1', '--test-timeout=180000', '--test-reporter=tap', ...tests],
    format: ['cargo', 'fmt', '--check'],
    clippy: ['cargo', 'clippy', '--workspace', '--all-targets', '--locked', '--', '-D', 'warnings'],
    'rust-tests': config.rustCommand,
    'web-build': ['pnpm', 'build:web'],
    'web-lint': ['pnpm', 'lint:web'],
  }
  const groups = {
    fast: ['migrations', 'docs', 'repository-docs', 'format'],
    docs: ['docs', 'repository-docs'],
    node: ['node-tests'],
    test: ['node-tests', 'rust-tests'],
    full: Object.keys(checks),
  }
  if (!Object.hasOwn(groups, group)) throw new Error('Unknown check group')
  return groups[group].map(name => ({ name, argv: checks[name] }))
}

export function summarizeTests(stdout) {
  const rust = [...stdout.matchAll(/test result: \w+\. (\d+) passed; (\d+) failed; (\d+) ignored;/gu)]
  const sum = index => rust.reduce((total, match) => total + Number(match[index]), 0)
  const nodeValue = label => {
    const match = stdout.match(new RegExp(`^# ${label} (\\d+)$`, 'm'))
    return match ? Number(match[1]) : null
  }
  return {
    rust: rust.length ? { passed: sum(1), failed: sum(2), ignored: sum(3), summaries: rust.length } : null,
    node: nodeValue('tests') === null ? null : {
      tests: nodeValue('tests'), passed: nodeValue('pass'), failed: nodeValue('fail'),
      skipped: nodeValue('skipped'), todo: nodeValue('todo'), cancelled: nodeValue('cancelled'),
    },
  }
}

function gitEvidenceError(operation, result, captured) {
  const stderr = result.stderr ?? ''
  const evidence = {
    operation, code: result.error?.code ?? null, exitCode: result.status, signal: result.signal,
    diagnostic: {
      text: 'Native stderr and error message withheld; metadata covers captured UTF-8 stderr only and may be incomplete.',
      ...(captured ?? { stderrBytes: Buffer.byteLength(stderr), stderrSha256: createHash('sha256').update(stderr).digest('hex') }),
    },
  }
  return Object.assign(new Error(`Git evidence unavailable: ${operation}; ${JSON.stringify(evidence)}`),
    { code: evidence.code, gitEvidence: evidence })
}

function git(args) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  if (result.error || result.status !== 0) throw gitEvidenceError(args[0], result)
  return result.stdout
}

function trackedDiffDigest() {
  return new Promise((resolve, reject) => {
    const digest = createHash('sha256')
    const stderrDigest = createHash('sha256')
    let stderrBytes = 0
    let failure = null
    const child = spawn('git', ['diff', '--binary', '--no-ext-diff', '--no-textconv', 'HEAD'], {
      cwd: ROOT, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.once('error', error => { failure ??= error })
    child.stdout.on('data', chunk => digest.update(chunk))
    const captureFailed = error => { failure ??= error; child.kill() }
    child.stdout.once('error', captureFailed)
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', chunk => { stderrBytes += Buffer.byteLength(chunk); stderrDigest.update(chunk) })
    child.stderr.once('error', captureFailed)
    // close follows stdio closure; a successful process without complete output
    // must not certify a partial digest. Diff size does not bound source coverage.
    child.once('close', (code, signal) => {
      if (!failure && (!child.stdout.readableEnded || !child.stderr.readableEnded)) {
        failure = { code: 'GIT_CAPTURE_INCOMPLETE' }
      }
      if (failure || code !== 0) reject(gitEvidenceError('diff', { error: failure, status: code, signal },
        { stderrBytes, stderrSha256: stderrDigest.digest('hex') }))
      else resolve(digest.digest('hex'))
    })
  })
}

export async function main(args = process.argv.slice(2)) {
  if (args.some(arg => !['--group', 'fast', 'docs', 'node', 'test', 'full', '--dry-run'].includes(arg)) ||
      args.filter(arg => arg === '--group').length !== 1 || args.indexOf('--group') !== 0 ||
      args.length < 2 || args.length > 3 || (args.length === 3 && args[2] !== '--dry-run')) {
    throw new Error('Usage: node tools/run_checks.mjs --group fast|docs|node|test|full [--dry-run]')
  }
  const files = git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(Boolean)
  const plan = checkPlan(args[1], files)
  if (args.includes('--dry-run')) {
    console.log(JSON.stringify({ dry_run: true, writes: [], checks: plan }, null, 2))
    return 0
  }
  const status = git(['status', '--porcelain=v1'])
  const trackedDiffSha256 = await trackedDiffDigest()
  const untracked = git(['ls-files', '-z', '--others', '--exclude-standard']).split('\0').filter(Boolean)
  const untrackedDigests = untracked.map(file => [file, createHash('sha256').update(readFileSync(path.join(ROOT, file))).digest('hex')])
  const started = new Date().toISOString()
  const report = {
    schemaVersion: 1, group: args[1], startedAt: started,
    source: { files, commit: git(['rev-parse', 'HEAD']).trim(), branch: git(['branch', '--show-current']).trim(),
      dirty: status.length > 0, trackedDiffSha256, untrackedDigests,
      testConfigSha256: createHash('sha256').update(configBytes).digest('hex') },
    node: process.versions.node, checks: [], status: 'running',
    runningCheck: null, notRun: plan.map(check => check.name), sourceChangedDuringValidation: null,
    assurance: 'Local validation only. Ignored tests are not passes. No hosted CI, browser, provider or production claim.',
  }
  const out = path.join(ROOT, 'output', 'readiness')
  mkdirSync(out, { recursive: true })
  const reportPath = path.join(out, `${started.replaceAll(/[:.]/gu, '-')}-${randomUUID()}-${args[1]}.json`)
  // One attempt owns this path; replacement never exposes partially written JSON.
  const checkpoint = () => {
    writeFileSync(`${reportPath}.tmp`, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', flush: true })
    renameSync(`${reportPath}.tmp`, reportPath)
  }
  checkpoint()
  const maxBuffer = 32 * 1024 * 1024
  for (const check of plan) {
    report.runningCheck = check.name
    report.notRun = plan.slice(report.checks.length + 1).map(check => check.name)
    checkpoint()
    const begin = Date.now()
    console.log(`Running ${check.name}`)
    const [command, ...argv] = check.argv
    // Use the package manager's own native entry point, not shell-concatenated arguments.
    let result
    try {
      const invocation = invocationFor(command, argv)
      result = spawnSync(invocation.program, invocation.args, {
        cwd: ROOT, encoding: 'utf8', maxBuffer, shell: false,
        env: { ...process.env, ECORP_FACTORY_WATCH: '0' },
      })
    } catch (error) {
      result = { status: null, error: { code: 'TOOL_RESOLUTION_ERROR' }, stdout: '', stderr: error.message + '\n' }
    }
    const stdout = result.stdout ?? '', stderr = result.stderr ?? ''
    const counts = summarizeTests(stdout)
    const testEvidence = check.name === 'node-tests' ? counts.node?.tests > 0 :
      check.name === 'rust-tests' ? counts.rust?.summaries > 0 : true
    const passed = result.status === 0 && !result.error && testEvidence
    if (check.name === 'node-tests' && passed) {
      // Compact successful TAP only; failures need all captured diagnostic context.
      const summary = stdout.split('\n').filter(line => /^# (tests|pass|fail|cancelled|skipped|todo|duration_ms) /u.test(line))
      console.log(summary.join('\n'))
    } else if (check.name === 'rust-tests' && passed) {
      console.log(stdout.split('\n').filter(line => line.startsWith('test result:')).join('\n'))
    } else process.stdout.write(stdout)
    process.stderr.write(passed ? stderr.slice(0, 16000) : stderr)
    if (result.error) console.error(`Check execution/capture error: ${result.error.code ?? result.error.message}; maxBuffer=${maxBuffer} bytes; output may be incomplete`)
    report.checks.push({ name: check.name, argv: check.argv, exitCode: result.status,
      passed, durationMs: Date.now() - begin, counts,
      errorCode: result.error?.code ?? (testEvidence ? null : 'NO_TEST_SUMMARY') })
    report.runningCheck = null
    report.notRun = plan.slice(report.checks.length).map(check => check.name)
    if (!passed) report.status = 'failed'
    checkpoint()
    if (!passed) break
  }
  try {
    // Bind final source membership to the same inventory used to build the plan.
    report.sourceChangedDuringValidation = JSON.stringify(git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(Boolean)) !== JSON.stringify(report.source.files) ||
      git(['rev-parse', 'HEAD']).trim() !== report.source.commit ||
      await trackedDiffDigest() !== report.source.trackedDiffSha256 ||
      JSON.stringify(git(['ls-files', '-z', '--others', '--exclude-standard']).split('\0').filter(Boolean)
        .map(file => [file, createHash('sha256').update(readFileSync(path.join(ROOT, file))).digest('hex')])) !== JSON.stringify(untrackedDigests) ||
      createHash('sha256').update(readFileSync(configPath)).digest('hex') !== report.source.testConfigSha256
    if (report.status === 'running') report.status = report.sourceChangedDuringValidation ? 'source_changed' : 'passed'
  } catch (error) {
    report.status = 'source_unknown'
    report.sourceEvidenceError = { code: error.code ?? null, message: error.message, ...error.gitEvidence }
    console.error(error.message)
  }
  report.finishedAt = new Date().toISOString()
  checkpoint()
  console.log(`Validation report: ${reportPath}`)
  return report.status === 'passed' ? 0 : 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { process.exitCode = await main() } catch (error) { console.error(error.message); process.exitCode = 1 }
}
