import { createHash, randomUUID } from 'node:crypto'
import { globSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repository = fileURLToPath(new URL('../', import.meta.url))
export const MODEL_FILES = [
  'evidenceSelection.ts', 'factoryAuthority.ts', 'factoryCheckpointRecovery.ts', 'factoryControllerSelection.ts',
  'factoryPolling.ts', 'formText.ts', 'missionCollaboration.ts', 'missionOriginContext.ts', 'missionPreview.ts',
  'missionProjection.ts', 'missionResultContext.ts', 'missionRuntime.ts',
  'office/characterAssets.ts', 'office/officeModel.ts', 'runActivity.ts', 'snapshotRefresh.ts',
  'verificationPolicy.ts', 'workflowContext.ts', 'workspaceConnections.ts',
].map((file) => `apps/web/src/${file}`).sort()
const frameworkFiles = ['apps/web/src/useMissionOriginContext.ts', 'apps/web/src/useMissionResultContext.ts']
const testPatterns = ['apps/web/src/**/*.test.mjs', 'tools/office_model.test.mjs']
const thresholds = { lines: 99, functions: 95, branches: 97 }
const scope = `All ${MODEL_FILES.length} framework-independent web TypeScript models; excludes the two React hooks, TSX rendering, Rust, and other tools`
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
const slash = (file) => file.split(path.sep).join('/')

function coverageFile(file, root) {
  const absolute = file.startsWith('file:') ? fileURLToPath(file) : path.resolve(root, file)
  return slash(path.relative(root, absolute))
}

export function verifyLcov(text, expected = MODEL_FILES, root = repository) {
  const records = []
  let record = null
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('SF:')) {
      if (record) throw new Error('LCOV record is not terminated')
      record = { file: coverageFile(line.slice(3), root), uncoveredLines: [], uncoveredFunctions: [] }
    } else if (record) {
      const metric = /^(LF|LH|FNF|FNH|BRF|BRH):(\d+)$/.exec(line)
      if (metric) {
        if (record[metric[1]] !== undefined) throw new Error('LCOV repeats a coverage metric')
        record[metric[1]] = Number(metric[2])
      } else if (/^DA:\d+,0(?:,|$)/.test(line)) {
        record.uncoveredLines.push(Number(line.slice(3).split(',')[0]))
      } else if (line.startsWith('FNDA:0,')) {
        record.uncoveredFunctions.push(line.slice(7))
      } else if (line === 'end_of_record') {
        records.push(record)
        record = null
      }
    }
  }
  if (record) throw new Error('LCOV record is not terminated')
  const files = records.map((entry) => entry.file).sort()
  if (files.length !== new Set(files).size || JSON.stringify(files) !== JSON.stringify([...expected].sort())) {
    throw new Error('LCOV denominator does not contain exactly the declared production model files')
  }
  const totals = { lines: { found: 0, hit: 0 }, functions: { found: 0, hit: 0 }, branches: { found: 0, hit: 0 } }
  for (const entry of records) {
    for (const [name, found, hit] of [['lines', 'LF', 'LH'], ['functions', 'FNF', 'FNH'], ['branches', 'BRF', 'BRH']]) {
      if (!Number.isSafeInteger(entry[found]) || !Number.isSafeInteger(entry[hit]) || entry[hit] > entry[found]) {
        throw new Error('LCOV has missing or inconsistent coverage counts')
      }
      totals[name].found += entry[found]
      totals[name].hit += entry[hit]
    }
  }
  for (const value of Object.values(totals)) value.percent = value.found
    ? Number((100 * value.hit / value.found).toFixed(2)) : null
  return { files: records.sort((a, b) => a.file.localeCompare(b.file)), totals }
}

function git(args) {
  const result = spawnSync('git', args, {
    cwd: repository, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 2 * 1024 * 1024,
  })
  if (result.error || result.status !== 0) throw new Error('Cannot read Git source identity')
  return result.stdout.trimEnd()
}

function sourceIdentity() {
  const paths = git(['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--',
    'apps/web/src', 'apps/web/public/assets/office/pixel-agents', 'apps/web/package.json',
    'tools/office_model.test.mjs', 'tools/coverage_web_models.mjs', 'package.json', 'pnpm-lock.yaml', '.node-version'])
    .split('\0').filter(Boolean)
  const files = [...new Set(paths)].sort().map((file) => ({
    file, sha256: digest(readFileSync(path.join(repository, file))),
  }))
  return {
    head: git(['rev-parse', 'HEAD']), committedTree: git(['rev-parse', 'HEAD^{tree}']),
    dirty: Boolean(git(['status', '--porcelain'])), files,
    sourceManifestSha256: digest(JSON.stringify(files)),
    identityNote: 'The committed tree identifies HEAD; the file hashes identify actual working source and test inputs, including uncommitted files.',
  }
}

