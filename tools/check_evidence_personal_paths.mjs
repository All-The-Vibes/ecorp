import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path, { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repository = fileURLToPath(new URL('../', import.meta.url))
let binary

function executableDigest(file) {
  const metadata = lstatSync(file)
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
    throw new Error('Native evidence scanner must be a private regular executable')
  }
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function nativeScan(request) {
  // A unique rustc output forces compilation of this binary even when Cargo's
  // ordinary target artifact and fingerprints were replaced or left intact.
  // Dependencies keep their normal Cargo cache; the scanner executable does not.
  if (!binary) {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'ecorp-evidence-executable-')))
    const executable = join(directory, `crony-evidence-paths${process.platform === 'win32' ? '.exe' : ''}`)
    const build = spawnSync('cargo', ['rustc', '--locked', '--quiet', '-p', 'crony-runner', '--bin', 'crony-evidence-paths',
      '--', `--emit=link=${executable}`],
      { cwd: repository, encoding: 'utf8', windowsHide: true, timeout: 600_000, maxBuffer: 4 * 1024 * 1024 })
    if (build.status !== 0) throw new Error('Unable to build the current native evidence scanner')
    binary = { executable, digest: executableDigest(executable) }
    process.once('exit', () => {
      // This private directory contains only outputs of this process's build.
      try { rmSync(directory, { recursive: true }) } catch { /* preserve on cleanup failure */ }
    })
  }
  if (executableDigest(binary.executable) !== binary.digest) {
    throw new Error('Native evidence scanner integrity changed after compilation')
  }
  const result = spawnSync(binary.executable, [], { input: JSON.stringify(request), encoding: 'utf8',
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
