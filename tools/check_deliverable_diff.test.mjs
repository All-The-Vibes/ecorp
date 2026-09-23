import assert from 'node:assert/strict'
import childProcess, { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync,
  rmSync, statSync, writeFileSync,
} from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { checkDeliverableDiff } from './check_deliverable_diff.mjs'

const checkout = fileURLToPath(new URL('../', import.meta.url))
const command = fileURLToPath(new URL('./check_deliverable_diff.mjs', import.meta.url))
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const nativeSource = readFileSync(path.join(checkout, 'crates', 'crony-runner', 'src', 'deliverable.rs'), 'utf8')
  .replaceAll('\r\n', '\n')

function withEnv(name, value, action) {
  const previous = process.env[name]
  process.env[name] = value
  try {
    return action()
  } finally {
    if (previous === undefined) delete process.env[name]
    else process.env[name] = previous
  }
}

function fixture(t) {
  const output = process.env.ECORP_DIFF_TEST_ROOT || path.join(checkout, 'output')
  mkdirSync(output, { recursive: true })
  const owned = mkdtempSync(path.join(output, 'issue81-diff-'))
  const repo = path.join(owned, 'source with spaces & [literal]')
  const scratchRoot = path.join(owned, 'owned scratch')
  mkdirSync(repo)
  mkdirSync(scratchRoot)
  if (!process.env.ECORP_DIFF_TEST_ROOT) t.after(() => rmSync(owned, { recursive: true, force: false }))
  const git = (args, options = {}) => execFileSync('git', args, {
    cwd: repo, encoding: 'utf8', windowsHide: true, timeout: 10_000,
    stdio: ['ignore', 'pipe', 'pipe'], ...options,
  })
  const write = (name, text) => {
    const target = path.join(repo, name)
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, text)
  }
  git(['init', '-b', 'main'])
  git(['config', 'user.name', 'Deliverable diff test'])
  git(['config', 'user.email', 'test@example.invalid'])
  git(['config', 'commit.gpgsign', 'false'])
  git(['config', 'core.autocrlf', 'false'])
  git(['config', 'core.whitespace', 'blank-at-eol,blank-at-eof,space-before-tab,cr-at-eol'])
  git(['config', 'core.hooksPath', scratchRoot])
  write('tracked.txt', 'original\n')
  write('other.txt', 'other\n')
  write('provider.md', 'original evidence\n')
  write('.gitignore', 'ignored/\n.codex/\n*.log\n')
  git(['add', '-A'])
  git(['commit', '-m', 'base'])
  const base = git(['rev-parse', 'HEAD']).trim()
  const options = { repository: repo, scratchRoot, base }
  function snapshot() {
    const files = {}
    function walk(directory, prefix = '') {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (prefix === '' && entry.name === '.git') continue
        const name = prefix + entry.name
        if (entry.isDirectory()) walk(path.join(directory, entry.name), `${name}/`)
        else files[name] = hash(readFileSync(path.join(directory, entry.name)))
      }
    }
    walk(repo)
    const index = path.resolve(repo, git(['rev-parse', '--git-path', 'index']).trim())
    return {
      files, index: existsSync(index) ? hash(readFileSync(index)) : null,
      head: git(['rev-parse', 'HEAD']).trim(),
      refs: git(['show-ref']),
    }
  }
  function check(overrides = {}) {
    const before = snapshot()
    try {
      return checkDeliverableDiff({ ...options, ...overrides })
    } finally {
      assert.deepEqual(snapshot(), before, 'source bytes, real index, HEAD and refs are unchanged')
      assert.deepEqual(readdirSync(scratchRoot), [], 'only the owned disposable index was removed')
    }
  }
  let invocation = 0
  function cli(args = [], { inject, cleanup = true, timeout = 15_000 } = {}) {
    const before = snapshot()
    const log = path.join(owned, `cli-${++invocation}`)
    const nodeArgs = []
    if (inject) {
      const preload = `${log}.mjs`
      writeFileSync(preload, inject)
      nodeArgs.push('--import', pathToFileURL(preload).href)
    }
    const started = performance.now()
    const result = spawnSync(process.execPath, [
      ...nodeArgs, command, '--repo', repo, '--base', base, '--scratch-root', scratchRoot, ...args,
    ], { encoding: 'utf8', timeout, windowsHide: true })
    const elapsedMs = performance.now() - started
    if (process.env.ECORP_DIFF_TEST_ROOT) {
      writeFileSync(`${log}.stdout`, result.stdout ?? '')
      writeFileSync(`${log}.stderr`, result.stderr ?? '')
      writeFileSync(`${log}.json`, JSON.stringify({
        args, status: result.status, errorCode: result.error?.code ?? null,
        signal: result.signal, elapsedMs, watchdogMs: timeout,
        before, after: snapshot(), scratch: readdirSync(scratchRoot),
      }, null, 2))
    }
    assert.equal(result.error?.code, undefined, 'CLI must exit before the external watchdog')
    assert.deepEqual(snapshot(), before)
    if (cleanup) assert.deepEqual(readdirSync(scratchRoot), [])
    return result
  }
  return { owned, repo, scratchRoot, git, write, base, options, snapshot, check, cli }
}

