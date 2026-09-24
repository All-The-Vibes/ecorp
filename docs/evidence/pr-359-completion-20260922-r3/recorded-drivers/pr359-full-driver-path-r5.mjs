import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const base = path.dirname(fileURLToPath(import.meta.url))
const repo = '<reviewed-worktree>'
const root = path.join(base, 'pr359-full-driver-path-r5')
const sha = value => createHash('sha256').update(value).digest('hex')
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', windowsHide: true })
await mkdir(root)
const sourceTree = git('-C', repo, 'write-tree').trim()
const hook = path.join(root, 'no-network.mjs')
await writeFile(hook, "import { appendFileSync } from 'node:fs'; globalThis.fetch = async () => { appendFileSync(process.env.PATH_REPLAY_NETWORK_LOG, 'fetch intercepted before network\\n'); throw new Error('OWNED_PATH_REPLAY_NO_NETWORK'); };\n", { flag: 'wx' })
const versions = [
  { name: 'baseline', ref: '5bfb44015b1f97e21e768ea0054b26f16b83350d:tools/e2e_agent_pinning.mjs' },
  { name: 'corrected', ref: ':tools/e2e_agent_pinning.mjs' },
]
const receipt = { status: 'running', started_at_utc: new Date().toISOString(), source_tree: sourceTree, scope: 'Full historical/current driver bytes against fresh synthetic Git sources; fetch is intercepted before network, no server/runner/SQL/provider calls occur.', cases: [] }
const safeEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => ['SYSTEMROOT', 'WINDIR', 'PATH', 'PATHEXT', 'TEMP', 'TMP', 'COMSPEC', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA'].includes(key.toUpperCase())))
async function snapshot(dir, prefix = '') {
  const files = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === '.git') continue
    const relative = path.posix.join(prefix, entry.name)
    if (entry.isDirectory()) files.push(...await snapshot(path.join(dir, entry.name), relative))
    else files.push({ path: relative, sha256: sha(await readFile(path.join(dir, entry.name))) })
  }
  return files.sort((a, b) => a.path.localeCompare(b.path))
}
for (const version of versions) {
  const driver = path.join(root, version.name + '.mjs')
  const bytes = execFileSync('git', ['-C', repo, 'show', version.ref])
  await writeFile(driver, bytes, { flag: 'wx' })
  for (const kind of ['equal', 'nested', 'junction']) {
    const owned = path.join(root, version.name + '-' + kind)
    const source = path.join(owned, 'source')
    await mkdir(source, { recursive: true })
    await writeFile(path.join(source, 'seed.txt'), 'Synthetic source must remain unchanged.\n', { flag: 'wx' })
    git('-C', source, 'init', '-q')
    git('-C', source, 'add', '--', 'seed.txt')
    git('-C', source, '-c', 'user.name=ECorp QA', '-c', 'user.email=qa@ecorp.invalid', 'commit', '-qm', 'Create isolated path-admission fixture')
    let output = kind === 'equal' ? source : path.join(source, 'new-output')
    if (kind === 'junction') {
      output = path.join(owned, 'alias-to-source')
      await symlink(source, output, 'junction')
    }
    const networkLog = path.join(owned, 'network-interception.log')
    const before = { files: await snapshot(source), git_status: git('-C', source, 'status', '--porcelain').trim() }
    const started = new Date().toISOString()
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(hook).href, driver, '--phase', 'prepare'], {
      cwd: owned, encoding: 'utf8', windowsHide: true, timeout: 20000,
      env: { ...safeEnv, CRONY_PIN_TEST: '1', CRONY_SERVER_HTTP: 'http://127.0.0.1:59031', CRONY_PIN_WEB: 'http://127.0.0.1:59032', CRONY_PIN_OUTPUT: output, CRONY_PIN_PRIVATE: path.join(owned, 'private'), CRONY_CLI_BINARY: path.join(owned, 'never-executed-cli.exe'), CRONY_PIN_SOURCE: source, ECORP_PSQL_BINARY: path.join(owned, 'never-executed-psql.exe'), PGHOST: '127.0.0.1', PGPORT: '59030', PGDATABASE: 'issue48_app', PGUSER: 'issue48', PATH_REPLAY_NETWORK_LOG: networkLog },
    })
    assert.equal(result.error, undefined)
    assert.equal(result.status, 1)
    const after = { files: await snapshot(source), git_status: git('-C', source, 'status', '--porcelain').trim() }
    const originalSeed = before.files.find(f => f.path === 'seed.txt')
    assert.deepEqual(after.files.find(f => f.path === 'seed.txt'), originalSeed)
    const changed = JSON.stringify(before) !== JSON.stringify(after)
    assert.equal(changed, version.name === 'baseline')
    if (version.name === 'baseline') {
      assert.equal(after.files.length, 2)
      assert.match(result.stderr, /OWNED_PATH_REPLAY_NO_NETWORK/)
      assert.equal(await readFile(networkLog, 'utf8'), 'fetch intercepted before network\n')
    } else {
      assert.match(result.stderr, /directories must be disjoint/)
      await assert.rejects(readFile(networkLog), { code: 'ENOENT' })
    }
    const log = path.join(owned, 'execution.log')
    await writeFile(log, result.stdout + result.stderr, { flag: 'wx' })
    const record = { version: version.name, case: kind, source_ref: version.ref, driver_sha256: sha(bytes), command: [process.execPath, '--import', pathToFileURL(hook).href, driver, '--phase', 'prepare'], started_at_utc: started, finished_at_utc: new Date().toISOString(), exit_code: result.status, source_changed: changed, seed_preserved: true, before, after, intercepted_before_network: version.name === 'baseline', rejected_before_network: version.name === 'corrected', log: path.relative(root, log).replaceAll('\\', '/'), log_sha256: sha(result.stdout + result.stderr), expected_result_observed: true }
    receipt.cases.push(record)
    await writeFile(path.join(owned, 'case.json'), JSON.stringify(record, null, 2) + '\n', { flag: 'wx' })
    console.log(JSON.stringify({ version: version.name, case: kind, exit_code: result.status, source_changed: changed, expected_result_observed: true }))
  }
}
assert.equal(git('-C', repo, 'write-tree').trim(), sourceTree)
receipt.status = 'passed'
receipt.finished_at_utc = new Date().toISOString()
await writeFile(path.join(root, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' })
