import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { checkpointChildEnvironment, checkpointFixtureEnvironment, validateCheckpointFixture } from './e2e_active_checkpoints.mjs'

async function ownedTemporaryDirectory(t) {
  const parent = await realpath(os.tmpdir())
  const directory = await mkdtemp(path.join(parent, 'ecorp-checkpoint-env-'))
  t.diagnostic(`Owned synthetic fixture retained: ${directory}`)
  return directory
}

function fixture() {
  const root = path.resolve(import.meta.dirname, '..')
  const qa = path.join(path.dirname(root), 'qa', 'issue72-active-checkpoints-unit')
  const owned = { pid: 123, executable: process.execPath, started_utc: '2026-10-02T00:00:00Z' }
  return { test_owned: true, provider_fixture: 'native-fake-process', repository: root,
    qa_root: qa, source: path.join(qa, 'source'), source_repository: 'ecorp-fixture/active-checkpoints-fixture',
    source_commit: 'a'.repeat(40), source_binding: { source_fingerprint: 'b'.repeat(64) },
    runner_id: 'issue72-checkpoint-qa', server_url: 'http://127.0.0.1:19472', web_url: 'http://127.0.0.1:16472',
    demo: { corp_id: '11111111-1111-4111-8111-111111111111', alice_actor_id: '22222222-2222-4222-8222-222222222222' },
    processes: { server: owned, web: owned, runner: owned } }
}
test('active checkpoint driver is import-inert even with opt-in environment', async t => {
  const parent = await ownedTemporaryDirectory(t)
  const environment = await checkpointFixtureEnvironment(process.env, path.join(parent, 'environment'))
  const result = spawnSync(process.execPath, ['--input-type=module', '-e',
    `await import(${JSON.stringify(new URL('./e2e_active_checkpoints.mjs', import.meta.url).href)})`], {
    windowsHide: true, timeout: 10000, env: { ...environment, ECORP_ACTIVE_CHECKPOINT_TEST: '1',
      ECORP_ACTIVE_CHECKPOINT_SETUP: path.join(import.meta.dirname, 'does-not-exist.json') } })
  assert.equal(result.status, 0, result.stderr.toString())
  assert.equal(result.stdout.toString(), '')
})
test('owned acceptance admission requires explicit opt-in, scoped source and all process identities', () => {
  assert.doesNotThrow(() => validateCheckpointFixture(fixture(), '1'))
  for (const mutate of [
    value => { value.test_owned = false },
    value => { value.source_repository = 'All-The-Vibes/ecorp' },
    value => { value.provider_fixture = 'live-provider' },
    value => { value.source = value.repository },
    value => { value.qa_root = path.join(value.repository, 'qa', 'issue72-active-checkpoints-unit') },
    value => { delete value.source_binding },
    value => { value.processes.runner = { pid: 0 } },
  ]) { const value = fixture(); mutate(value); assert.throws(() => validateCheckpointFixture(value, '1')) }
  for (const optIn of [undefined, '0', '', 'true']) assert.throws(() => validateCheckpointFixture(fixture(), optIn))
})
test('owned acceptance rejects nonlocal, credentialed and ambiguous endpoints', () => {
  for (const endpoint of ['https://127.0.0.1:19472', 'http://example.com:19472', 'http://127.0.0.1:80',
    'http://user:password@127.0.0.1:19472', 'http://127.0.0.1:19472/path', 'http://127.0.0.1:19472/?reset=true']) {
    const value = fixture(); value.server_url = endpoint
    assert.throws(() => validateCheckpointFixture(value, '1'))
  }
  const same = fixture(); same.web_url = same.server_url
  assert.throws(() => validateCheckpointFixture(same, '1'))
})
test('fixture children never inherit repository, publisher or provider credentials and Git injection', () => {
  const source = { PATH: 'native-tools', SystemRoot: 'system', GH_TOKEN: 'synthetic', github_token: 'synthetic',
    DATABASE_URL: 'synthetic', CRONY_CORP_ID: 'old', ECORP_PUBLICATION_PUBLISHER_CREDENTIAL_FILE: 'private',
    PGPASSFILE: 'private', OPENAI_API_KEY: 'synthetic', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_VALUE_0: 'synthetic', NODE_OPTIONS: '--import=untrusted', CUSTOM_SECRET: 'synthetic',
    SSH_AUTH_SOCK: 'synthetic-agent', KUBECONFIG: 'synthetic-kubeconfig', DOCKER_CONFIG: 'synthetic-docker',
    NETRC: 'synthetic-netrc', npm_config_userconfig: 'synthetic-npmrc', GOOGLE_APPLICATION_CREDENTIALS: 'synthetic-google',
    ARBITRARY_SERVICE_AUTH: 'synthetic-custom-auth', HOME: 'synthetic-home', USERPROFILE: 'synthetic-profile',
    APPDATA: 'synthetic-roaming', LOCALAPPDATA: 'synthetic-local', XDG_CONFIG_HOME: 'synthetic-config',
    LD_PRELOAD: 'synthetic-library', DYLD_INSERT_LIBRARIES: 'synthetic-library', PYTHONPATH: 'synthetic-module' }
  assert.deepEqual(checkpointChildEnvironment(source), { PATH: 'native-tools', SystemRoot: 'system' })
  assert.equal(source.GH_TOKEN, 'synthetic', 'Do not mutate the calling process environment')
})

