import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const qa = 'C:\\Users\\aabdelsalam\\.ecorp\\qa\\issue-161-shared-authority'
const worktree = path.resolve(import.meta.dirname, '../..')
const dependency = path.join(qa, 'dependencies/pr237')
assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dependency, encoding: 'utf8', windowsHide: true }).trim(),
  'b31a38a62330aacba80c3953142e1da957a63ecd')
// Current reconstruction v2: exact base + pr237-native-time.patch, UTF-8 LF, no BOM.
// See qa-helper-binding.md. This is NOT recovered historical runtime evidence:
// the old aa0d3c377847c479c69e8be6e1f809bf4b155c53dc6903c1d6922fde4732e144
// binding remains in the original reports; its helper bytes were not recovered.
// No arbitrary dirty helper, other source change or untracked file is accepted.
assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: dependency, encoding: 'utf8', windowsHide: true }).trim(), 'M tools/owned_test_stack.mjs')
const helperPath = path.join(dependency, 'tools/owned_test_stack.mjs')
assert.equal(createHash('sha256').update(readFileSync(helperPath)).digest('hex'),
  '6d0bc7975f68c578a77ac3ebf54b7ee64e99871cfe964d5b9bf6afa2dd58cb1e')
const helpers = await import(pathToFileURL(helperPath))
const action = process.argv[2]
assert.ok(['start', 'restart-shared', 'stop'].includes(action), 'Use an explicit bounded QA API action')

// These helpers inherit their parent environment; strip ambient credentials and
// ECorp overrides before launching either new QA server. Database URLs stay here.
const allow = new Set(['path','pathext','systemroot','windir','comspec','temp','tmp','userprofile',
  'homedrive','homepath','home','appdata','localappdata','programdata','programfiles','programfiles(x86)',
  'programw6432','systemdrive','username','userdomain','computername','psmodulepath',
  'number_of_processors','processor_architecture','os'])
for (const key of Object.keys(process.env)) if (!allow.has(key.toLowerCase())) delete process.env[key]

function context(name, port) {
  return {
    root: qa, server: `http://127.0.0.1:${port}`,
    databaseUrl: `postgres://ecorp_qa161@127.0.0.1:55461/issue161_${name}`,
    binary: path.join(worktree, 'target/debug/crony-server.exe'),
    manifestPath: path.join(qa, `api-${name}.json`), logPrefix: `api-${name}`,
    args: ['--mode','development','--runner-grace-secs','30','--runner-credential-ttl-secs','1800',
      '--object-store-local-root',path.join(qa, `artifacts-${name}`)],
    minimumRunners: name === 'shared' && action === 'restart-shared' ? 2 : 0,
  }
}
if (action === 'start') {
  for (const [name, port] of [['shared',18971], ['independent',18972]]) {
    await helpers.startOwnedTestServer(context(name, port))
    console.log(`Owned ${name} API ready on ${port}`)
  }
} else if (action === 'restart-shared') {
  const before = JSON.parse(readFileSync(path.join(qa, 'api-shared.json'), 'utf8')).server
  const after = await helpers.restartOwnedTestServer(context('shared', 18971))
  console.log(JSON.stringify({ old_server_pid: before, new_server_pid: after, helper_commit: 'b31a38a' }))
} else {
  for (const [name, port] of [['independent',18972], ['shared',18971]]) {
    await helpers.stopOwnedTestServer(context(name, port))
    console.log(`Owned ${name} API stopped`)
  }
}
