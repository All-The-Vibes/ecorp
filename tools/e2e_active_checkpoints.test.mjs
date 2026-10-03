import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import test from 'node:test'
import { checkpointChildEnvironment, validateCheckpointFixture } from './e2e_active_checkpoints.mjs'

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
test('active checkpoint driver is import-inert even with opt-in environment', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e',
    `await import(${JSON.stringify(new URL('./e2e_active_checkpoints.mjs', import.meta.url).href)})`], {
    windowsHide: true, timeout: 10000, env: { ...process.env, ECORP_ACTIVE_CHECKPOINT_TEST: '1',
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
    GIT_CONFIG_VALUE_0: 'synthetic', NODE_OPTIONS: '--import=untrusted', CUSTOM_SECRET: 'synthetic' }
  assert.deepEqual(checkpointChildEnvironment(source), { PATH: 'native-tools', SystemRoot: 'system' })
  assert.equal(source.GH_TOKEN, 'synthetic', 'Do not mutate the calling process environment')
})