function windowsShortAlias(f, t, target) {
  const script = path.join(f.owned, 'short-alias.ps1')
  writeFileSync(script, `param([string]$Target)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class DiffShortPath {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern uint GetShortPathName(string path, StringBuilder output, uint size);
}
'@
$buffer = [Text.StringBuilder]::new(32768)
$length = [DiffShortPath]::GetShortPathName($Target, $buffer, $buffer.Capacity)
if (!$length -or $length -ge $buffer.Capacity) { throw 'Native short-path lookup failed.' }
$buffer.ToString()
`)
  const alias = execFileSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', script,
    '-Target', target], { encoding: 'utf8', windowsHide: true, timeout: 15_000 }).trim()
  if (alias.toLowerCase() === path.resolve(target).toLowerCase()) {
    t.skip('This volume does not expose a distinct native 8.3 alias')
    return null
  }
  assert.equal(realpathSync.native(alias), realpathSync.native(target), 'the alias denotes the same native object')
  t.diagnostic('Executed with a distinct native Windows 8.3 alias')
  return alias
}

test('Windows short alias repository uses the same native source identity', { skip: process.platform !== 'win32' }, t => {
  const f = fixture(t)
  const alias = windowsShortAlias(f, t, f.repo)
  if (!alias) return
  f.write('tracked.txt', 'updated source\n')
  assert.deepEqual(f.check({ repository: alias }), f.check())
})

test('Windows short alias scratch inside source rejects before creating an index', { skip: process.platform !== 'win32' }, t => {
  const f = fixture(t)
  const alias = windowsShortAlias(f, t, f.repo)
  if (!alias) return
  const before = f.snapshot()
  assert.throws(() => checkDeliverableDiff({ ...f.options, scratchRoot: alias }), /outside the source worktree/)
  assert.deepEqual(f.snapshot(), before, 'no temporary directory, source file or real index may change')
  assert.deepEqual(readdirSync(f.scratchRoot), [])
})

test('Windows short alias provider artifact is excluded from the candidate', { skip: process.platform !== 'win32' }, t => {
  const f = fixture(t)
  const artifact = path.join(f.repo, 'provider artifact long filename.md')
  f.write('provider artifact long filename.md', 'provider-only evidence\n')
  f.write('tracked.txt', 'updated source\n')
  const alias = windowsShortAlias(f, t, artifact)
  if (!alias) return
  const expected = f.check({ providerArtifacts: [artifact] })
  assert.deepEqual(expected.changes, [{ status: 'M', path: 'tracked.txt' }])
  assert.deepEqual(f.check({ providerArtifacts: [alias] }), expected)
})

for (const name of ['GIT_TRACE', 'GIT_TRACE_PERFORMANCE', 'GIT_TRACE_SETUP',
  'GIT_TRACE2', 'GIT_TRACE2_EVENT', 'GIT_TRACE2_PERF']) {
  test(`native ${name} isolation protects source bytes and candidate tree`, (t) => {
    const f = fixture(t)
    f.write('tracked.txt', 'intentional change\n')
    const before = f.snapshot()
    const trace = path.join(f.repo, 'inherited-trace.txt')
    // Snapshot Git calls must run outside the injected environment so only
    // the production checker can create this nonignored source file.
    const result = withEnv(name, trace, () => checkDeliverableDiff(f.options))
    assert.equal(existsSync(trace), false, 'no inherited trace may write into the source')
    assert.deepEqual(f.snapshot(), before, 'source, real index, HEAD and refs remain unchanged')
    assert.equal(result.passed, true)
    assert.deepEqual(result.changes, [{ status: 'M', path: 'tracked.txt' }])
    assert.deepEqual(readdirSync(f.scratchRoot), [])
  })
}

// Independent replay of deliverable.rs's native Git recipe. The source hash
// below requires re-auditing this oracle when that recipe changes.
function nativeCandidate(f, { paths = [], providerArtifacts = [], preserveHead } = {}) {
  const index = path.join(f.scratchRoot, 'oracle.index')
  const env = { ...process.env, GIT_INDEX_FILE: index, GIT_LITERAL_PATHSPECS: '1' }
  for (const name of Object.keys(env)) {
    if (/^GIT_TRACE|^GIT_CURL_VERBOSE$/i.test(name)) delete env[name]
  }
  const git = (args) => f.git(args, { env })
  const changes = () => git(['diff', '--cached', '--name-status', '-z', '--no-renames', f.base, '--'])
  try {
    git(['read-tree', process.platform === 'win32' && preserveHead ? preserveHead : f.base])
    if (process.platform === 'win32' && preserveHead && paths.length) {
      const fields = changes().split('\0').slice(0, -1)
      const reset = []
      for (let i = 1; i < fields.length; i += 2) {
        if (!paths.some((selected) => fields[i] === selected || fields[i].startsWith(`${selected}/`))) {
          reset.push(fields[i])
        }
      }
      if (reset.length) git(['reset', '-q', f.base, '--', ...reset])
    }
    git(['-c', `core.filemode=${process.platform === 'win32' ? 'false' : 'true'}`,
      'add', '-A', '--', ...(paths.length ? paths : ['.'])])
    for (const artifact of providerArtifacts) {
      const absolute = path.resolve(f.repo, artifact)
      if (!existsSync(absolute)) continue
      const relative = path.relative(realpathSync(f.repo), realpathSync(absolute))
      if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) continue
      git(['reset', '-q', f.base, '--', relative.split(path.sep).join('/')])
    }
    const tree = git(['write-tree']).trim()
    const patch = git(['diff', '--cached', '--binary', '--full-index', '--no-color', f.base, '--'])
    return { tree, patch, changes: changes() }
  } finally {
    if (existsSync(index)) rmSync(index)
  }
}

