import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants, readFileSync } from 'node:fs'
import { lstat, open, realpath, mkdtemp, mkdir, writeFile, symlink, link, unlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { checkContainedFile } from './e2e_stopped_source_checkpoint.mjs'
import { readTrustedExecutableDigest } from './e2e_checkpoint_verification.mjs'

// Like e2e_factory_budget_recovery.test.mjs, evaluate only the real driver's
// assertion/helper blocks, never import or execute its native entrypoint.
const driver = readFileSync(new URL('./e2e_factory_budget_recovery.mjs', import.meta.url), 'utf8')
const start = driver.indexOf('// Actual tested-input binding.')
const helpers = start < 0 ? '' : driver.slice(start, driver.indexOf('async function readReference()', start))
const legacy = driver.match(/report\.source_code_commit = .*$/m)[0]
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const selection = driver.match(/process\.exit\(0\)\r?\n\}([\s\S]*?)let demo/)[1]
const selectPrograms = new AsyncFunction('root', 'pgBin', 'process', 'path', 'realpath',
  selection + ';return provenancePrograms')
const load = new AsyncFunction('ctx', `
  const {assert, createHash, constants, lstat, open, realpath, path,
    checkContainedFile, readTrustedExecutableDigest, run} = ctx;
  ${helpers}
  return {
    capture: ${helpers ? 'captureSourceBinding' : `async (root) => { const report = {}; ${legacy}; return report; }`},
    finish: ${helpers ? 'finishSourceBinding' : 'async () => {}'}
  };
`)
const run = async (program, args, options) => ({
  stdout: execFileSync(program, args, { ...options, encoding: 'utf8', windowsHide: true }),
})
const { capture, finish } = await load({ assert, createHash, constants, lstat, open, realpath,
  path, checkContainedFile, readTrustedExecutableDigest, run })
const sidStart = driver.indexOf("  const sid = (await run('powershell.exe'")
const sidEnd = driver.indexOf('  if (!(await exists(passwordFile)))', sidStart)
assert.ok(sidStart >= 0 && sidEnd > sidStart)
const restrictPrivateRoot = new AsyncFunction('assert', 'run', 'privateRoot',
  driver.slice(sidStart, sidEnd))

