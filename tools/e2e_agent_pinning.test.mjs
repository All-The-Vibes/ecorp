import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const driver = fileURLToPath(new URL('./e2e_agent_pinning.mjs', import.meta.url))
function denied(overrides, message, args = ['--phase', 'prepare']) {
  const result = spawnSync(process.execPath, [driver, ...args], {
    encoding: 'utf8', timeout: 15000,
    env: {
      ...process.env, CRONY_PIN_TEST: '1', CRONY_SERVER_HTTP: 'http://127.0.0.1:59031',
      CRONY_PIN_WEB: 'http://127.0.0.1:59032', CRONY_PIN_OUTPUT: '',
      CRONY_PIN_PRIVATE: '', CRONY_CLI_BINARY: '', CRONY_PIN_SOURCE: '', ECORP_PSQL_BINARY: '',
      ...overrides,
    },
  })
  assert.equal(result.error, undefined)
  assert.equal(result.status, 1)
  assert.match(result.stderr, message)
  assert.equal(result.stdout, '')
}

test('native pin driver fails before writes without explicit opt-in and bounded phase', () => {
  denied({ CRONY_PIN_TEST: '0' }, /owned-stack opt-in required/)
  denied({}, /AssertionError/, ['--phase', 'reset'])
})

test('native pin driver refuses external, inherited shared-port and credentialed origins', () => {
  for (const url of ['https://example.invalid', 'http://localhost:59031', 'http://127.0.0.1:8791',
    'http://127.0.0.1:55483', 'http://user:fixture@127.0.0.1:59031', 'http://127.0.0.1:59031/api']) {
    denied({ CRONY_SERVER_HTTP: url }, /AssertionError/)
  }
  denied({ CRONY_PIN_WEB: 'http://127.0.0.1:5187' }, /allocated ports/)
})

test('native pin driver never invents missing output or source paths', () => {
  denied({}, /CRONY_PIN_OUTPUT must be explicit and absolute/)
  denied({ CRONY_PIN_OUTPUT: 'relative-output' }, /CRONY_PIN_OUTPUT must be explicit and absolute/)
})
