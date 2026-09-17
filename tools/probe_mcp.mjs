import { spawn } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import readline from 'node:readline'
import { pathToFileURL } from 'node:url'

export const MCP_PROTOCOL_VERSION = '2025-06-18'
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
const COUNT_FIELDS = [
  'actors', 'rooms', 'agents', 'missions', 'tasks', 'runs',
  'verification_evidence', 'source_deliverables', 'pull_request_publications', 'events',
]

export function probeConfiguration(env = process.env, timeoutMs = 15_000) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) {
    throw new Error('MCP probe timeout must be between 100 and 60000 milliseconds')
  }
  if (!env.CRONY_MCP_BINARY || !path.isAbsolute(env.CRONY_MCP_BINARY)) {
    throw new Error('Set CRONY_MCP_BINARY to the absolute path of the built native gateway')
  }
  let server
  try {
    server = new URL(env.CRONY_SERVER_HTTP)
  } catch {
    throw new Error('Set CRONY_SERVER_HTTP to the existing ECorp API origin')
  }
  if (!['http:', 'https:'].includes(server.protocol) || server.username || server.password
    || server.search || server.hash || server.pathname !== '/') {
    throw new Error('CRONY_SERVER_HTTP must be an HTTP(S) origin without credentials or parameters')
  }
  if (server.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(server.hostname)) {
    throw new Error('MCP probe requires HTTPS outside explicitly configured loopback origins')
  }
  if (!UUID.test(env.CRONY_CORP_ID ?? '') || !UUID.test(env.CRONY_ACTOR_ID ?? '')) {
    throw new Error('Set explicit CRONY_CORP_ID and CRONY_ACTOR_ID UUIDs for an existing membership')
  }
  const childEnv = Object.fromEntries(Object.entries(env).filter(([name]) =>
    /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|USERPROFILE|HOME|LOCALAPPDATA|APPDATA)$/iu.test(name)))
  Object.assign(childEnv, {
    CRONY_SERVER_HTTP: server.origin,
    CRONY_CORP_ID: env.CRONY_CORP_ID,
    CRONY_ACTOR_ID: env.CRONY_ACTOR_ID,
  })
  if (env.CRONY_ACCESS_TOKEN) childEnv.CRONY_ACCESS_TOKEN = env.CRONY_ACCESS_TOKEN
  return {
    binary: env.CRONY_MCP_BINARY,
    corpId: env.CRONY_CORP_ID,
    actorId: env.CRONY_ACTOR_ID,
    childEnv,
    timeoutMs,
  }
}

function stdioClient(config) {
  const child = spawn(config.binary, ['--read-only'], {
    env: config.childEnv,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const pending = new Map()
  let nextId = 1
  let responseBytes = 0
  let stderrBytes = 0
  let fatalError
  let exited = false
  const closed = new Promise((resolve) => child.once('close', () => {
    exited = true
    resolve()
  }))
  function fail(message) {
    fatalError ??= new Error(message)
    for (const { reject } of pending.values()) reject(fatalError)
    pending.clear()
    if (!exited) child.kill()
  }
  const timer = setTimeout(() => fail('MCP probe timed out'), config.timeoutMs)
  child.stdout.on('data', (chunk) => {
    responseBytes += chunk.length
    if (responseBytes > MAX_RESPONSE_BYTES) fail('MCP response exceeded the probe byte limit')
  })
  const lines = readline.createInterface({ input: child.stdout })
  // Native/API error text can contain private data. Never forward or retain it.
  child.stderr.on('data', (chunk) => {
    stderrBytes += chunk.length
    if (stderrBytes > 64 * 1024) fail('MCP gateway exceeded the diagnostic byte limit')
  })
  child.on('error', () => fail('Could not start the configured native MCP gateway'))
  child.stdin.on('error', () => fail('Native MCP input closed unexpectedly'))
  child.on('close', () => {
    if (pending.size) fail('Native MCP gateway exited before replying')
  })
  lines.on('line', (line) => {
    if (fatalError) return
    let response
    try { response = JSON.parse(line) } catch {
      fail('Native MCP gateway returned invalid JSON')
      return
    }
    const waiter = pending.get(response?.id)
    if (response?.jsonrpc !== '2.0' || !waiter) {
      fail('Native MCP gateway returned an unexpected JSON-RPC response')
      return
    }
    pending.delete(response.id)
    if (response.error) {
      waiter.reject(new Error('Native MCP request failed; API and gateway response bodies were withheld'))
    } else if (!Object.hasOwn(response, 'result')) {
      waiter.reject(new Error('Native MCP response omitted its result'))
    } else {
      waiter.resolve(response.result)
    }
  })
  return {
    call(method, params) {
      if (fatalError) return Promise.reject(fatalError)
      const id = nextId++
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
      })
    },
    initialized() {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
    },
    responseBytes: () => responseBytes,
    async close() {
      clearTimeout(timer)
      child.stdin.end()
      let graceTimer
      const graceful = await Promise.race([
        closed.then(() => true),
        new Promise((resolve) => { graceTimer = setTimeout(() => resolve(false), 1000) }),
      ])
      clearTimeout(graceTimer)
      if (!graceful) {
        child.kill()
        let killTimer
        const stopped = await Promise.race([
          closed.then(() => true),
          new Promise((resolve) => { killTimer = setTimeout(() => resolve(false), 1000) }),
        ])
        clearTimeout(killTimer)
        if (!stopped) throw new Error('The owned MCP probe process did not exit within its shutdown limit')
      }
      lines.close()
      if (fatalError) throw fatalError
    },
  }
}

