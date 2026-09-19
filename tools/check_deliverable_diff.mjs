import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, realpathSync, rmdirSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const MAX_OUTPUT = 8 * 1024 * 1024
const MAX_PATHS = 256
const utf8 = new TextDecoder('utf-8', { fatal: true })

function relativeSourcePath(value) {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > 500
    || /^\p{White_Space}|\p{White_Space}$/u.test(value) || /[\\:\p{Cc}]/u.test(value)
    || value.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('Source paths must be portable, literal repository-relative paths')
  }
  return value
}

function containedRelative(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative && !path.isAbsolute(relative) && relative !== '..'
    && !relative.startsWith(`..${path.sep}`) ? relative : null
}

function changesFromGit(text) {
  const fields = text.split('\0')
  if (fields.pop() !== '' || fields.length % 2 !== 0) {
    throw new Error('Malformed Git name-status output')
  }
  const changes = []
  for (let i = 0; i < fields.length; i += 2) {
    if (!/^[ADMT]$/.test(fields[i])) throw new Error('Unexpected Git change status')
    changes.push({ status: fields[i], path: relativeSourcePath(fields[i + 1]) })
  }
  return changes.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)))
}

/**
 * Check the worktree candidate selected by deliverable.rs, not the real index.
 * Caller supplies the same base, paths and provider artifacts as the export.
 * This is a whitespace/patch check, not write-scope or export authorization.
 */