function checkSourceScope() {
  const current = [...globSync('apps/web/src/**/*.ts', { cwd: repository })].map(slash).sort()
  const declared = [...MODEL_FILES, ...frameworkFiles].sort()
  if (JSON.stringify(current) !== JSON.stringify(declared)) {
    throw new Error('TypeScript source set changed; classify every new file in the explicit coverage scope first')
  }
}

export function runCoverage(requestedOutput) {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Web model coverage requires Node 24 or newer')
  checkSourceScope()
  const outputRoot = path.join(repository, 'output')
  const output = requestedOutput ? path.resolve(repository, requestedOutput)
    : path.join(outputRoot, 'coverage', 'web-models', `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}`)
  const relative = path.relative(outputRoot, output)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Coverage output must be a new directory under repository output/')
  mkdirSync(path.dirname(output), { recursive: true })
  mkdirSync(output) // Existing evidence must never be overwritten.
  const before = sourceIdentity()
  const args = ['--test', '--test-concurrency=2', '--test-timeout=180000', '--experimental-test-coverage',
    ...Object.entries(thresholds).map(([metric, value]) => `--test-coverage-${metric}=${value}`),
    '--test-reporter=spec', '--test-reporter-destination=stdout',
    '--test-reporter=lcov', `--test-reporter-destination=${path.join(output, 'lcov.info')}`,
    ...MODEL_FILES.map((file) => `--import=./${file}`),
    ...MODEL_FILES.map((file) => `--test-coverage-include=**/${file}`), ...testPatterns]
  const receipt = {
    schemaVersion: 1, scope, node: process.version, thresholds, before, modelFiles: MODEL_FILES,
    frameworkFiles, testFiles: [...globSync(testPatterns, { cwd: repository })].map(slash).sort(),
    command: [process.execPath, ...args], startedAt: new Date().toISOString(),
  }
  writeFileSync(path.join(output, 'run.json'), JSON.stringify(receipt, null, 2))
  const allowed = new Set(['path', 'pathext', 'systemroot', 'windir', 'comspec', 'home', 'userprofile', 'temp', 'tmp', 'lang', 'lc_all'])
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => allowed.has(name.toLowerCase())))
  const result = spawnSync(process.execPath, args, {
    cwd: repository, env: environment, encoding: 'utf8', windowsHide: true,
    timeout: 240000, maxBuffer: 16 * 1024 * 1024,
  })
  writeFileSync(path.join(output, 'tests.log'), (result.stdout ?? '') + (result.stderr ?? ''))
  receipt.exitCode = result.status
  receipt.finishedAt = new Date().toISOString()
  receipt.after = sourceIdentity()
  receipt.sourceStable = receipt.before.sourceManifestSha256 === receipt.after.sourceManifestSha256
  let coverage
  try { coverage = verifyLcov(readFileSync(path.join(output, 'lcov.info'), 'utf8')) } catch (error) {
    receipt.coverageError = error.message
  }
  receipt.ok = !result.error && result.status === 0 && receipt.sourceStable && Boolean(coverage)
  if (result.error) receipt.processError = result.error.code ?? 'process_failed'
  writeFileSync(path.join(output, 'run.json'), JSON.stringify(receipt, null, 2))
  if (coverage) writeFileSync(path.join(output, 'coverage.json'), JSON.stringify({ scope, ...coverage }, null, 2))
  const summary = { ok: receipt.ok, output, scope, thresholds, node: process.version, files: coverage?.files.length ?? 0,
    testFiles: receipt.testFiles.length, exitCode: receipt.exitCode, sourceStable: receipt.sourceStable,
    coverage: coverage?.totals, ...(receipt.coverageError ? { error: receipt.coverageError } : {}) }
  writeFileSync(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2))
  return summary
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2)
    if (args.length && (args.length !== 2 || args[0] !== '--output')) throw new Error('Usage: node tools/coverage_web_models.mjs [--output new-output-directory]')
    const result = runCoverage(args[1])
    console.log(JSON.stringify(result, null, 2))
    process.exitCode = result.ok ? 0 : 1
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