test('private recovery credentials accept native local and Entra account SIDs', async () => {
  for (const sid of ['S-1-5-21-1-2-3-1001', 'S-1-12-1-1-2-3-4']) {
    const calls = []
    await restrictPrivateRoot(assert, async (program, args) => {
      calls.push({ program, args })
      return { stdout: sid + '\r\n' }
    }, 'owned-private-root')
    assert.deepEqual(calls[1], { program: 'icacls.exe', args: [
      'owned-private-root', '/inheritance:r', '/grant:r',
      `*${sid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F',
    ] })
    assert.equal(calls.length, 2)
  }
})

test('malformed account SIDs fail before changing credential ACLs', async () => {
  for (const sid of ['', 'S-1-5-', 'S-1-12-1--2', 'S-1-12-1-2:(OI)F', 'S-1-5-18\nS-1-5-32']) {
    let calls = 0
    await assert.rejects(restrictPrivateRoot(assert, async program => {
      calls++
      assert.equal(program, 'powershell.exe')
      return { stdout: sid }
    }, 'owned-private-root'), assert.AssertionError)
    assert.equal(calls, 1)
  }
})

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
// These files are hashed, never executed. Use intact local Windows executables
// because repeated text files named .exe can be quarantined during this fixture.
const executableBytes = process.platform === 'win32'
  ? readFileSync(path.join(process.env.SystemRoot, 'System32', 'whoami.exe'))
  : Buffer.from('inert executable bytes; DO NOT EXECUTE\n')
const changedExecutableBytes = process.platform === 'win32'
  ? readFileSync(path.join(process.env.SystemRoot, 'System32', 'hostname.exe'))
  : Buffer.from('different inert bytes\n')

async function fixture(t) {
  // Preserve tiny, owned fixtures as evidence; never traverse a real QA workspace.
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'ecorp-source-binding-')))
  const root = path.join(base, 'repo')
  await mkdir(path.join(root, 'tools'), { recursive: true })
  await writeFile(path.join(root, '.gitignore'), 'ignored/\n*.log\n')
  await writeFile(path.join(root, 'tools', 'input.mjs'), 'tracked original\n')
  const git = (...args) => execFileSync('git', ['-c', 'core.fsmonitor=false',
    '-c', 'core.hooksPath=' + path.join(base, 'no-hooks'), ...args],
  { cwd: root, windowsHide: true, encoding: 'utf8' })
  git('init', '--initial-branch=main')
  git('add', '.')
  git('-c', 'user.name=Inert provenance fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'commit.gpgSign=false', 'commit', '-m', 'Inert source')
  const executable = path.join(base, 'server.exe')
  await writeFile(executable, executableBytes)
  t.diagnostic(`owned_fixture=${base}`)
  return { base, root, git, executable, programs: { server: executable } }
}

test('same HEAD with different dirty tracked bytes has a different binding', async t => {
  const f = await fixture(t)
  const head = f.git('rev-parse', 'HEAD')
  const before = await capture(f.root, f.programs)
  await writeFile(path.join(f.root, 'tools', 'input.mjs'), 'tracked changed\n')
  const after = await capture(f.root, f.programs)
  t.diagnostic(JSON.stringify({ case: 'dirty-tracked', before, after }))
  assert.equal(f.git('rev-parse', 'HEAD'), head)
  assert.notDeepEqual(after, before, 'HEAD alone did not bind the tested dirty source')
  assert.equal(after.source.files.find(row => row.path === 'tools/input.mjs').sha256, sha256('tracked changed\n'))
})

test('nonignored untracked test input changes, additions and deletion are bound', async t => {
  const f = await fixture(t)
  const input = path.join(f.root, 'tools', 'new-input.json')
  const original = await capture(f.root, f.programs)
  await writeFile(input, '{"value":1}\n')
  const added = await capture(f.root, f.programs)
  assert.notDeepEqual(added, original, 'Untracked test input was omitted')
  await writeFile(input, '{"value":2}\n')
  const changed = await capture(f.root, f.programs)
  t.diagnostic(JSON.stringify({ case: 'untracked-input', before: added, after: changed }))
  assert.notDeepEqual(changed, added)
  assert.equal(changed.source.files.find(row => row.path === 'tools/new-input.json').sha256, sha256('{"value":2}\n'))
  await unlink(input)
  assert.deepEqual(await capture(f.root, f.programs), original)
})

test('actual executable bytes, not name or HEAD, are hashed and drift fails finalization', async t => {
  const f = await fixture(t)
  const before = await capture(f.root, f.programs)
  await writeFile(f.executable, changedExecutableBytes)
  const after = await capture(f.root, f.programs)
  assert.notDeepEqual(after, before, 'Executable byte change was omitted')
  assert.equal(after.executables.server.sha256, sha256(changedExecutableBytes))
  const report = { provenance: { before } }
  await assert.rejects(finish(report, f.root, f.programs), /binding changed/)
  assert.equal(report.provenance.consistent, false)
  assert.deepEqual(report.provenance.after, after)
  const from = driver.indexOf('  try { await finishSourceBinding(report, root, provenancePrograms) }')
  const to = driver.indexOf('  report.finished_at=', from)
  assert.ok(from >= 0 && to > from)
  const finalize = new AsyncFunction('ctx', `
    const {finishSourceBinding, report, root, provenancePrograms, process} = ctx;
    ${driver.slice(from, to)}
  `)
  const status = { exitCode: 0 }
  report.status = 'recovery_passed'
  await finalize({ finishSourceBinding: finish, report, root: f.root, provenancePrograms: f.programs, process: status })
  assert.equal(report.status, 'fixture_error')
  assert.equal(status.exitCode, 1)
  t.diagnostic(JSON.stringify({ case: 'binary-drift', ...report.provenance }))
})

test('unchanged input finalizes; source drift and missing executables fail closed', async t => {
  const f = await fixture(t)
  const report = { provenance: { before: await capture(f.root, f.programs) } }
  await finish(report, f.root, f.programs)
  assert.equal(report.provenance.consistent, true)
  await unlink(path.join(f.root, 'tools', 'input.mjs'))
  await assert.rejects(finish(report, f.root, f.programs), /binding changed/)
  await unlink(f.executable)
  await assert.rejects(capture(f.root, f.programs))
})

test('ignored contents and unrelated private directories are never hashed', async t => {
  const f = await fixture(t)
  const before = await capture(f.root, f.programs)
  for (const name of ['ignored', 'credentials', 'pg-data', 'runner-workspaces']) {
    await mkdir(path.join(f.root, name))
    await writeFile(path.join(f.root, name, 'private.json'), 'PRIVATE_SENTINEL')
  }
  await writeFile(path.join(f.root, 'tools', 'ignored.log'), 'PRIVATE_SENTINEL')
  assert.deepEqual(await capture(f.root, f.programs), before)
  assert.ok(!JSON.stringify(before).includes('PRIVATE_SENTINEL'))
  await writeFile(path.join(f.root, 'tools', 'credential.json'), 'PRIVATE_SENTINEL')
  await assert.rejects(capture(f.root, f.programs), /Private path/)
})

test('tracked private configuration is excluded without reading its contents', async t => {
  const f = await fixture(t)
  const before = await capture(f.root, f.programs)
  for (const directory of ['.codex', 'credentials']) {
    await mkdir(path.join(f.root, directory))
    await writeFile(path.join(f.root, directory, 'config.toml'), 'PRIVATE_SENTINEL')
    f.git('add', '--', directory)
  }
  const after = await capture(f.root, f.programs)
  assert.deepEqual(after, before)
  assert.ok(!after.source.files.some(row => /(?:^|\/)(?:\.codex|credentials)\//u.test(row.path)))
})

test('tracked parent junction escape and executable symlink are rejected', async t => {
  const f = await fixture(t)
  const outside = path.join(f.base, 'outside')
  await mkdir(outside)
  await writeFile(path.join(outside, 'input.mjs'), 'OUTSIDE_SENTINEL')
  // Remove only a known inert file/directory, not any recursive fixture tree.
  await unlink(path.join(f.root, 'tools', 'input.mjs'))
  const { rmdir } = await import('node:fs/promises')
  await rmdir(path.join(f.root, 'tools'))
  await symlink(outside, path.join(f.root, 'tools'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(capture(f.root, f.programs), /link|alias|reparse/)
  await unlink(path.join(f.root, 'tools'))
  await mkdir(path.join(f.root, 'tools'))
  await writeFile(path.join(f.root, 'tools', 'input.mjs'), 'tracked original\n')
  const alias = path.join(f.base, 'linked-bin')
  await symlink(outside, alias, process.platform === 'win32' ? 'junction' : 'dir')
  await writeFile(path.join(outside, 'server.exe'), changedExecutableBytes)
  await assert.rejects(capture(f.root, { server: path.join(alias, 'server.exe') }), /canonical|alias|link/)
})

test('source hard links and unsafe Git path listings fail without outside reads', async t => {
  const f = await fixture(t)
  await link(f.executable, path.join(f.root, 'tools', 'linked.mjs'))
  await assert.rejects(capture(f.root, f.programs), /single.link/)
  await unlink(path.join(f.root, 'tools', 'linked.mjs'))
  for (const unsafe of ['../outside.mjs', 'C:/outside.mjs', 'tools/../outside.mjs', 'tools\\outside.mjs']) {
    const hostile = await load({ assert, createHash, constants, lstat, open, realpath, path,
      checkContainedFile, readTrustedExecutableDigest,
      run: async (program, args, options) => args.includes('ls-files')
        ? { stdout: unsafe + '\0' } : run(program, args, options) })
    await assert.rejects(hostile.capture(f.root, f.programs), /source path/)
  }
})

test('owned Node directory alias is resolved once and pinned for binding and every launch', async t => {
  const f = await fixture(t)
  const alias = path.join(f.base, 'node-alias')
  const target = path.join(f.base, 'node-target')
  await mkdir(target)
  const executable = path.join(target, 'node.exe')
  await writeFile(executable, executableBytes)
  await symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir')
  const execPath = path.join(alias, 'node.exe')
  await assert.rejects(readTrustedExecutableDigest(execPath), /canonical_owned_directory_required/)
  let resolutions = 0
  const programs = await selectPrograms(f.root, f.base, { execPath }, path, async file => {
    resolutions++
    assert.equal(file, execPath)
    return realpath(file)
  })
  const report = { provenance: { before: await capture(f.root, { node: programs.node }) } }
  assert.equal(programs.node, executable)
  assert.equal(resolutions, 1)
  assert.equal(report.provenance.before.executables.node.sha256,
    await readTrustedExecutableDigest(executable))
  // Retarget only our junction; neither launches nor final binding may follow it again.
  await unlink(alias)
  await symlink(f.base, alias, process.platform === 'win32' ? 'junction' : 'dir')
  const runnerStart = driver.indexOf("  await start('runner',")
  const controllerStart = driver.indexOf('  async function controller(')
  const runnerEnd = driver.indexOf("  await until('QA fake Codex runner ready'", runnerStart)
  const controllerEnd = driver.indexOf('  report.preview_attempts=', controllerStart)
  assert.ok(runnerStart >= 0 && runnerEnd > runnerStart && controllerStart >= 0 && controllerEnd > controllerStart)
  const launches = []
  const launch = new AsyncFunction('ctx', `
    const {path, root, qa, attempt, source, trustedNode, process, start, run} = ctx;
    const runnerId = 'inert', demo = {corp_id:'inert', alice_actor_id:'inert'};
    const enrollment = 'inert', api = 'inert', verifier = 'inert', ghState = 'inert', env = {};
    ${driver.slice(runnerStart, runnerEnd)}
    ${driver.slice(controllerStart, controllerEnd)}
    return [await controller(true), await controller()];
  `)
  const results = await launch({ path, root: f.root, qa: f.base, attempt: f.base, source: f.root,
    trustedNode: programs.node, process: { get execPath() { assert.fail('Node must stay pinned') } },
    start: async (name, program, args) => launches.push({ name, program, args }),
    run: async (program, args) => { launches.push({ name: 'controller', program, args }); return { stdout: '{}' } } })
  assert.deepEqual(results, [{ ok: true, body: {} }, { ok: true, body: {} }])
  assert.equal(launches.length, 3)
  for (const call of launches) {
    const flag = call.name === 'runner' ? '--codex-command' : '--github-cli'
    assert.equal(call.args[call.args.indexOf(flag) + 1], programs.node)
  }
  assert.equal((driver.match(/process\.execPath/g) ?? []).length, 1)
  await finish(report, f.root, { node: programs.node })
  assert.equal(report.provenance.consistent, true)
  t.diagnostic(JSON.stringify({ case: 'pinned-node-alias', execPath, selectedNode: programs.node,
    resolutions, launches, provenance: report.provenance }))
  await writeFile(executable, changedExecutableBytes)
  await assert.rejects(finish(report, f.root, { node: programs.node }), /binding changed/)
  assert.equal(report.provenance.consistent, false)
})

test('actual selected Windows Node passes the real read-only digest and before/after binding',
  { skip: process.platform !== 'win32' }, async t => {
    const f = await fixture(t)
    const programs = await selectPrograms(f.root, f.base, process, path, realpath)
    const selectedDigest = await readTrustedExecutableDigest(programs.node)
    const canonicalNode = await realpath(process.execPath)
    assert.equal(programs.node, canonicalNode)
    assert.equal(selectedDigest, await readTrustedExecutableDigest(canonicalNode))
    const report = { provenance: { before: await capture(f.root, { node: programs.node }) } }
    await finish(report, f.root, { node: programs.node })
    assert.equal(report.provenance.consistent, true)
    assert.equal(report.provenance.before.executables.node.sha256, selectedDigest)
    t.diagnostic(JSON.stringify({ case: 'actual-selected-node', execPath: process.execPath,
      selectedNode: programs.node, canonicalNode, selectedDigest, provenance: report.provenance }))
  })

test('native admission binds before effects; dry-run does not require executables', async () => {
  const dry = driver.indexOf('if (!execute)')
  const bind = driver.indexOf('before: await captureSourceBinding(root, provenancePrograms)')
  const persist = driver.indexOf("'provenance-before.json'")
  assert.ok(dry >= 0 && bind > dry && bind < driver.indexOf('const ownerFile ='))
  assert.ok(persist > bind && persist < driver.indexOf('const dotenvFile='))
  assert.ok(driver.indexOf('await finishSourceBinding(report, root, provenancePrograms)') <
    driver.indexOf("await json(path.join(attempt,'report.json'),report)"))
  const programs = await selectPrograms(path.resolve('repo'), path.resolve('pg'),
    { execPath: 'exact-node.exe' }, path, async file => file)
  assert.deepEqual(Object.keys(programs), ['server', 'runner', 'cli', 'node', 'initdb', 'postgres', 'psql', 'createdb', 'pg_ctl'])
  assert.equal(programs.node, 'exact-node.exe')
  for (const name of ['server', 'runner', 'cli']) {
    assert.equal(programs[name], path.resolve('repo', 'target/debug', `crony-${name}.exe`))
  }
  for (const name of ['initdb', 'postgres', 'psql', 'createdb', 'pg_ctl']) {
    assert.equal(programs[name], path.resolve('pg', `${name}.exe`))
  }
})