test('native source-selection recipe is pinned; drift requires an explicit parity review', () => {
  const start = nativeSource.indexOf('    for path in &spec.paths {')
  const end = nativeSource.indexOf('    let changes = changed_paths(', start)
  assert.ok(start >= 0 && end > start)
  assert.equal(hash(nativeSource.slice(start, end)), '6f6ded948c846fa95c5fb8fe7b0c748e444c1f16800e72dfb42fb781090e4519')
  const output = nativeSource.slice(nativeSource.indexOf('async fn git_output('))
  assert.match(output, /\.env\("GIT_INDEX_FILE", index\)/)
  assert.match(output, /\.env\("GIT_LITERAL_PATHSPECS", "1"\)/)
})

test('RED untracked whitespace escapes old diff, fails new command; GREEN clean file passes', (t) => {
  const f = fixture(t)
  f.write('new source.txt', 'new source \r\n')
  assert.equal(f.git(['diff', '--check']), '', 'old verifier misses the actual deliverable')
  const red = f.cli()
  assert.equal(red.status, 1)
  const failure = JSON.parse(red.stdout)
  assert.equal(failure.passed, false)
  assert.match(failure.diagnostics, /new source\.txt:1: trailing whitespace/)
  assert.deepEqual(failure.changes, [{ status: 'A', path: 'new source.txt' }])
  assert.equal(failure.candidateTree, nativeCandidate(f).tree)
  f.write('new source.txt', 'new source\r\n')
  const green = f.cli()
  assert.equal(green.status, 0, green.stderr)
  assert.equal(JSON.parse(green.stdout).passed, true)
  assert.equal(JSON.parse(green.stdout).candidateTree, nativeCandidate(f).tree)
})

for (const name of ['tracked', 'staged modification', 'staged addition']) {
  test(`checks ${name} bytes that are present in the worktree`, (t) => {
    const f = fixture(t)
    const file = name === 'staged addition' ? 'added.txt' : 'tracked.txt'
    f.write(file, 'bad \n')
    if (name.startsWith('staged')) f.git(['add', '--', file])
    const result = f.check()
    assert.equal(result.passed, false)
    assert.equal(result.candidateTree, nativeCandidate(f).tree)
  })
}

test('staged-only bad bytes are not exported when the worktree has clean replacement bytes', (t) => {
  const f = fixture(t)
  f.write('tracked.txt', 'index only bad \n')
  f.git(['add', 'tracked.txt'])
  f.write('tracked.txt', 'clean replacement\n')
  assert.throws(() => f.git(['diff', '--cached', '--check']))
  assert.equal(f.check().passed, true)
  const native = nativeCandidate(f)
  assert.equal(f.check().candidateTree, native.tree)
  assert.match(native.patch, /\+clean replacement/)
  assert.doesNotMatch(native.patch, /index only bad/)
})

test('clean staged bytes cannot hide bad worktree bytes or revive staged-only deleted additions', (t) => {
  const f = fixture(t)
  f.write('tracked.txt', 'staged clean\n')
  f.write('staged-only.txt', 'not in worktree \n')
  f.git(['add', '-A'])
  f.write('tracked.txt', 'worktree bad \n')
  rmSync(path.join(f.repo, 'staged-only.txt'))
  const result = f.check()
  assert.equal(result.passed, false)
  assert.equal(result.candidateTree, nativeCandidate(f).tree)
  assert.deepEqual(result.changes, [{ status: 'M', path: 'tracked.txt' }])
})

test('assigned base, not current HEAD, determines committed changes, deletions and renamed source', (t) => {
  const f = fixture(t)
  f.write('tracked.txt', 'committed bad \n')
  f.git(['add', 'tracked.txt'])
  f.git(['commit', '-m', 'provider commit'])
  f.git(['mv', 'other.txt', 'renamed.txt'])
  const result = f.check()
  assert.equal(result.passed, false)
  assert.equal(result.baseCommit, f.base)
  assert.equal(result.candidateTree, nativeCandidate(f).tree)
  assert.deepEqual(result.changes.map((change) => change.status), ['D', 'A', 'M'])
})

test('conflicted real index is untouched; physical resolution is checked just like native export', (t) => {
  const f = fixture(t)
  f.git(['checkout', '-b', 'side'])
  f.write('tracked.txt', 'side\n')
  f.git(['commit', '-am', 'side'])
  f.git(['checkout', 'main'])
  f.write('tracked.txt', 'main\n')
  f.git(['commit', '-am', 'main'])
  assert.throws(() => f.git(['merge', 'side']))
  assert.notEqual(f.git(['ls-files', '--unmerged']), '')
  const unresolved = f.check()
  assert.equal(unresolved.passed, false)
  assert.match(unresolved.diagnostics, /leftover conflict marker/)
  f.write('tracked.txt', 'resolved physical bytes\n')
  assert.equal(f.check().passed, true)
  assert.equal(f.check().candidateTree, nativeCandidate(f).tree)
  assert.notEqual(f.git(['ls-files', '--unmerged']), '')
})

