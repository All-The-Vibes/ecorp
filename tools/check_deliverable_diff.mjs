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
const GIT_OPERATIONS = ['rev-parse', 'read-tree', 'reset', 'add', 'diff', 'write-tree']
const failureReports = new WeakMap()

// Only fixed diagnostics and allowlisted native metadata cross the CLI boundary.
// Child messages/stderr, argv and filesystem paths are not safely redactable.
function nativeDiagnostic(error, operation = 'check') {
  const code = [
    'ETIMEDOUT', 'ENOBUFS', 'ENOENT', 'EACCES', 'EPERM', 'ENOEXEC', 'EAGAIN',
    'EMFILE', 'ENFILE', 'ENOMEM', 'ENOTDIR', 'EIO', 'ENOSPC', 'ENOTEMPTY', 'EBUSY', 'EROFS',
    'ERR_ENCODING_INVALID_ENCODED_DATA', 'ERR_PARSE_ARGS_UNKNOWN_OPTION',
    'ERR_PARSE_ARGS_INVALID_OPTION_VALUE', 'ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL',
  ].includes(error?.code) ? error.code : null
  const signal = ['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGABRT', 'SIGSEGV', 'SIGHUP', 'SIGQUIT', 'SIGPIPE']
    .includes(error?.signal) ? error.signal : null
  const status = Number.isInteger(error?.status) && error.status >= -2147483648
    && error.status <= 4294967295 ? error.status : null
  const category = code === 'ETIMEDOUT' ? 'timeout'
    : code === 'ENOBUFS' ? 'output-limit'
      : code === 'ERR_ENCODING_INVALID_ENCODED_DATA' ? 'invalid-output'
        : code?.startsWith('ERR_PARSE_ARGS_') ? 'invalid-input'
          : code ? (GIT_OPERATIONS.includes(operation) ? 'spawn-failed' : 'filesystem')
            : signal ? 'signal' : status !== null ? 'git-exit' : 'unknown-error'
  return { operation, category, code, status, signal }
}

function failureReport(error) {
  return failureReports.get(error) ?? { original: nativeDiagnostic(error), cleanup: [] }
}

// Call only with authored text, never input values or native error messages.
function checkError(message, category = 'invalid-input') {
  const error = new Error(message)
  failureReports.set(error, { original: { operation: 'check', category, message }, cleanup: [] })
  return error
}

