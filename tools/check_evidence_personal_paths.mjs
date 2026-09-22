import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const defaultEvidenceDirectories = [
  fileURLToPath(new URL('../docs/evidence/pr226-integration-20260921/', import.meta.url)),
  fileURLToPath(new URL('../docs/evidence/pr226-local-validation/', import.meta.url)),
]

// Repeated separators cover both native paths and JSON-escaped paths. A drive
// prefix is optional because Windows HOMEPATH normally omits the drive.
export function hasPersonalUserPath(text) {
  return /(?:[a-z]:)?[/\\]+Users[/\\]+[^/\\\s"'<>]+/i.test(text)
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

export function findPersonalPathFiles(directories = defaultEvidenceDirectories) {
  const findings = []
  for (const suppliedRoot of directories) {
    const root = assertRegularDirectory(suppliedRoot)
    function visit(directory) {
      const canonical = assertRegularDirectory(directory)
      const location = relative(root, canonical).replaceAll('\\', '/')
      if (location === '..' || location.startsWith('../') || resolve(root, location) !== canonical) {
        throw new Error('Evidence path check requires regular files and directories')
      }
      for (const entry of readdirSync(canonical, { withFileTypes: true })) {
        const path = join(canonical, entry.name)
        const current = lstatSync(path)
        if (current.isSymbolicLink() || (!current.isDirectory() && !current.isFile())) {
          throw new Error('Evidence path check requires regular files and directories')
        }
        if (current.isDirectory()) visit(path)
        else if (hasPersonalUserPath(readFileSync(path).toString('utf8'))) {
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
