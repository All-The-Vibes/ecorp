import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync, realpathSync } from 'node:fs'
import path, { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const defaultEvidenceDirectories = [
  fileURLToPath(new URL('../docs/evidence/pr226-integration-20260921/', import.meta.url)),
  fileURLToPath(new URL('../docs/evidence/pr226-local-validation/', import.meta.url)),
  fileURLToPath(new URL('../docs/evidence/pr-226-completion-20260922-r3/', import.meta.url)),
]

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

function assertRegularDirectory(directory) {
  const absolute = resolve(directory)
  for (let current = absolute; ; current = dirname(current)) {
    const entry = lstatSync(current)
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new Error('Evidence path check requires regular files and directories')
    }
    if (dirname(current) === current) break
  }
  // Native canonicalization also expands ordinary Windows 8.3 path spelling.
  return realpathSync.native(absolute)
}

const maximumFileBytes = 16 * 1024 * 1024
const regularPathError = 'Evidence path check requires regular files and directories'

function assertUnchangedFile(expected, actual, acquired = true) {
  if (!actual.isFile() || actual.isSymbolicLink() || actual.nlink !== 1n
      || ['dev', 'ino', 'size', 'mtimeNs'].some(key => expected[key] !== actual[key])
      || (acquired && expected.ctimeNs !== actual.ctimeNs)) {
    throw new Error(`${regularPathError}; file changed during scan`)
  }
}

function readEvidenceFile(root, file, expected) {
  assertUnchangedFile(expected, expected)
  if (expected.size > BigInt(maximumFileBytes)) throw new Error('Evidence file exceeds byte limit')
  // O_NOFOLLOW protects supported platforms. Identity checks also fence platforms
  // without that flag before any read, and all content comes from this one handle.
  const descriptor = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const opened = fstatSync(descriptor, { bigint: true })
    // NTFS can finish updating a newly written file's change time at open.
    // Bind identity/content metadata first, then track the acquired change time.
    assertUnchangedFile(expected, opened, false)
    const checkNamedFile = () => {
      const directory = assertRegularDirectory(dirname(file))
      if (!isContainedEvidencePath(root, directory) || directory !== dirname(file)) {
        throw new Error(regularPathError)
      }
      assertUnchangedFile(opened, lstatSync(file, { bigint: true }))
      assertUnchangedFile(opened, fstatSync(descriptor, { bigint: true }))
    }
    checkNamedFile()
    const bytes = Buffer.alloc(Number(expected.size) + 1)
    let length = 0
    while (length < bytes.length) {
      const count = readSync(descriptor, bytes, length, bytes.length - length, null)
      if (!count) break
      length += count
    }
    checkNamedFile()
    if (length !== Number(expected.size)) throw new Error('Evidence file changed during scan')
    return bytes.subarray(0, length).toString('utf8')
  } finally {
    closeSync(descriptor)
  }
}

export function findPersonalPathFiles(directories = defaultEvidenceDirectories) {
  const findings = []
  for (const suppliedRoot of directories) {
    const root = assertRegularDirectory(suppliedRoot)
    function visit(directory) {
      const canonical = assertRegularDirectory(directory)
      if (!isContainedEvidencePath(root, canonical)) {
        throw new Error('Evidence path check requires regular files and directories')
      }
      for (const entry of readdirSync(canonical, { withFileTypes: true })) {
        const path = join(canonical, entry.name)
        const current = lstatSync(path, { bigint: true })
        if (current.isSymbolicLink() || (!current.isDirectory() && !current.isFile())) {
          throw new Error('Evidence path check requires regular files and directories')
        }
        if (current.isDirectory()) visit(path)
        else if (hasPersonalUserPath(readEvidenceFile(root, path, current))) {
          findings.push(`${basename(root)}/${relative(root, path).replaceAll('\\', '/')}`)
        }
      }
    }
    visit(root)
  }
  return findings.sort()
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const directories = process.argv.slice(2)
  const files = findPersonalPathFiles(directories.length ? directories.map(path => resolve(path)) : undefined)
  // Report file names only; never repeat the personal value being rejected.
  console.log(JSON.stringify({ status: files.length ? 'failed' : 'passed', files }, null, 2))
  process.exitCode = files.length ? 1 : 0
}