function relativeSourcePath(value) {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > 500
    || /^\p{White_Space}|\p{White_Space}$/u.test(value) || /[\\:\p{Cc}]/u.test(value)
    || value.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw checkError('Source paths must be portable, literal repository-relative paths')
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
    throw checkError('Malformed Git name-status output', 'invalid-output')
  }
  const changes = []
  for (let i = 0; i < fields.length; i += 2) {
    if (!/^[ADMT]$/.test(fields[i])) throw checkError('Unexpected Git change status', 'invalid-output')
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
    throw checkError('An explicit export base is required')
  }
  if (!scratchRoot) throw checkError('An existing scratch root outside the worktree is required')
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    throw checkError('Timeout must be an integer from 1 to 120000 milliseconds')
  }
  if (!Array.isArray(paths) || !Array.isArray(providerArtifacts)
    || paths.length > MAX_PATHS || providerArtifacts.length > MAX_PATHS) {
    throw checkError('At most 256 source paths and 256 provider artifacts are supported')
  }
  paths.forEach(relativeSourcePath)
  if (providerArtifacts.some((value) => typeof value !== 'string' || !value || value.includes('\0'))) {
    throw checkError('Provider artifact paths must be nonempty filesystem paths')
  }
  if (preserveHead !== undefined
    && (typeof preserveHead !== 'string' || !preserveHead || preserveHead.includes('\0'))) {
    throw checkError('Preserved head must be a commit revision')
  }
  // Never let inherited Git routing redirect the check to a different checkout.
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE']) {
    if (process.env[key]) throw checkError(`Unset ${key} before checking a deliverable`)
  }
  const root = realpathSync(repository)
  const scratch = realpathSync(scratchRoot)
  if (scratch === root || containedRelative(root, scratch)) {
    throw checkError('Scratch root must be outside the source worktree')
  }
  const scratchDirectory = `ecorp-diff-check-${randomUUID()}`
  const directory = path.join(scratch, scratchDirectory)
  mkdirSync(directory, { mode: 0o700 })
  const index = path.join(directory, 'index')
  const deadline = performance.now() + timeoutMs
  const env = {
    ...process.env,
    GIT_INDEX_FILE: index,
    GIT_LITERAL_PATHSPECS: '1',
    GIT_OPTIONAL_LOCKS: '0',
  }
  // Tracing can create files during the first rev-parse and add them to the
  // candidate on the later add -A. Remove it before every native Git child.
  for (const key of Object.keys(env)) {
    if (/^GIT_TRACE/i.test(key) || /^GIT_CURL_VERBOSE$/i.test(key)) delete env[key]
  }
  function git(args, check = false) {
    const command = args[0] === '-c' ? args[2] : args[0]
    const operation = GIT_OPERATIONS.includes(command) ? command : 'unknown'
    const remaining = Math.ceil(deadline - performance.now())
    if (remaining <= 0) throw checkError('Deliverable diff check timed out', 'timeout')
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
      const diagnostic = nativeDiagnostic(error, operation)
      if (diagnostic.category === 'git-exit') {
        if (operation === 'rev-parse' && args.includes('--verify')) diagnostic.category = 'revision-resolution-failed'
        if (operation === 'add') diagnostic.category = 'source-selection-failed'
        // Recognize only known fatal diagnostic shapes and emit fixed categories,
        // never matched text. Unknown/localized stderr keeps the step-level category.
        const stderr = Buffer.isBuffer(error.stderr) && error.stderr.length <= MAX_OUTPUT
          ? error.stderr.toString('utf8') : ''
        // Fixed string scans are linear even on repeated hostile delimiters.
        // Only the final line can match; trim one optional Git line ending.
        let text = stderr.endsWith('\n') ? stderr.slice(0, -1) : stderr
        if (text.endsWith('\r')) text = text.slice(0, -1)
        const line = text.slice(text.lastIndexOf('\n') + 1)
        if (operation === 'rev-parse' && text === 'fatal: Needed a single revision') {
          diagnostic.category = 'revision-unavailable'
        }
        if (operation === 'add' && !line.includes('\r')) {
          const prefix = "fatal: pathspec '"
          const suffix = "' did not match any files"
          const delimiter = ": clean filter '"
          const at = line.indexOf(delimiter, 'fatal: '.length + 1)
          if (line.startsWith(prefix) && line.endsWith(suffix) && line.length >= prefix.length + suffix.length) {
            diagnostic.category = 'missing-path'
          } else if (line.startsWith('fatal: ') && at > 'fatal: '.length
            && line.endsWith("' failed") && at + delimiter.length < line.length - "' failed".length) {
            diagnostic.category = 'clean-filter-failed'
          }
        }
      }
      const reason = diagnostic.code === 'ETIMEDOUT' ? 'timed out'
        : diagnostic.code === 'ENOBUFS' ? 'exceeded the output limit'
          : diagnostic.code === 'ENOENT' ? 'could not start Git'
            : `failed (${diagnostic.signal ?? diagnostic.status ?? diagnostic.code ?? 'unknown'})`
      const failure = new Error(`Deliverable Git ${operation} ${reason}`, { cause: error })
      failureReports.set(failure, { original: diagnostic, cleanup: [] })
      throw failure
    }
  }
  let result
  let failure
  try {
    if (realpathSync(git(['rev-parse', '--show-toplevel']).stdout.trim()) !== root) {
      throw checkError('Repository must be the worktree root, not a subdirectory')
    }
    function commit(revision) {
      const oid = git(['rev-parse', '--verify', '--end-of-options', `${revision}^{commit}`]).stdout.trim()
      if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid)) throw checkError('Invalid Git commit identity', 'invalid-output')
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
      if (canonical === root) throw checkError('Provider artifact cannot be the worktree root')
      const relative = containedRelative(root, canonical)
      if (!relative) continue
      const portable = relativeSourcePath(relative.split(path.sep).join('/'))
      git(['reset', '-q', baseCommit, '--', portable])
    }
    const selectedChanges = changes()
    const candidateTree = git(['write-tree']).stdout.trim()
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(candidateTree)) {
      throw checkError('Invalid Git candidate-tree identity', 'invalid-output')
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
  const cleanup = []
  for (const [file, operation] of [[index, 'unlink-index'], [`${index}.lock`, 'unlink-lock']]) {
    try {
      unlinkSync(file)
    } catch (error) {
      if (error.code !== 'ENOENT') {
        cleanupErrors.push(error)
        cleanup.push(nativeDiagnostic(error, operation))
      }
    }
  }
  try {
    // Do not recursively remove unexpected files or broaden cleanup to the caller's directory.
    rmdirSync(directory)
  } catch (error) {
    cleanupErrors.push(error)
    cleanup.push(nativeDiagnostic(error, 'rmdir'))
  }
  if (cleanupErrors.length) {
    const error = new AggregateError(
      [...(failure ? [failure] : []), ...cleanupErrors],
      `Deliverable diff cleanup failed; inspect owned directory ${directory}`,
    )
    failureReports.set(error, { original: failure ? failureReport(failure).original : null, cleanup, scratchDirectory })
    throw error
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
    console.error(JSON.stringify({
      error: 'deliverable-diff-check', ...failureReport(error),
      details: 'Untrusted error details suppressed',
    }))
    return 2
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main()
}