export function snapshotCounts(payload, corpId) {
  const snapshot = payload?.snapshot
  if (typeof snapshot?.corp?.id !== 'string' || snapshot.corp.id.toLowerCase() !== corpId.toLowerCase()) {
    throw new Error('MCP snapshot did not match the configured Corp scope')
  }
  const counts = {}
  for (const field of COUNT_FIELDS) {
    if (snapshot[field] == null) counts[field] = null
    else if (Array.isArray(snapshot[field])) counts[field] = snapshot[field].length
    else throw new Error('MCP snapshot returned an invalid collection')
  }
  if (payload.runners == null) counts.runners = null
  else if (Array.isArray(payload.runners)) counts.runners = payload.runners.length
  else throw new Error('MCP snapshot returned invalid runner metadata')
  return counts
}

export async function probeMcp({ env = process.env, timeoutMs = 15_000 } = {}) {
  const config = probeConfiguration(env, timeoutMs)
  const client = stdioClient(config)
  const started = performance.now()
  try {
    const initialized = await client.call('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'ecorp-readonly-probe', version: '1.0.0' },
    })
    if (initialized?.protocolVersion !== MCP_PROTOCOL_VERSION
      || initialized?.serverInfo?.name !== 'crony-mcp') {
      throw new Error('Native MCP handshake did not match the supported gateway protocol')
    }
    client.initialized()
    const catalog = await client.call('tools/list', {})
    if (!Array.isArray(catalog?.tools) || catalog.tools.length !== 1
      || catalog.tools[0]?.name !== 'crony_snapshot') {
      throw new Error('Native MCP gateway did not expose exactly the read-only snapshot tool')
    }
    const result = await client.call('tools/call', { name: 'crony_snapshot', arguments: {} })
    if (result?.isError) throw new Error('Native MCP snapshot tool reported a failure')
    return {
      schema_version: 1,
      checked_at: new Date().toISOString(),
      protocol_version: MCP_PROTOCOL_VERSION,
      read_only: true,
      tool_names: ['crony_snapshot'],
      corp_scope_verified: true,
      access_token_supplied: Boolean(config.childEnv.CRONY_ACCESS_TOKEN),
      counts_scope: 'returned_snapshot_collection_lengths',
      counts: snapshotCounts(result?.structuredContent, config.corpId),
      response_bytes: client.responseBytes(),
      duration_ms: Math.round(performance.now() - started),
      scope: 'native-stdio-to-existing-api-read; no provider execution or production-auth claim',
    }
  } finally {
    await client.close()
  }
}

async function main() {
  let output
  let timeoutMs = 15_000
  const args = process.argv.slice(2)
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--output' && args[index + 1]) output = args[++index]
    else if (args[index] === '--timeout-ms' && args[index + 1]) timeoutMs = Number(args[++index])
    else throw new Error('Usage: node tools/probe_mcp.mjs [--timeout-ms 15000] [--output NEW_FILE]')
  }
  const report = await probeMcp({ timeoutMs })
  const serialized = `${JSON.stringify(report, null, 2)}\n`
  if (output) {
    try { await writeFile(output, serialized, { flag: 'wx' }) } catch {
      throw new Error('Could not create the new MCP probe report; existing files are never overwritten')
    }
  }
  process.stdout.write(serialized)
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  })
}