test('literal selection, spaces, leading dash, Unicode and brackets do not become Git pathspecs', (t) => {
  const f = fixture(t)
  f.write('folder [1]/résumé.txt', 'clean\n')
  f.write('folder 1/résumé.txt', 'must not be selected \n')
  f.write("O'Brien.txt", 'clean apostrophe\n')
  f.write('-source.txt', 'clean dash\n')
  f.write('tracked.txt', 'unselected bad \n')
  const paths = ['folder [1]', '-source.txt', "O'Brien.txt"]
  const result = f.check({ paths })
  assert.equal(result.passed, true)
  assert.equal(result.candidateTree, nativeCandidate(f, { paths }).tree)
  assert.deepEqual(result.changes.map((change) => change.path), ['-source.txt', "O'Brien.txt", 'folder [1]/résumé.txt'])
  const cli = f.cli(['--path', 'folder [1]', '--path=-source.txt', '--path', "O'Brien.txt"])
  assert.equal(cli.status, 0, cli.stderr)
})

test('selected absent, explicitly ignored and magic/escaping paths fail rather than widen selection', (t) => {
  const f = fixture(t)
  f.write('ignored/evidence.md', 'ignored \n')
  for (const paths of [['missing.txt'], ['ignored/evidence.md'], [':(exclude)tracked.txt'],
    ['../outside'], ['C:/outside'], ['folder\\file'], ['a//b'], ['.'], ['/absolute']]) {
    assert.throws(() => f.check({ paths }))
  }
})

test('ignored evidence and runner-internal files are absent; provider artifacts reset to base, not deletion', (t) => {
  const f = fixture(t)
  f.write('ignored/provider.md', 'ignored \n')
  f.write('.codex/session.txt', 'runner internal \n')
  f.write('runtime.log', 'ignored by Git \n')
  f.write('provider.md', 'tracked evidence \n')
  f.write('new evidence [1].md', 'new evidence \n')
  f.write('source.txt', 'actual source\n')
  const outside = path.join(f.owned, 'outside evidence.md')
  writeFileSync(outside, 'outside\n')
  const providerArtifacts = ['provider.md', path.join(f.repo, 'new evidence [1].md'), 'missing.md', outside]
  const result = f.check({ providerArtifacts })
  assert.equal(result.passed, true)
  assert.deepEqual(result.changes, [{ status: 'A', path: 'source.txt' }])
  const native = nativeCandidate(f, { providerArtifacts })
  assert.equal(result.candidateTree, native.tree)
  assert.doesNotMatch(native.patch, /evidence|runner internal/)
  assert.equal(f.check().passed, false, 'unlisted, nonignored evidence is not silently excluded')
})

test('ignored files tracked by the seeded base remain selected; later ignored additions do not', (t) => {
  const f = fixture(t)
  f.write('ignored/tracked.txt', 'before\n')
  f.git(['add', '-f', 'ignored/tracked.txt'])
  f.git(['commit', '-m', 'tracked ignore'])
  const base = f.git(['rev-parse', 'HEAD']).trim()
  f.write('ignored/tracked.txt', 'after \n')
  const oldBase = f.check()
  assert.equal(oldBase.passed, true)
  assert.equal(oldBase.candidateTree, nativeCandidate(f).tree)
  const result = f.check({ base })
  assert.equal(result.passed, false)
  assert.equal(result.candidateTree, nativeCandidate({ ...f, base }).tree)
  assert.match(result.diagnostics, /ignored\/tracked.txt/)
})

test('CRLF conversion and attributes use Git blob bytes without rewriting source or index', (t) => {
  const f = fixture(t)
  f.git(['config', 'core.autocrlf', 'true'])
  f.write('.gitattributes', '*.txt text eol=lf\n')
  f.write('new windows.txt', 'line one\r\nline two\r\n')
  const result = f.check()
  assert.equal(result.passed, true)
  assert.equal(result.candidateTree, nativeCandidate(f).tree)
  assert.equal(f.git(['show', `${result.candidateTree}:new windows.txt`]), 'line one\nline two\n')
  assert.equal(readFileSync(path.join(f.repo, 'new windows.txt'), 'utf8'), 'line one\r\nline two\r\n')
  f.write('new windows.txt', 'line one \r\n')
  assert.equal(f.check().passed, false)
})

test('Windows verified-head seeding retains modes and resets every unselected committed path', (t) => {
  const f = fixture(t)
  f.git(['update-index', '--chmod=+x', 'tracked.txt'])
  f.write('other.txt', 'unselected committed \n')
  f.git(['add', 'other.txt'])
  f.git(['commit', '-m', 'verified head'])
  const preserveHead = f.git(['rev-parse', 'HEAD']).trim()
  f.write('tracked.txt', 'selected\n')
  const options = { paths: ['tracked.txt'], preserveHead }
  const result = f.check(options)
  assert.equal(result.passed, true)
  assert.deepEqual(result.changes, [{ status: 'M', path: 'tracked.txt' }])
  assert.equal(result.candidateTree, nativeCandidate(f, options).tree)
  if (process.platform === 'win32') {
    assert.match(f.git(['ls-tree', result.candidateTree, 'tracked.txt']), /^100755/)
  }
  assert.equal(f.git(['show', `${result.candidateTree}:other.txt`]), 'other\n')
})

test('binary blobs use native Git diff behavior, not an independent text scanner', (t) => {
  const f = fixture(t)
  f.write('binary.bin', Buffer.from([0, 65, 32, 10]))
  const result = f.check()
  assert.equal(result.passed, true)
  assert.equal(result.candidateTree, nativeCandidate(f).tree)
})

