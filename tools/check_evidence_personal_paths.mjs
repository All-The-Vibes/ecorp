import { spawnSync } from 'node:child_process'
import path, { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repository = fileURLToPath(new URL('../', import.meta.url))
let binary

function nativeScan(request) {
  // Build from this checkout through Cargo's normal fingerprinting. Never
  // accept an arbitrary prebuilt binary as proof of the current source.
  if (!binary) {
    const build = spawnSync('cargo', ['build', '--locked', '--quiet', '-p', 'crony-runner', '--bin', 'crony-evidence-paths'],
      { cwd: repository, encoding: 'utf8', windowsHide: true, timeout: 600_000, maxBuffer: 4 * 1024 * 1024 })
    if (build.status !== 0) throw new Error('Unable to build the current native evidence scanner')
    binary = join(resolve(repository, process.env.CARGO_TARGET_DIR || 'target'), 'debug',
      `crony-evidence-paths${process.platform === 'win32' ? '.exe' : ''}`)
  }
  const result = spawnSync(binary, [], { input: JSON.stringify(request), encoding: 'utf8',
    windowsHide: true, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 })
  if (result.status !== 0) throw new Error(result.stderr.trim() || 'Native evidence scan did not complete')
  const output = JSON.parse(result.stdout)
  if (!Array.isArray(output.files) || !Array.isArray(output.directories)
    || [...output.files, ...output.directories].some(value => typeof value !== 'string')) {
    throw new Error('Incomplete native evidence scan result')
  }
  return output
}

export function defaultEvidenceDirectories() {
  return nativeScan({ discover: join(repository, 'docs/evidence'), inventory_only: true }).directories
}

// Repeated separators cover both native paths and JSON-escaped paths. A drive
// prefix is optional because Windows HOMEPATH normally omits the drive.
export function hasPersonalUserPath(text) {
  return /(?:[a-z]:)?[/\\]+Users[/\\]+[^/\\\s"'<>]+/i.test(text)
}

export function isContainedEvidencePath(root, candidate, pathApi = path) {
  const location = pathApi.relative(root, candidate)
  return !pathApi.isAbsolute(location) && location !== '..'
    && !location.startsWith(`..${pathApi.sep}`) && pathApi.resolve(root, location) === candidate
}

export function findPersonalPathFiles(directories) {
  // Discovery and content scanning share held handles in one native call;
  // neither a stale JavaScript directory inventory nor path rechecks authorize reads.
  return nativeScan(directories === undefined
    ? { discover: join(repository, 'docs/evidence') }
    : { directories: directories.map(directory => resolve(directory)) }).files
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const directories = process.argv.slice(2)
  const files = findPersonalPathFiles(directories.length ? directories.map(path => resolve(path)) : undefined)
  // Report file names only; never repeat the personal value being rejected.
  console.log(JSON.stringify({ status: files.length ? 'failed' : 'passed', files }, null, 2))
  process.exitCode = files.length ? 1 : 0
}
