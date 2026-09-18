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
const READ_ONLY_HTTP_BODY_LIMIT = 16 * 1024 * 1024
const READ_ONLY_HTTP_BODY_ERROR = 'read-only MCP response exceeded the 16 MiB body limit'
const SNAPSHOT_FRAME = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'crony_snapshot', arguments: {} } }

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

function nativeInvocation(env, frames, args, omittedVariables = [], extraEnv = {}) {
  const config = probeConfiguration(env)
  for (const name of omittedVariables) delete config.childEnv[name]
  return new Promise((resolve, reject) => {
    const child = spawn(config.binary, args, {
      env: { ...config.childEnv, ...extraEnv },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let output = ''
    let diagnostics = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('native fixture timeout'))
    }, 5000)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { output += chunk })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => { diagnostics += chunk })
    child.stdin.on('error', () => {}) // Startup-denial cases may close stdin before consuming it.
    child.once('error', () => {
      clearTimeout(timer)
      reject(new Error('native fixture failed to start'))
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      resolve({ code, output, diagnostics })
    })
    child.stdin.end(frames.map((frame) => JSON.stringify(frame)).join('\n') + '\n')
  })
}

async function nativeFrames(env, frames, readOnly = true, omittedVariables = []) {
  const result = await nativeInvocation(env, frames, readOnly ? ['--read-only'] : [], omittedVariables)
  if (result.code !== 0) throw new Error('native fixture exited unsuccessfully')
  try { return result.output.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) } catch {
    throw new Error('native fixture emitted invalid JSON')
  }
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

const readOnlyModes = [
  { name: 'flag', args: ['--read-only'], env: { CRONY_MCP_READ_ONLY: 'false' } },
  { name: 'environment', args: [], env: { CRONY_MCP_READ_ONLY: 'true' } },
]
const CLI_TOKEN = 'synthetic-command-line-fixture-token'
const ENV_TOKEN = 'synthetic-environment-fixture-token'
const tokenForms = [
  { name: 'split option', args: ['--access-token', CLI_TOKEN] },
  { name: 'equals option', args: [`--access-token=${CLI_TOKEN}`] },
]