test('a missing real index is neither read nor recreated', (t) => {
  const f = fixture(t)
  rmSync(path.join(f.repo, '.git', 'index'))
  f.write('new.txt', 'clean\n')
  assert.equal(f.check().passed, true)
  assert.equal(existsSync(path.join(f.repo, '.git', 'index')), false)
})

test('linked worktree Git control files and real index are not modified', (t) => {
  const f = fixture(t)
  const linked = path.join(f.owned, 'linked source [2]')
  f.git(['worktree', 'add', '-b', 'linked', linked, f.base])
  writeFileSync(path.join(linked, 'new source.txt'), 'linked source \n')
  const index = path.resolve(linked, execFileSync('git', ['rev-parse', '--git-path', 'index'], {
    cwd: linked, encoding: 'utf8', windowsHide: true, timeout: 10_000,
  }).trim())
  const before = {
    index: hash(readFileSync(index)),
    control: hash(readFileSync(path.join(linked, '.git'))),
    source: hash(readFileSync(path.join(linked, 'new source.txt'))),
  }
  const result = f.check({ repository: linked })
  assert.equal(result.passed, false)
  assert.equal(result.candidateTree, nativeCandidate({
    ...f,
    repo: linked,
    git: (args, options) => execFileSync('git', args, {
      cwd: linked, encoding: 'utf8', windowsHide: true, timeout: 10_000,
      stdio: ['ignore', 'pipe', 'pipe'], ...options,
    }),
  }).tree)
  assert.deepEqual({
    index: hash(readFileSync(index)),
    control: hash(readFileSync(path.join(linked, '.git'))),
    source: hash(readFileSync(path.join(linked, 'new source.txt'))),
  }, before)
})

test('invalid base, routing override, nested root and in-worktree scratch fail closed', (t) => {
  const f = fixture(t)
  assert.throws(() => f.check({ base: 'does-not-exist' }), /Git rev-parse failed/)
  assert.throws(() => f.check({ base: '--help' }), /Git rev-parse failed/)
  assert.throws(() => f.check({ repository: path.join(f.repo, 'ignored') }))
  f.write('nested/source.txt', 'source\n')
  assert.throws(() => f.check({ repository: path.join(f.repo, 'nested') }), /worktree root/)
  assert.throws(() => f.check({ scratchRoot: f.repo }), /outside/)
  assert.throws(() => f.check({ scratchRoot: path.join(f.repo, 'nested') }), /outside/)
  withEnv('GIT_WORK_TREE', f.repo, () => {
    assert.throws(() => f.check(), /Unset GIT_WORK_TREE/)
  })
  assert.throws(() => f.check({ providerArtifacts: [f.repo] }), /worktree root/)
})

test('an inherited alternate index is not used or changed', (t) => {
  const f = fixture(t)
  const other = path.join(f.owned, 'must not touch.index')
  writeFileSync(other, 'not an index')
  withEnv('GIT_INDEX_FILE', other, () => {
    assert.equal(checkDeliverableDiff(f.options).passed, true)
  })
  assert.equal(readFileSync(other, 'utf8'), 'not an index')
  assert.deepEqual(readdirSync(f.scratchRoot), [])
})

test('whole-check timeout is a command error, never whitespace success', (t) => {
  const f = fixture(t)
  const result = f.cli(['--timeout-ms', '1'])
  assert.equal(result.status, 2)
  assert.equal(JSON.parse(result.stderr).original.category, 'timeout')
  assert.equal(result.stdout, '')
})

test('spawn, buffer, signal and Git failures cannot masquerade as whitespace results', (t) => {
  const f = fixture(t)
  const original = childProcess.execFileSync
  for (const error of [
    Object.assign(new Error('missing Git'), { code: 'ENOENT' }),
    Object.assign(new Error('timeout'), { code: 'ETIMEDOUT', status: 2, stdout: Buffer.from('partial') }),
    Object.assign(new Error('overflow'), { code: 'ENOBUFS', status: 2, stdout: Buffer.from('partial') }),
    Object.assign(new Error('signal'), { signal: 'SIGTERM', status: null }),
    Object.assign(new Error('fatal'), { status: 128 }),
    Object.assign(new Error('no diagnostics'), { status: 2, stdout: Buffer.alloc(0) }),
  ]) {
    const before = f.snapshot()
    const mocked = t.mock.method(childProcess, 'execFileSync', (program, args, options) => {
      assert.equal(program, 'git')
      assert.equal(options.shell, undefined)
      assert.ok(options.timeout > 0 && options.timeout <= 30_000)
      assert.equal(options.maxBuffer, 8 * 1024 * 1024)
      if (args.includes('--check')) throw error
      return original(program, args, options)
    })
    syncBuiltinESMExports()
    try {
      assert.throws(() => checkDeliverableDiff(f.options), /Deliverable Git/)
      assert.ok(mocked.mock.callCount() >= 7)
    } finally {
      mocked.mock.restore()
      syncBuiltinESMExports()
    }
    assert.equal(childProcess.execFileSync, original)
    assert.deepEqual(f.snapshot(), before)
    assert.deepEqual(readdirSync(f.scratchRoot), [])
  }
})

