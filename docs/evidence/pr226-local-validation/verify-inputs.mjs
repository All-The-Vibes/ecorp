import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../../', import.meta.url))
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
export function git(args, cwd = root) {
  const result = spawnSync('git', args, {
    cwd, windowsHide: true, maxBuffer: 32 * 1024 * 1024,
    env: {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0',
    },
  })
  assert.equal(result.error, undefined)
  assert.equal(result.status, 0, result.stderr?.toString())
  return result.stdout
}
export function snapshot(cwd = root) {
  // Deliberately conservative: all tracked non-documentation files, not just imported modules.
  return git(['ls-files', '-s', '-z'], cwd).toString().split('\0').filter(Boolean)
    .map(line => {
      const [metadata, path] = line.split('\t')
      const [mode, blob, stage] = metadata.split(' ')
      assert.equal(stage, '0', `unmerged input: ${path}`)
      return { path, mode, blob }
    }).filter(file => !file.path.startsWith('docs/'))
    .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
    .map(file => ({ ...file, worktreeSha256: sha256(readFileSync(`${cwd}/${file.path}`)) }))
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const expected = JSON.parse(readFileSync(new URL('tested-inputs.json', import.meta.url)))
  assert.deepEqual(snapshot(), expected.files, 'tracked non-doc inputs changed since validation')
  console.log(JSON.stringify({ result: 'PASS', files: expected.files.length, sourceHead: expected.sourceHead,
    manifestSha256: sha256(readFileSync(new URL('tested-inputs.json', import.meta.url))) }, null, 2))
}