for (const mode of readOnlyModes) {
  for (const form of tokenForms) {
    for (const environmentToken of [undefined, ENV_TOKEN]) {
      test(`compiled read-only ${mode.name} rejects command-line tokens (${form.name}, ${environmentToken ? 'CLI plus environment' : 'CLI only'})`, nativeOptions, async (t) => {
        const api = await fixture(t, (_request, response) => response.end(JSON.stringify(snapshot())))
        const result = await nativeInvocation({ ...configuration(api.origin), CRONY_ACCESS_TOKEN: environmentToken }, [
          { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
          SNAPSHOT_FRAME,
        ], [...mode.args, ...form.args], [], mode.env)
        assert.equal(result.code, 1)
        assert.equal(result.output, '')
        assert.match(result.diagnostics, /read-only MCP requires access tokens through CRONY_ACCESS_TOKEN; --access-token is unavailable/u)
        assert.equal(result.diagnostics.includes(CLI_TOKEN), false)
        assert.equal(result.diagnostics.includes(ENV_TOKEN), false)
        assert.equal(api.requests.length, 0)
      })
    }
  }

  test(`compiled read-only ${mode.name} accepts only the environment token and exposes the restricted catalog`, nativeOptions, async (t) => {
    const api = await fixture(t, (_request, response) => response.end(JSON.stringify(snapshot())))
    const result = await nativeInvocation({ ...configuration(api.origin), CRONY_ACCESS_TOKEN: ENV_TOKEN }, [
      { jsonrpc: '2.0', id: 2, method: 'tools/list' }, SNAPSHOT_FRAME,
    ], mode.args, [], mode.env)
    assert.equal(result.code, 0)
    const replies = result.output.trim().split('\n').map((line) => JSON.parse(line))
    assert.deepEqual(replies[0].result.tools.map((tool) => tool.name), ['crony_snapshot'])
    assert.deepEqual(replies[1].result.structuredContent, snapshot())
    assert.equal(api.requests.length, 1)
    assert.equal(api.requests[0].authorization, `Bearer ${ENV_TOKEN}`)
    assert.equal(result.output.includes(ENV_TOKEN), false)
    assert.equal(result.diagnostics.includes(ENV_TOKEN), false)
  })
}

for (const form of tokenForms) {
  test(`compiled unrestricted MCP preserves legacy CLI token precedence (${form.name})`, nativeOptions, async (t) => {
    const api = await fixture(t, (_request, response) => response.end(JSON.stringify(snapshot())))
    for (const environmentToken of [undefined, ENV_TOKEN]) {
      const result = await nativeInvocation({ ...configuration(api.origin), CRONY_ACCESS_TOKEN: environmentToken }, [
        { jsonrpc: '2.0', id: 2, method: 'tools/list' }, SNAPSHOT_FRAME,
      ], form.args, [], { CRONY_MCP_READ_ONLY: 'false' })
      assert.equal(result.code, 0)
      const replies = result.output.trim().split('\n').map((line) => JSON.parse(line))
      assert.equal(replies[0].result.tools.length, 3)
      assert.deepEqual(replies[1].result.structuredContent, snapshot())
      assert.equal(api.requests.at(-1).authorization, `Bearer ${CLI_TOKEN}`)
    }
    assert.equal(api.requests.length, 2)
  })
}

for (const statusCode of [200, 403]) {
  test(`compiled native read-only HTTP body rejects oversized declared length before end (${statusCode})`, nativeOptions, async (t) => {
    const api = await fixture(t, (_request, response) => {
      response.writeHead(statusCode, { 'content-type': 'application/json', 'content-length': String(READ_ONLY_HTTP_BODY_LIMIT + 1) })
      response.flushHeaders()
      // Keep the body open: a post-decode or timeout-only bound cannot pass.
    })
    const started = performance.now()
    const replies = await nativeFrames(configuration(api.origin), [SNAPSHOT_FRAME])
    assert.deepEqual(replies, [{ jsonrpc: '2.0', id: 1, error: { code: -32000, message: READ_ONLY_HTTP_BODY_ERROR } }])
    assert.ok(performance.now() - started < 3000, 'declared oversize must fail before the fixture timeout')
    assert.equal(api.requests.length, 1)
  })

  test(`compiled native read-only HTTP body rejects streamed overflow before end (${statusCode})`, nativeOptions, async (t) => {
    const api = await fixture(t, (_request, response) => {
      response.writeHead(statusCode, { 'content-type': 'application/json', 'transfer-encoding': 'chunked' })
      response.write(`{"private":"${PRIVATE_MARKER}","padding":"`)
      const chunk = Buffer.alloc(64 * 1024, 'x')
      for (let sent = 0; sent < READ_ONLY_HTTP_BODY_LIMIT; sent += chunk.length) response.write(chunk)
      // No Content-Length and no JSON/body terminator. The limit must be
      // enforced while streaming, including for an unsuccessful HTTP status.
    })
    const started = performance.now()
    const replies = await nativeFrames(configuration(api.origin), [SNAPSHOT_FRAME])
    assert.deepEqual(replies, [{ jsonrpc: '2.0', id: 1, error: { code: -32000, message: READ_ONLY_HTTP_BODY_ERROR } }])
    assert.ok(performance.now() - started < 3000, 'streamed overflow must fail before the fixture timeout')
    assert.equal(JSON.stringify(replies).includes(PRIVATE_MARKER), false)
    assert.equal(api.requests.length, 1)
  })
}

test('compiled native HTTP body accepts the inclusive read-only limit and preserves unrestricted transport', nativeOptions, async (t) => {
  const compact = JSON.stringify(snapshot())
  for (const [readOnly, length] of [[true, READ_ONLY_HTTP_BODY_LIMIT], [false, READ_ONLY_HTTP_BODY_LIMIT + 1]]) {
    const api = await fixture(t, (_request, response) => {
      response.setHeader('content-type', 'application/json')
      // Whitespace keeps the raw body large and the decoded/native output small.
      response.end(' '.repeat(length - Buffer.byteLength(compact)) + compact)
    })
    const replies = await nativeFrames(configuration(api.origin), [SNAPSHOT_FRAME], readOnly)
    assert.deepEqual(replies[0].result.structuredContent, snapshot())
    assert.equal(api.requests.length, 1)
  }
})

test('compiled native HTTP body preserves small successful and error response behavior', nativeOptions, async (t) => {
  for (const readOnly of [true, false]) {
    for (const statusCode of [200, 403]) {
      const body = statusCode === 200 ? snapshot() : { error: PRIVATE_MARKER }
      const api = await fixture(t, (_request, response) => {
        response.writeHead(statusCode, { 'content-type': 'application/json' })
        response.end(JSON.stringify(body))
      })
      const replies = await nativeFrames(configuration(api.origin), [SNAPSHOT_FRAME], readOnly)
      if (statusCode === 200) assert.deepEqual(replies[0].result.structuredContent, body)
      else {
        assert.equal(replies[0].error.code, -32000)
        assert.match(replies[0].error.message, /ECorp API returned 403/u)
        const error = await probeMcp({ env: configuration(api.origin) }).then(() => null, value => value)
        assert.ok(error instanceof Error)
        assert.equal(error.message.includes(PRIVATE_MARKER), false)
      }
    }
  }
})