test('unexpected scratch contents cause visible cleanup failure and are preserved', (t) => {
  const f = fixture(t)
  const original = childProcess.execFileSync
  const mocked = t.mock.method(childProcess, 'execFileSync', (program, args, options) => {
    if (args[0] === 'read-tree') {
      writeFileSync(path.join(path.dirname(options.env.GIT_INDEX_FILE), 'unexpected.txt'), 'preserve')
      throw Object.assign(new Error('original Git failure'), { status: 128 })
    }
    return original(program, args, options)
  })
  syncBuiltinESMExports()
  try {
    assert.throws(() => checkDeliverableDiff(f.options), (error) => {
      assert.match(error.message, /cleanup failed/)
      assert.equal(error.errors.length, 2)
      assert.match(error.errors[0].message, /Git read-tree failed/)
      return true
    })
  } finally {
    mocked.mock.restore()
    syncBuiltinESMExports()
  }
  const [directory] = readdirSync(f.scratchRoot)
  assert.match(directory, /^ecorp-diff-check-/)
  assert.equal(readFileSync(path.join(f.scratchRoot, directory, 'unexpected.txt'), 'utf8'), 'preserve')
  assert.equal(existsSync(path.join(f.scratchRoot, directory, 'index')), false)
})

test('CLI rejects unknown, missing and unbounded arguments with exit 2', (t) => {
  const f = fixture(t)
  for (const args of [['--unknown'], ['--timeout-ms', '0'], ['--timeout-ms', '120001'],
    ['--timeout-ms', 'NaN'], ['--path', ''], ['--provider-artifact', '']]) {
    const result = f.cli(args)
    assert.equal(result.status, 2, `${args}: ${result.stderr}`)
  }
  assert.throws(() => checkDeliverableDiff({ ...f.options, base: undefined }), /explicit export base/)
  assert.throws(() => checkDeliverableDiff({ ...f.options, scratchRoot: undefined }), /scratch root/)
  assert.throws(() => checkDeliverableDiff({ ...f.options, paths: Array(257).fill('tracked.txt') }), /256/)
  assert.equal(statSync(f.repo).isDirectory(), true)
})

const sensitive = 'F01_SECRET_canary'
function failureReport(result, f) {
  assert.equal(result.status, 2)
  assert.equal(result.stdout, '')
  assert.ok(Buffer.byteLength(result.stderr) <= 4096, 'failure receipt fits native verifier output')
  assert.doesNotMatch(result.stderr.trimEnd(), /[\p{Cc}\p{Cf}]/u)
  for (const hidden of [sensitive, f.repo, f.scratchRoot, f.owned]) {
    assert.ok(!result.stderr.includes(hidden)
      && !result.stderr.includes(JSON.stringify(hidden).slice(1, -1)), 'no raw or JSON-escaped paths/secrets')
  }
  const report = JSON.parse(result.stderr)
  for (const detail of [report.original, ...report.cleanup]) {
    for (const value of Object.values(detail ?? {})) {
      if (typeof value === 'string') assert.doesNotMatch(value, /[\p{Cc}\p{Cf}]/u)
    }
  }
  assert.equal(report.error, 'deliverable-diff-check')
  assert.equal(report.details, 'Untrusted error details suppressed')
  assert.ok(Array.isArray(report.cleanup))
  return report
}

// Replace only the selected child call, in the actual CLI process. All other
// Git operations still use the owned real repository and disposable index.
function injectGit(body, operation = '--check') {
  return `
    import assert from 'node:assert/strict'
    import cp from 'node:child_process'
    import fs from 'node:fs'
    import path from 'node:path'
    import { syncBuiltinESMExports } from 'node:module'
    const original = cp.execFileSync
    cp.execFileSync = (program, args, options) => {
      assert.equal(program, 'git')
      assert.equal(options.shell, undefined)
      assert.equal(options.maxBuffer, 8 * 1024 * 1024)
      assert.ok(options.timeout > 0 && options.timeout <= 30000)
      if (args.includes(${JSON.stringify(operation)})) { ${body} }
      return original(program, args, options)
    }
    syncBuiltinESMExports()
  `
}

for (const [name, args, operation, category, status] of [
  ['unavailable revision', ['--base', `${sensitive}-missing`], 'rev-parse', 'revision-unavailable', 128],
  ['missing literal selection', ['--path', `${sensitive}[missing].txt`], 'add', 'missing-path', 128],
  ['ignored literal selection', ['--path', 'ignored/evidence.md'], 'add', 'source-selection-failed', 1],
]) {
  test(`F01 CLI reports ${name} without exposing arguments`, (t) => {
    const f = fixture(t)
    f.write('ignored/evidence.md', 'ignored\n')
    const report = failureReport(f.cli(args), f)
    assert.deepEqual(report.original, { operation, category, status, code: null, signal: null })
    assert.deepEqual(report.cleanup, [])
  })
}

