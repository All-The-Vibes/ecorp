// Opt-in loopback transport fixture. Registration credentials, assignment tokens
// and raw traffic stay in memory. Only bounded observation metadata is exposed.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import WebSocket, { WebSocketServer } from 'ws'

assert.equal(process.env.CRONY_CODEX_STOP_TEST, '1', 'Owned acceptance opt-in required')
const scenario = process.env.CRONY_COMPLETION_GATE_SCENARIO
assert.ok(['fixture-completion-stop', 'fixture-completion-accepted',
  'fixture-completion-lost', 'fixture-completion-legacy'].includes(scenario))
const upstream = new URL(process.env.CRONY_COMPLETION_GATE_UPSTREAM)
assert.equal(upstream.protocol, 'ws:')
assert.equal(upstream.hostname, '127.0.0.1')
assert.equal(upstream.pathname, '/ws/runner')
assert.ok(upstream.port && !upstream.username && !upstream.password && !upstream.search && !upstream.hash)
const port = Number(process.env.CRONY_COMPLETION_GATE_PORT)
assert.ok(Number.isInteger(port) && port > 0 && port <= 65535)
const state = { scenario, connections: 0, completion: null, receipt: null, hard_stop: null,
  acknowledgment: null, unconfirmed_failure: null, failure: null }
let held
let expected
let peer
let client
const now = () => new Date().toISOString()
function fail(message) {
  state.failure ??= message
  client?.terminate()
  peer?.terminate()
}
function release() {
  if (!held || peer?.readyState !== WebSocket.OPEN) return false
  peer.send(held, { binary: false })
  held = undefined
  state.completion.forwarded_at = now()
  return true
}
const server = createServer((request, response) => {
  // This is a local fixture control endpoint, not a browser-facing product API.
  if (request.headers.origin || Number(request.headers['content-length'] ?? 0) !== 0 || request.headers['transfer-encoding']) {
    response.writeHead(403).end()
    return
  }
  let status = 200
  if (request.method === 'POST' && request.url === '/release') {
    status = release() ? 200 : 409
  } else if (request.method !== 'GET' || request.url !== '/state') {
    response.writeHead(404).end()
    return
  }
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  response.end(JSON.stringify(state))
})
const sockets = new WebSocketServer({ noServer: true, maxPayload: 24 * 1024 * 1024 })
server.on('upgrade', (request, socket, head) => {
  if (request.url !== '/ws/runner' || request.headers.origin || state.connections !== 0) {
    socket.destroy()
    return
  }
  sockets.handleUpgrade(request, socket, head, connected => sockets.emit('connection', connected))
})
sockets.on('connection', connected => {
  client = connected
  state.connections++
  peer = new WebSocket(upstream, { maxPayload: 24 * 1024 * 1024 })
  const pending = []
  let pendingBytes = 0
  peer.on('open', () => {
    for (const data of pending.splice(0)) peer.send(data, { binary: false })
    pendingBytes = 0
  })
  client.on('message', (data, binary) => {
    if (binary) return fail('Unexpected binary runner message')
    let message
    try { message = JSON.parse(data.toString()) } catch { return fail('Invalid runner JSON') }
    if (message.type === 'run_event' && message.event_type === 'run.completed') {
      if (expected) return fail('Multiple completions exceed this single-run fixture')
      expected = message
      state.completion = { received_at: now(), run_id: message.run_id, event_id: message.event_id,
        corp_id: message.corp_id, requested: message.payload?.completion_receipt_requested === true,
        request_forwarded: scenario !== 'fixture-completion-legacy' }
      if (scenario === 'fixture-completion-legacy') delete message.payload.completion_receipt_requested
      held = JSON.stringify(message)
      return
    }
    if (message.type === 'command_ack' && message.command_id === state.hard_stop?.command_id) {
      state.acknowledgment = { observed_at: now(), command_id: message.command_id, applied: message.applied }
    }
    if (message.type === 'run_event' && message.run_id === expected?.run_id &&
        message.event_type === 'run.failed' && message.payload?.failure_kind === 'completion_unconfirmed') {
      state.unconfirmed_failure = { observed_at: now(), run_id: message.run_id, kind: 'completion_unconfirmed' }
    }
    if (peer.readyState === WebSocket.OPEN) peer.send(data, { binary: false })
    else if (peer.readyState === WebSocket.CONNECTING && pending.length < 32 &&
        pendingBytes + data.length <= 1024 * 1024) {
      pending.push(data)
      pendingBytes += data.length
    } else fail('Upstream unavailable or initial queue exceeded')
  })
  peer.on('message', (data, binary) => {
    if (binary) return fail('Unexpected binary server message')
    let message
    try { message = JSON.parse(data.toString()) } catch { return fail('Invalid server JSON') }
    if (message.type === 'run_completion_accepted') {
      const receipt = message.receipt
      const matches = !!expected && ['corp_id', 'connection_epoch', 'run_id', 'assignment_token', 'event_id']
        .every(key => typeof expected[key] === 'string' && receipt?.[key] === expected[key])
      state.receipt = { observed_at: now(), scope_matches: matches,
        run_id: receipt?.run_id, event_id: receipt?.event_id,
        withheld: scenario === 'fixture-completion-lost' }
      if (scenario === 'fixture-completion-lost') return
    }
    if (message.type === 'circuit_breaker' && message.stage === 'stop' && message.run_id === expected?.run_id) {
      state.hard_stop = { forwarded_at: now(), run_id: message.run_id, command_id: message.command_id }
    }
    if (client.readyState === WebSocket.OPEN) client.send(data, { binary: false })
    else fail('Runner unavailable for server message')
  })
  client.on('error', () => fail('Runner socket error'))
  peer.on('error', () => fail('Server socket error'))
  client.on('close', () => peer.terminate())
  peer.on('close', () => client.terminate())
})
server.listen(port, '127.0.0.1')