export function checkDeliverableDiff({
  repository = process.cwd(),
  base,
  paths = [],
  providerArtifacts = [],
  preserveHead,
  scratchRoot,
  timeoutMs = 30_000,
} = {}) {
  if (typeof base !== 'string' || !base || base.includes('\0')) {
    throw new Error('An explicit export base is required')
  }
  if (!scratchRoot) throw new Error('An existing scratch root outside the worktree is required')
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    throw new Error('Timeout must be an integer from 1 to 120000 milliseconds')
  }
  if (!Array.isArray(paths) || !Array.isArray(providerArtifacts)
    || paths.length > MAX_PATHS || providerArtifacts.length > MAX_PATHS) {
    throw new Error('At most 256 source paths and 256 provider artifacts are supported')
  }
  paths.forEach(relativeSourcePath)
  if (providerArtifacts.some((value) => typeof value !== 'string' || !value || value.includes('\0'))) {
    throw new Error('Provider artifact paths must be nonempty filesystem paths')
  }
  if (preserveHead !== undefined
    && (typeof preserveHead !== 'string' || !preserveHead || preserveHead.includes('\0'))) {
    throw new Error('Preserved head must be a commit revision')
  }
  // Never let inherited Git routing redirect the check to a different checkout.
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE']) {
    if (process.env[key]) throw new Error(`Unset ${key} before checking a deliverable`)
  }
  const root = realpathSync(repository)
  const scratch = realpathSync(scratchRoot)
  if (scratch === root || containedRelative(root, scratch)) {
    throw new Error('Scratch root must be outside the source worktree')
  }
  const directory = path.join(scratch, `ecorp-diff-check-${randomUUID()}`)
  mkdirSync(directory, { mode: 0o700 })
  const index = path.join(directory, 'index')
  const deadline = performance.now() + timeoutMs
  const env = {
    ...process.env,
    GIT_INDEX_FILE: index,
    GIT_LITERAL_PATHSPECS: '1',
    GIT_OPTIONAL_LOCKS: '0',
  }
  function git(args, check = false) {
    const remaining = Math.ceil(deadline - performance.now())
    if (remaining <= 0) throw new Error('Deliverable diff check timed out')
    try {
      return {
        status: 0,
        stdout: utf8.decode(execFileSync('git', args, {
          cwd: root, env, windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'], timeout: remaining, maxBuffer: MAX_OUTPUT,
        })),
      }
    } catch (error) {
      // --check returns 2 for whitespace/conflict-marker diagnostics. All other
      // failures (including timeout, output overflow and spawn errors) fail closed.
      if (check && error.status === 2 && !error.signal && !error.code && error.stdout?.length) {
        return { status: 2, stdout: utf8.decode(error.stdout) }
      }
      const reason = error.code === 'ETIMEDOUT' ? 'timed out'
        : error.code === 'ENOBUFS' ? 'exceeded the output limit'
          : error.code === 'ENOENT' ? 'could not start Git'
            : `failed (${error.signal ?? error.status ?? error.code ?? 'unknown'})`
      throw new Error(`Deliverable Git ${args[0]} ${reason}`, { cause: error })
    }
  }
  let result
  let failure
  try {
    if (realpathSync(git(['rev-parse', '--show-toplevel']).stdout.trim()) !== root) {
      throw new Error('Repository must be the worktree root, not a subdirectory')
    }
    function commit(revision) {
      const oid = git(['rev-parse', '--verify', '--end-of-options', `${revision}^{commit}`]).stdout.trim()
      if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid)) throw new Error('Invalid Git commit identity')
      return oid
    }
    const baseCommit = commit(base)
    const indexBase = process.platform === 'win32' && preserveHead ? commit(preserveHead) : baseCommit
    const changes = () => changesFromGit(git([
      'diff', '--cached', '--name-status', '-z', '--no-renames', baseCommit, '--',
    ]).stdout)
    git(['read-tree', indexBase])
    if (process.platform === 'win32' && preserveHead && paths.length) {
      const unselected = changes().filter((change) => !paths.some(
        (selected) => change.path === selected || change.path.startsWith(`${selected}/`),
      ))
      if (unselected.length) git(['reset', '-q', baseCommit, '--', ...unselected.map((change) => change.path)])
    }
    git(['-c', `core.filemode=${process.platform === 'win32' ? 'false' : 'true'}`,
      'add', '-A', '--', ...(paths.length ? paths : ['.'])])
    for (const artifact of providerArtifacts) {
      let canonical
      try {
        canonical = realpathSync(path.resolve(root, artifact))
      } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') continue
        throw error
      }
      if (canonical === root) throw new Error('Provider artifact cannot be the worktree root')
      const relative = containedRelative(root, canonical)
      if (!relative) continue
      const portable = relativeSourcePath(relative.split(path.sep).join('/'))
      git(['reset', '-q', baseCommit, '--', portable])
    }
    const selectedChanges = changes()
    const candidateTree = git(['write-tree']).stdout.trim()
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(candidateTree)) {
      throw new Error('Invalid Git candidate-tree identity')
    }
    const checked = git([
      'diff', '--cached', '--check', '--no-color', '--no-ext-diff', '--no-textconv', baseCommit, '--',
    ], true)
    result = {
      passed: checked.status === 0, baseCommit, candidateTree,
      changes: selectedChanges, diagnostics: checked.stdout,
    }
  } catch (error) {
    failure = error
  }
  const cleanupErrors = []
  for (const file of [index, `${index}.lock`]) {
    try {
      unlinkSync(file)
    } catch (error) {
      if (error.code !== 'ENOENT') cleanupErrors.push(error)
    }
  }
  try {
    // Do not recursively remove unexpected files or broaden cleanup to the caller's directory.
    rmdirSync(directory)
  } catch (error) {
    cleanupErrors.push(error)
  }
  if (cleanupErrors.length) {
    throw new AggregateError(
      [...(failure ? [failure] : []), ...cleanupErrors],
      `Deliverable diff cleanup failed; inspect owned directory ${directory}`,
    )
  }
  if (failure) throw failure
  return result
}

export function main(args = process.argv.slice(2)) {
  try {
    const { values } = parseArgs({
      args,
      options: {
        repo: { type: 'string' },
        base: { type: 'string' },
        path: { type: 'string', multiple: true },
        'provider-artifact': { type: 'string', multiple: true },
        'preserve-head': { type: 'string' },
        'scratch-root': { type: 'string' },
        'timeout-ms': { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    })
    if (values.help) {
      console.log('Usage: node tools/check_deliverable_diff.mjs --base <export-base> --scratch-root <existing-directory-outside-worktree> [--repo <worktree-root>] [--path <literal-relative-path>]... [--provider-artifact <filesystem-path>]... [--preserve-head <verified-head>] [--timeout-ms <1..120000>]')
      return 0
    }
    const result = checkDeliverableDiff({
      repository: values.repo,
      base: values.base,
      scratchRoot: values['scratch-root'],
      paths: values.path,
      providerArtifacts: values['provider-artifact'],
      preserveHead: values['preserve-head'],
      timeoutMs: values['timeout-ms'] === undefined ? undefined : Number(values['timeout-ms']),
    })
    console.log(JSON.stringify(result, null, 2))
    return result.passed ? 0 : 1
  } catch (error) {
    console.error(`Deliverable diff check error: ${error.message}`)
    return 2
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main()
}