for (const [name, body, expected] of [
  ['native timeout', `return original(process.execPath, ['-e', 'while (true) {}'], { ...options, timeout: 20 })`,
    { category: 'timeout', code: 'ETIMEDOUT' }],
  ['native output overflow', `return original(process.execPath, ['-e', 'process.stdout.write("x".repeat(9 * 1024 * 1024))'], options)`,
    { category: 'output-limit', code: 'ENOBUFS' }],
  ['native spawn failure', `return original(path.join(path.dirname(options.env.GIT_INDEX_FILE), 'absent-git'), [], options)`,
    { category: 'spawn-failed', code: 'ENOENT', status: null, signal: null }],
  ['signal', `throw Object.assign(new Error('${sensitive}'), { status: null, signal: 'SIGTERM' })`,
    { category: 'signal', code: null, status: null, signal: 'SIGTERM' }],
  ['unrecognized filter failure', `throw Object.assign(new Error('${sensitive}'), { status: 128, stderr: Buffer.from('${sensitive}\\n\\x1b[31mfilter output') })`,
    { category: 'source-selection-failed', code: null, status: 128, signal: null }],
  ['unknown child fields', `throw Object.assign(new Error('${sensitive}'.repeat(2000)), {
      code: '${sensitive}\\n\\x1b[31m', signal: '${sensitive}\\u202e', status: '${sensitive}',
      stderr: Buffer.from('${sensitive}'.repeat(2000)), stdout: Buffer.from('${sensitive}'),
      path: options.cwd, spawnargs: ['https://user:${sensitive}@example.invalid'], env: options.env
    })`,
    { category: 'unknown-error', code: null, status: null, signal: null }],
  ['timeout with whitespace-like output', `throw Object.assign(new Error('${sensitive}'), {
      code: 'ETIMEDOUT', status: 2, stdout: Buffer.from('${sensitive}')
    })`, { category: 'timeout', code: 'ETIMEDOUT', status: 2, signal: null }],
  ['overflow with whitespace-like output', `throw Object.assign(new Error('${sensitive}'), {
      code: 'ENOBUFS', status: 2, stdout: Buffer.from('${sensitive}')
    })`, { category: 'output-limit', code: 'ENOBUFS', status: 2, signal: null }],
]) {
  test(`F01 CLI retains safe ${name} classification`, (t) => {
    const f = fixture(t)
    const operation = name === 'unrecognized filter failure' ? 'add' : 'diff'
    const report = failureReport(f.cli([], { inject: injectGit(body, operation === 'add' ? 'add' : '--check') }), f)
    assert.equal(report.original.operation, operation)
    for (const [key, value] of Object.entries(expected)) assert.equal(report.original[key], value, key)
    assert.deepEqual(report.cleanup, [])
  })
}

for (const originalFailure of [true, false]) {
  test(`F01 CLI separates cleanup failure ${originalFailure ? 'from original failure' : 'after successful check'}`, (t) => {
    const f = fixture(t)
    const inject = injectGit(`
      fs.writeFileSync(path.join(path.dirname(options.env.GIT_INDEX_FILE), 'unexpected.txt'), '${sensitive}')
      ${originalFailure ? `throw Object.assign(new Error('${sensitive}'), { status: 128 })` : ''}
    `, 'read-tree')
    const report = failureReport(f.cli([], { inject, cleanup: false }), f)
    if (originalFailure) {
      assert.deepEqual(report.original, { operation: 'read-tree', category: 'git-exit', code: null, status: 128, signal: null })
    } else assert.equal(report.original, null)
    assert.deepEqual(report.cleanup, [
      { operation: 'rmdir', category: 'filesystem', code: 'ENOTEMPTY', status: null, signal: null },
    ])
    const [directory] = readdirSync(f.scratchRoot)
    assert.match(directory, /^ecorp-diff-check-/)
    assert.equal(readFileSync(path.join(f.scratchRoot, directory, 'unexpected.txt'), 'utf8'), sensitive)
    assert.equal(existsSync(path.join(f.scratchRoot, directory, 'index')), false)
    assert.equal(existsSync(path.join(f.scratchRoot, directory, 'index.lock')), false)
  })
}

test('F01 CLI suppresses unsafe parser/filesystem text and retains safe input guidance', (t) => {
  const f = fixture(t)
  for (const args of [[`--${sensitive}\n\u001b[31m`], ['--repo', path.join(f.owned, sensitive)]]) {
    const report = failureReport(f.cli(args), f)
    assert.ok(['invalid-input', 'filesystem'].includes(report.original.category))
  }
  const report = failureReport(f.cli(['--timeout-ms', '0']), f)
  assert.equal(report.original.category, 'invalid-input')
  assert.match(report.original.message, /Timeout must be an integer/)
})

