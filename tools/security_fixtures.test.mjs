import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import test from 'node:test'
import vm from 'node:vm'

test('the actual Factory fixture proxy returns 502 without exposing exception details', async () => {
  const source = await readFile(new URL('./e2e_factory_controller.mjs', import.meta.url), 'utf8')
  const start = source.indexOf('async function createMaterializationBarrierProxy()')
  const end = source.indexOf('\nasync function withTimeout(', start)
  assert.ok(start >= 0 && end > start)
  for (const code of ['ECONNREFUSED', 'DO_NOT_DISCLOSE_ERROR_CODE']) {
    const diagnostics = []
    const failure = new Error('DO_NOT_DISCLOSE_EXCEPTION_MESSAGE_OR_STACK')
    failure.cause = { code }
    const createProxy = vm.runInNewContext(`(${source.slice(start, end)})`, {
      assert, Buffer, createServer, URL,
      server: 'http://unused.invalid',
      console: { error: (...args) => diagnostics.push(args) },
      fetch: async () => { throw failure },
    })
    const proxy = await createProxy()
    try {
      const response = await fetch(proxy.url)
      assert.equal(response.status, 502)
      assert.equal(await response.text(), 'Fixture upstream request failed')
      assert.deepEqual(diagnostics, [['Factory fixture upstream failure:',
        code === 'ECONNREFUSED' ? code : 'UPSTREAM_FAILURE']])
    } finally {
      await proxy.close()
    }
  }
})
