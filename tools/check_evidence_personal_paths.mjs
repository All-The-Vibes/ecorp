import { readdirSync, readFileSync } from 'node:fs'
import { basename, join, relative, resolve } from 'node:path'
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

export function findPersonalPathFiles(directories = defaultEvidenceDirectories) {
  const findings = []
  for (const root of directories) {
    function visit(directory) {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name)
        if (entry.isSymbolicLink()) throw new Error('Evidence path check requires regular files and directories')
        if (entry.isDirectory()) visit(path)
        else if (entry.isFile() && hasPersonalUserPath(readFileSync(path).toString('utf8'))) {
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