test('F01 CLI correlates retained owned directories without revealing their sensitive root', (t) => {
  const f = fixture(t)
  const root = path.join(f.owned, sensitive)
  mkdirSync(root)
  const names = []
  for (let attempt = 0; attempt < 2; attempt++) {
    const report = failureReport(f.cli(['--scratch-root', root], {
      cleanup: false,
      inject: injectGit(`
        fs.writeFileSync(path.join(path.dirname(options.env.GIT_INDEX_FILE), 'unexpected.txt'), '${sensitive}')
        throw Object.assign(new Error('${sensitive}'), { status: 128 })
      `, 'read-tree'),
    }), f)
    assert.match(report.scratchDirectory, /^ecorp-diff-check-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    assert.equal(readFileSync(path.join(root, report.scratchDirectory, 'unexpected.txt'), 'utf8'), sensitive)
    assert.equal(existsSync(path.join(root, report.scratchDirectory, 'index')), false)
    names.push(report.scratchDirectory)
  }
  assert.equal(new Set(names).size, 2)
  assert.deepEqual(readdirSync(root).sort(), names.sort())
})

test('F01 CLI recognizes a native required clean-filter failure, not a missing path', (t) => {
  const f = fixture(t)
  const filter = path.join(f.owned, 'required filter.mjs')
  // Git's native filter launches only this owned Node fixture, never a provider.
  writeFileSync(filter, `process.stderr.write(${JSON.stringify(`${sensitive}\n\u001b[31m`)})
process.exitCode = 1
`)
  f.git(['config', 'filter.f01.clean', [process.execPath, filter]
    .map((file) => `"${file.replaceAll('\\', '/')}"`).join(' ')])
  f.git(['config', 'filter.f01.required', 'true'])
  f.write('.gitattributes', 'filtered.txt filter=f01\n')
  f.write('filtered.txt', 'source for the owned failing filter\n')
  const report = failureReport(f.cli(['--path', 'filtered.txt']), f)
  assert.deepEqual(report.original, {
    operation: 'add', category: 'clean-filter-failed', code: null, status: 128, signal: null,
  })
  assert.deepEqual(report.cleanup, [])
})

for (const repeats of [24_000, Math.floor((8 * 1024 * 1024 - 4096) / 24)]) {
  test(`F02 native filter repeated delimiters (${repeats}) cannot stall receipt or cleanup`, (t) => {
    const f = fixture(t)
    const filter = path.join(f.owned, 'hostile filter.mjs')
    writeFileSync(filter, `process.stderr.write("fatal: x: clean filter '".repeat(${repeats}) + ${JSON.stringify(`${sensitive}\n`)})
process.exitCode = 1
`)
    f.git(['config', 'filter.f02.clean', [process.execPath, filter]
      .map((file) => `"${file.replaceAll('\\', '/')}"`).join(' ')])
    f.git(['config', 'filter.f02.required', 'true'])
    f.write('.gitattributes', 'filtered.txt filter=f02\n')
    f.write('filtered.txt', 'source for the owned hostile filter\n')

    // Prove native Git itself finished with bounded hostile stderr, not a setup
    // failure or injected child result. Preserve this separate probe index.
    const before = f.snapshot()
    const env = { ...process.env, GIT_INDEX_FILE: path.join(f.owned, 'probe.index'), GIT_LITERAL_PATHSPECS: '1' }
    f.git(['read-tree', f.base], { env })
    const started = performance.now()
    const probe = spawnSync('git', ['add', '-A', '--', 'filtered.txt'], {
      cwd: f.repo, env, timeout: 1000, maxBuffer: 8 * 1024 * 1024, windowsHide: true,
    })
    const evidence = {
      status: probe.status, errorCode: probe.error?.code ?? null,
      elapsedMs: performance.now() - started, stderrBytes: probe.stderr?.length,
      stderrSha256: hash(probe.stderr ?? ''),
      hostilePrefix: probe.stderr?.toString('utf8').startsWith("fatal: x: clean filter '".repeat(repeats)),
      fatalTail: probe.stderr?.toString('utf8').trimEnd().endsWith("fatal: filtered.txt: clean filter 'f02' failed"),
      before, after: f.snapshot(),
    }
    if (process.env.ECORP_DIFF_TEST_ROOT) {
      writeFileSync(path.join(f.owned, 'native-probe.json'), JSON.stringify(evidence, null, 2))
    }
    assert.equal(evidence.errorCode, null, 'native probe must finish before testing the classifier')
    assert.equal(evidence.status, 128)
    assert.ok(evidence.stderrBytes > repeats * 24 && evidence.stderrBytes < 8 * 1024 * 1024)
    assert.equal(evidence.hostilePrefix, true)
    assert.equal(evidence.fatalTail, true)
    assert.deepEqual(evidence.after, before)
    const report = failureReport(f.cli(['--path', 'filtered.txt', '--timeout-ms', '1000'], { timeout: 5000 }), f)
    assert.deepEqual(report.original, {
      operation: 'add', category: 'clean-filter-failed', code: null, status: 128, signal: null,
    })
    assert.deepEqual(report.cleanup, [])
  })
}

test('F02 final-line recognition handles hostile near-limit shapes without trusting their text', (t) => {
  const f = fixture(t)
  const repeated = "fatal: x: clean filter '".repeat(Math.floor((8 * 1024 * 1024 - 4096) / 24))
  for (const [stderr, category, operation = 'add'] of [
    [repeated + sensitive, 'source-selection-failed'],
    [repeated + "' failedX", 'source-selection-failed'],
    [repeated + "' failed\r\n", 'clean-filter-failed'],
    [`fatal: : clean filter 'x' failed\n`, 'source-selection-failed'],
    [`fatal: x: clean filter '' failed\n`, 'source-selection-failed'],
    [`fatal: x\r: clean filter 'y' failed\n`, 'source-selection-failed'],
    [`fatal: x: clean filter 'y' failed\n${sensitive}\n`, 'source-selection-failed'],
    [`${repeated}\nfatal: pathspec '${sensitive}' did not match any files\r\n`, 'missing-path'],
    ['fatal: Needed a single revision\r\n', 'revision-unavailable', 'rev-parse'],
    [`${sensitive}\nfatal: Needed a single revision\n`, 'git-exit', 'rev-parse'],
  ]) {
    // Construct large synthetic stderr inside the child, not in argv.
    const body = stderr.startsWith(repeated)
      ? `${JSON.stringify("fatal: x: clean filter '")}.repeat(${repeated.length / 24}) + ${JSON.stringify(stderr.slice(repeated.length))}`
      : JSON.stringify(stderr)
    const report = failureReport(f.cli([], {
      timeout: 5000,
      inject: injectGit(`throw Object.assign(new Error('${sensitive}'), { status: 128, stderr: Buffer.from(${body}) })`, operation),
    }), f)
    assert.deepEqual(report.original, { operation, category, code: null, status: 128, signal: null })
    assert.deepEqual(report.cleanup, [])
  }
})
