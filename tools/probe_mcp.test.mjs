import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import path from 'node:path'
import test from 'node:test'
import { probeConfiguration, probeMcp, snapshotCounts } from './probe_mcp.mjs'

const CORP_ID = '00000000-0000-4000-8000-000000000001'
const ACTOR_ID = '00000000-0000-4000-8000-000000000011'
const binary = process.env.CRONY_MCP_TEST_BINARY
const nativeOptions = { skip: !binary && 'Set CRONY_MCP_TEST_BINARY to the compiled native MCP gateway' }
const PRIVATE_MARKER = 'fixture-private-content-not-for-the-probe-report'

function configuration(server = 'http://127.0.0.1:8791') {
  return {
    ...process.env,
    CRONY_MCP_BINARY: binary ?? path.resolve('unused-native-gateway'),
    CRONY_SERVER_HTTP: server,
    CRONY_CORP_ID: CORP_ID,
    CRONY_ACTOR_ID: ACTOR_ID,
    CRONY_ACCESS_TOKEN: 'synthetic-fixture-token',
  }
}

function snapshot() {
  return {
    snapshot: {
      corp: { id: CORP_ID, name: PRIVATE_MARKER },
      actors: [{ id: ACTOR_ID, name: PRIVATE_MARKER }],
      rooms: [], agents: [], missions: [], tasks: [],
      runs: [{ provider_session_id: PRIVATE_MARKER, workspace_path: PRIVATE_MARKER }],
      verification_evidence: [], source_deliverables: [], pull_request_publications: [],
      events: [{ payload: PRIVATE_MARKER }],
    },
    runners: [],
  }
}

async function fixture(t, handler) {
  const requests = []
  const server = createServer((request, response) => {
    requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization })
    handler(request, response)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  })
  return { origin: `http://127.0.0.1:${server.address().port}`, requests }
}

function nativeFrames(env, frames, readOnly = true, omittedVariables = []) {
  const config = probeConfiguration(env)
  for (const name of omittedVariables) delete config.childEnv[name]
  return new Promise((resolve, reject) => {
    const child = spawn(config.binary, readOnly ? ['--read-only'] : [], {
      env: config.childEnv,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let output = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('native fixture timeout'))
    }, 5000)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { output += chunk })
    child.stderr.resume()
    child.stdin.on('error', () => {}) // Startup-denial cases may close stdin before consuming it.
    child.once('error', () => {
      clearTimeout(timer)
      reject(new Error('native fixture failed to start'))
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) return reject(new Error('native fixture exited unsuccessfully'))
      try { resolve(output.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))) } catch {
        reject(new Error('native fixture emitted invalid JSON'))
      }
    })
    child.stdin.end(frames.map((frame) => JSON.stringify(frame)).join('\n') + '\n')
  })
}

test('probe requires explicit scope and forwards only its scoped credential environment', () => {
  const env = { ...configuration(), UNRELATED_PROVIDER_SECRET: 'must-not-be-forwarded' }
  const config = probeConfiguration(env)
  assert.equal(config.childEnv.CRONY_ACCESS_TOKEN, env.CRONY_ACCESS_TOKEN)
  assert.equal(config.childEnv.UNRELATED_PROVIDER_SECRET, undefined)
  for (const name of ['CRONY_MCP_BINARY', 'CRONY_SERVER_HTTP', 'CRONY_CORP_ID', 'CRONY_ACTOR_ID']) {
    assert.throws(() => probeConfiguration({ ...env, [name]: undefined }))
  }
  assert.throws(() => probeConfiguration({ ...env, CRONY_SERVER_HTTP: 'https://user:secret@example.test/' }), /without credentials/u)
  assert.throws(() => probeConfiguration(env, 60_001), /timeout/u)
  assert.throws(() => probeConfiguration(env, 99), /timeout/u)
})

test('probe summary contains collection counts, never snapshot data or private paths', () => {
  const counts = snapshotCounts(snapshot(), CORP_ID)
  assert.equal(counts.actors, 1)
  assert.equal(counts.runs, 1)
  assert.equal(counts.events, 1)
  assert.ok(!JSON.stringify(counts).includes(PRIVATE_MARKER))
  assert.throws(() => snapshotCounts(snapshot(), ACTOR_ID), /Corp scope/u)
  const partial = snapshot()
  delete partial.snapshot.events
  delete partial.runners
  partial.snapshot.missions = null
  const unavailable = snapshotCounts(partial, CORP_ID)
  assert.equal(unavailable.events, null)
  assert.equal(unavailable.runners, null)
  assert.equal(unavailable.missions, null)
  assert.equal(unavailable.tasks, 0)
  partial.snapshot.events = {}
  assert.throws(() => snapshotCounts(partial, CORP_ID), /invalid collection/u)
})

test('probe permits HTTP only for normalized canonical loopback origins and requires HTTPS elsewhere', () => {
  for (const origin of [
    'http://127.0.0.1:8791', 'http://LOCALHOST:8791', 'http://[::1]:8791',
    'http://127.1:8791', 'http://[0:0:0:0:0:0:0:1]:8791', 'https://ecorp.example.test',
  ]) {
    assert.equal(probeConfiguration(configuration(origin)).childEnv.CRONY_SERVER_HTTP, new URL(origin).origin)
  }
  for (const origin of [
    'http://ecorp.example.test', 'http://192.168.1.10:8791', 'http://127.0.0.2:8791',
    'http://localhost.example.test', 'http://127.0.0.1.example.test', 'http://[::2]:8791',
  ]) {
    assert.throws(() => probeConfiguration(configuration(origin)), /requires HTTPS/u)
    assert.throws(() => probeConfiguration({ ...configuration(origin), CRONY_ACCESS_TOKEN: undefined }), /requires HTTPS/u)
  }
})