test('minimal OS environment handles Windows casing and rejects ambiguous aliases', () => {
  assert.deepEqual(checkpointChildEnvironment({ Path: 'tools', systemroot: 'system', ComSpec: 'shell',
    PATHEXT: '.EXE', windir: 'windows', SystemDrive: 'drive', arbitrary: 'discard' }), {
    PATH: 'tools', SystemRoot: 'system', ComSpec: 'shell', PATHEXT: '.EXE', WINDIR: 'windows', SystemDrive: 'drive' })
  assert.throws(() => checkpointChildEnvironment({ PATH: 'first', Path: 'second' }), /Ambiguous/u)
})

test('native child resolves only owned home and config paths without inherited credential capabilities', async t => {
  const parent = await ownedTemporaryDirectory(t), directory = path.join(parent, 'environment')
  const inherited = { ...checkpointChildEnvironment(process.env), SSH_AUTH_SOCK: 'synthetic-agent',
    KUBECONFIG: 'synthetic-kubeconfig', DOCKER_CONFIG: 'synthetic-docker', NETRC: 'synthetic-netrc',
    ARBITRARY_SERVICE_AUTH: 'synthetic-custom-auth', HOME: 'synthetic-home', USERPROFILE: 'synthetic-profile',
    APPDATA: 'synthetic-roaming', LOCALAPPDATA: 'synthetic-local', XDG_CONFIG_HOME: 'synthetic-config',
    NODE_OPTIONS: '--import=synthetic', LD_PRELOAD: 'synthetic-library', PYTHONPATH: 'synthetic-module' }
  const original = { ...inherited }
  const environment = await checkpointFixtureEnvironment(inherited, directory)
  const result = spawnSync(process.execPath, ['--input-type=module', '-e',
    "import os from 'node:os'; console.log(JSON.stringify({env:process.env,home:os.homedir(),tmp:os.tmpdir()}))"], {
    env: environment, windowsHide: true, timeout: 10000 })
  assert.equal(result.status, 0, result.stderr.toString())
  const observed = JSON.parse(result.stdout)
  assert.equal(observed.home, path.join(directory, 'home'))
  assert.equal(observed.tmp, path.join(directory, 'tmp'))
  for (const [key, value] of Object.entries(observed.env)) {
    assert.notEqual(value.startsWith('synthetic-'), true, `Inherited capability reached child: ${key}`)
  }
  const locations = ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME',
    'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR', 'TEMP', 'TMP', 'TMPDIR']
  for (const key of locations) {
    assert.equal(observed.env[key], environment[key])
    const relative = path.relative(directory, environment[key])
    assert.ok(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
    assert.ok((await lstat(environment[key])).isDirectory())
  }
  assert.equal(await readFile(environment.GIT_CONFIG_GLOBAL, 'utf8'), '')
  assert.equal(observed.env.GIT_CONFIG_NOSYSTEM, '1')
  assert.equal(observed.env.GIT_ALLOW_PROTOCOL, 'file')
  assert.equal(observed.env.GIT_TERMINAL_PROMPT, '0')
  assert.deepEqual(inherited, original, 'Never mutate the calling environment')
})

test('Windows native application-data lookup agrees with the owned environment', { skip: process.platform !== 'win32' }, async t => {
  const parent = await ownedTemporaryDirectory(t)
  const environment = await checkpointFixtureEnvironment(process.env, path.join(parent, 'environment'))
  const powershell = path.join(environment.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const result = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    "[pscustomobject]@{roaming=[Environment]::GetFolderPath('ApplicationData');local=[Environment]::GetFolderPath('LocalApplicationData')} | ConvertTo-Json -Compress"], {
    env: environment, windowsHide: true, timeout: 15000 })
  assert.equal(result.status, 0, result.stderr.toString())
  const observed = JSON.parse(result.stdout)
  assert.equal(observed.roaming, environment.APPDATA)
  assert.equal(observed.local, environment.LOCALAPPDATA)
})

test('owned child environments preserve existing directories, files and links and reject aliased parents', async t => {
  const parent = await ownedTemporaryDirectory(t), existing = path.join(parent, 'existing')
  await mkdir(existing)
  const sentinel = path.join(existing, 'retain.txt')
  await writeFile(sentinel, 'preserve this fixture', { flag: 'wx' })
  await assert.rejects(checkpointFixtureEnvironment({}, existing), { code: 'EEXIST' })
  await assert.rejects(checkpointFixtureEnvironment({}, sentinel), { code: 'EEXIST' })
  const link = path.join(parent, 'linked')
  await symlink(existing, link, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(checkpointFixtureEnvironment({}, link), { code: 'EEXIST' })
  await assert.rejects(checkpointFixtureEnvironment({}, path.join(link, 'new')), /links|aliases/u)
  await assert.rejects(lstat(path.join(existing, 'new')), { code: 'ENOENT' })
  await assert.rejects(checkpointFixtureEnvironment({}, 'relative'), /absolute/u)
  assert.equal(await readFile(sentinel, 'utf8'), 'preserve this fixture')
})
