import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, readdirSync, unlinkSync, rmdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

// Rebuild only the receipt's own evidence addition in a private index. The
// tested tree need not be an otherwise unreachable loose object in the clone.
export function verifyReplaySource(repository, validationDirectory, expectedPr) {
  const root = realpathSync(repository)
  const directory = realpathSync(validationDirectory)
  const validation = JSON.parse(readFileSync(path.join(directory, 'validation.json'), 'utf8').replace(/^\uFEFF/u, ''))
  const expected = validation.staged_tree ?? validation.tested_staged_tree
  const checks = ['migrations', 'documentation', 'rust-format', 'rust-clippy', 'rust-workspace', 'node-unit', 'steward', 'web-build', 'web-lint']
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
  if (pkg.scripts?.['check:state-audit-compatibility']) checks.push('state-audit-compatibility', 'state-audit-evm')
  if (validation.status !== 'passed' || !/^[a-f0-9]{40}$/u.test(expected ?? '') ||
      !Array.isArray(validation.checks) || validation.checks.some(check => check.exit_code !== 0) ||
      JSON.stringify(validation.checks.map(check => check.name).sort()) !== JSON.stringify(checks.sort()) ||
      (validation.pr !== undefined && validation.pr !== expectedPr) ||
      (validation.prs !== undefined && !validation.prs.includes(expectedPr))) {
    throw new Error('Replay requires all current contributor gates and an exact source receipt.')
  }
  const git = (args, env = process.env) => {
    try {
      return execFileSync('git', ['--no-optional-locks', '-C', root, ...args], {
        env, encoding: 'utf8', windowsHide: true, timeout: 60_000, maxBuffer: 32 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim()
    } catch { throw new Error(`Git source verification failed: ${args[0]}`) }
  }
  const index = path.resolve(root, git(['rev-parse', '--git-path', 'index']))
  const indexBytes = readFileSync(index)
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'ecorp-replay-index-'))
  const privateIndex = path.join(temporary, 'index')
  const env = { ...process.env, GIT_INDEX_FILE: privateIndex }
  copyFileSync(index, privateIndex)
  try {
    if (git(['diff', '--name-only', '--no-ext-diff'], env) || git(['ls-files', '--others', '--exclude-standard'], env)) {
      throw new Error('Replay source has unstaged or untracked files.')
    }
    const current = git(['write-tree'], env)
    if (current !== expected) {
      const packet = path.relative(root, directory).split(path.sep).join('/')
      if (!/^docs\/evidence\/pr-(?:354|355|queue)-[a-z0-9-]+$/u.test(packet) ||
          !git(['ls-files', '--', packet], env)) {
        throw new Error('Source differs without the exact published validation packet.')
      }
      git(['rm', '-r', '--cached', '--ignore-unmatch', '--', packet], env)
      if (git(['write-tree'], env) !== expected) throw new Error('Product source changed since validation.')
      git(['read-tree', current], env)
    }
    if (git(['diff', '--name-only', '--no-ext-diff'], env)) throw new Error('Replay source changed during verification.')
    return { source_head: git(['rev-parse', 'HEAD'], env), tested_staged_tree: current,
      validation_source_tree: expected,
      validation_receipt_sha256: createHash('sha256').update(readFileSync(path.join(directory, 'validation.json'))).digest('hex') }
  } finally {
    // These are the only files native Git may create in our private directory.
    for (const entry of readdirSync(temporary)) {
      if (!['index', 'index.lock'].includes(entry)) throw new Error('Unexpected private index artifact; preserved for inspection.')
    }
    for (const entry of ['index', 'index.lock']) if (existsSync(path.join(temporary, entry))) unlinkSync(path.join(temporary, entry))
    rmdirSync(temporary)
    if (!readFileSync(index).equals(indexBytes)) throw new Error('Real index changed during replay verification.')
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(verifyReplaySource(process.argv[2], process.argv[3], Number(process.argv[4])))) }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}