test('compiled read-only MCP completes the real stdio handshake and makes only one scoped GET', nativeOptions, async (t) => {
  const api = await fixture(t, (_request, response) => {
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify(snapshot()))
  })
  const report = await probeMcp({ env: configuration(api.origin) })
  assert.deepEqual(api.requests, [{
    method: 'GET',
    url: `/api/corps/${CORP_ID}/snapshot?actor_id=${ACTOR_ID}`,
    authorization: 'Bearer synthetic-fixture-token',
  }])
  assert.deepEqual(report.tool_names, ['crony_snapshot'])
  assert.equal(report.read_only, true)
  assert.equal(report.corp_scope_verified, true)
  assert.equal(report.counts_scope, 'returned_snapshot_collection_lengths')
  assert.equal(report.counts.runs, 1)
  assert.ok(!JSON.stringify(report).includes(PRIVATE_MARKER))
  assert.ok(!JSON.stringify(report).includes('synthetic-fixture-token'))
  assert.ok(!JSON.stringify(report).includes(api.origin))
})

test('compiled MCP ignores notifications and denies mutating calls before HTTP while preserving the default catalog', nativeOptions, async (t) => {
  const api = await fixture(t, (_request, response) => response.end('{}'))
  const frames = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', method: 'tools/call', params: { name: 'crony_create_mission', arguments: { title: 'Notification must not create work' } } },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'crony_create_mission', arguments: { title: 'Denied' } } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'crony_post_room_message', arguments: { room_id: CORP_ID, body: 'Denied' } } },
    { jsonrpc: '2.0', id: 5, method: 'ping' },
    { jsonrpc: '2.0', id: null, method: 'ping' },
  ]
  const replies = await nativeFrames(configuration(api.origin), frames)
  assert.deepEqual(replies.map((reply) => reply.id), [1, 2, 3, 4, 5, null])
  assert.equal(replies[1].result.tools.length, 1)
  for (const reply of replies.slice(2, 4)) {
    assert.equal(reply.error.code, -32000)
    assert.equal(reply.error.message, 'tool is unavailable in read-only MCP mode')
  }
  assert.deepEqual(replies[4].result, {})
  const compatible = await nativeFrames(configuration(api.origin), [frames[2], frames[3]], false)
  assert.deepEqual(compatible.map((reply) => reply.id), [2])
  assert.equal(compatible[0].result.tools.length, 3)
  assert.equal(api.requests.length, 0)
})

test('compiled probe withholds API error content and enforces its whole-probe timeout', nativeOptions, async (t) => {
  const denied = await fixture(t, (_request, response) => {
    response.writeHead(403, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: PRIVATE_MARKER }))
  })
  await assert.rejects(probeMcp({ env: configuration(denied.origin) }), (error) => {
    assert.match(error.message, /response bodies were withheld/u)
    assert.ok(!error.message.includes(PRIVATE_MARKER))
    return true
  })
  const stalled = await fixture(t, () => {})
  await assert.rejects(probeMcp({ env: configuration(stalled.origin), timeoutMs: 1000 }), /MCP probe timed out/u)
  assert.equal(stalled.requests.length, 1)
})

test('compiled read-only inspection rejects redirects without contacting a second origin', nativeOptions, async (t) => {
  const destination = await fixture(t, (_request, response) => {
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify(snapshot()))
  })
  const source = await fixture(t, (_request, response) => {
    response.writeHead(302, { location: `${destination.origin}/other`, 'content-type': 'application/json' })
    response.end(JSON.stringify({ message: PRIVATE_MARKER }))
  })
  await assert.rejects(probeMcp({ env: configuration(source.origin) }), (error) => {
    assert.match(error.message, /response bodies were withheld/u)
    assert.ok(!error.message.includes(PRIVATE_MARKER))
    return true
  })
  assert.equal(source.requests.length, 1)
  assert.equal(destination.requests.length, 0)
  const compatible = await nativeFrames(configuration(source.origin), [
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'crony_snapshot', arguments: {} } },
  ], false)
  assert.equal(compatible[0].result.structuredContent.snapshot.corp.id, CORP_ID)
  assert.equal(destination.requests.length, 1)
})

test('compiled read-only startup requires every routing variable before serving even initialization', nativeOptions, async (t) => {
  const api = await fixture(t, (_request, response) => response.end('{}'))
  const initialize = [{ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }]
  for (const name of ['CRONY_SERVER_HTTP', 'CRONY_CORP_ID', 'CRONY_ACTOR_ID']) {
    await assert.rejects(nativeFrames(configuration(api.origin), initialize, true, [name]), /exited unsuccessfully/u)
  }
  // The legacy default remains usable for initialization without contacting its
  // default server; this does not make a request to any retained local stack.
  const compatible = await nativeFrames(configuration(api.origin), initialize, false, ['CRONY_SERVER_HTTP'])
  assert.equal(compatible[0].result.protocolVersion, '2025-06-18')
  assert.equal(api.requests.length, 0)
})
