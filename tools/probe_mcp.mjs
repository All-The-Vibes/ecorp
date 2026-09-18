import { spawn } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import readline from 'node:readline'
import { pathToFileURL } from 'node:url'

export const MCP_PROTOCOL_VERSION = '2025-06-18'
export const READ_ONLY_MCP_TOOLS = Object.freeze(['crony_snapshot', 'crony_factory_recovery_context'])
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

export function recoveryContextMetadata(payload, corpId, workItemId) {
  const item = payload?.work_item
  if (typeof item?.id !== 'string' || item.id.toLowerCase() !== workItemId.toLowerCase()
    || typeof item.corp_id !== 'string' || item.corp_id.toLowerCase() !== corpId.toLowerCase()) {
    throw new Error('MCP recovery context did not match the requested Corp and work item')
  }
  if (!Number.isSafeInteger(item.version) || item.version <= 0 || !Array.isArray(payload.recoveries)) {
    throw new Error('MCP recovery context returned invalid version or history metadata')
  }
  const metadata = { work_item_id: workItemId.toLowerCase(), work_item_version: item.version }
  for (const field of ['mission_id', 'task_id', 'source_run_id']) {
    if (!UUID.test(payload[field] ?? '')) throw new Error('MCP recovery context returned invalid native IDs')
    metadata[field] = payload[field].toLowerCase()
  }
  if (typeof item.mission_id !== 'string' || item.mission_id.toLowerCase() !== metadata.mission_id) {
    throw new Error('MCP recovery context returned inconsistent mission identity')
  }
  for (const field of ['remaining_attempts', 'remaining_mission_tokens', 'remaining_mission_cost_microusd']) {
    if (!Number.isSafeInteger(payload[field]) || payload[field] < 0) throw new Error('MCP recovery context returned invalid remaining authority')
    metadata[field] = payload[field]
  }
  for (const field of ['checkpoint_verification', 'checkpoint_source_correction', 'checkpoint_verification_available']) {
    if (payload[field] !== undefined && typeof payload[field] !== 'boolean') {
      throw new Error('MCP recovery context returned invalid native capability metadata')
    }
    // Absence stays unknown. Inspection never invents an eligible recovery mode.
    metadata[field] = payload[field] ?? null
  }
  metadata.recovery_count = payload.recoveries.length
  return metadata
}

async function readMcpInspection({ env = process.env, timeoutMs = 15_000 }, name, arguments_, summarize) {
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
    if (!Array.isArray(catalog?.tools) || catalog.tools.length !== READ_ONLY_MCP_TOOLS.length
      || JSON.stringify(catalog.tools.map(tool => tool?.name).sort()) !== JSON.stringify([...READ_ONLY_MCP_TOOLS].sort())
      || catalog.tools.some(tool => tool.annotations?.readOnlyHint !== true)) {
      throw new Error('Native MCP gateway did not expose exactly the supported read-only inspection tools')
    }
    const result = await client.call('tools/call', { name, arguments: arguments_ })
    if (result?.isError) throw new Error('Native MCP inspection tool reported a failure')
    const payload = result?.structuredContent
    const report = {
      schema_version: 1,
      checked_at: new Date().toISOString(),
      protocol_version: MCP_PROTOCOL_VERSION,
      read_only: true,
      tool_names: [...READ_ONLY_MCP_TOOLS],
      corp_scope_verified: true,
      access_token_supplied: Boolean(config.childEnv.CRONY_ACCESS_TOKEN),
      ...summarize(payload, config),
      response_bytes: client.responseBytes(),
      duration_ms: Math.round(performance.now() - started),
      scope: 'native-stdio-to-existing-api-read; no provider execution or production-auth claim',
    }
    return { payload, report }
  } finally {
    await client.close()
  }
}

// Internal consumers may project authorized payloads. The CLI and probeMcp API
// expose only whitelisted metadata, never policies, source paths or raw failures.
export async function readMcpSnapshot(options = {}) {
  return readMcpInspection(options, 'crony_snapshot', {}, (payload, config) => ({
    counts_scope: 'returned_snapshot_collection_lengths',
    counts: snapshotCounts(payload, config.corpId),
  }))
}

export async function readMcpRecoveryContext({ workItemId, ...options } = {}) {
  if (!UUID.test(workItemId ?? '')) throw new Error('workItemId must be an explicit hyphenated UUID')
  return readMcpInspection(options, 'crony_factory_recovery_context', { work_item_id: workItemId }, (payload, config) => ({
    inspection: 'factory_recovery_context',
    recovery_scope: 'returned_native_context_not_authorization_to_recover',
    recovery: recoveryContextMetadata(payload, config.corpId, workItemId),
  }))
}

export async function probeMcp(options = {}) {
  if (options.workItemId !== undefined) return (await readMcpRecoveryContext(options)).report
  return (await readMcpSnapshot(options)).report
}

async function main() {
  let output
  let timeoutMs = 15_000
  let workItemId
  const args = process.argv.slice(2)
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--output' && args[index + 1]) output = args[++index]
    else if (args[index] === '--timeout-ms' && args[index + 1]) timeoutMs = Number(args[++index])
    else if (args[index] === '--work-item-id' && args[index + 1]) workItemId = args[++index]
    else throw new Error('Usage: node tools/probe_mcp.mjs [--timeout-ms 15000] [--work-item-id UUID] [--output NEW_FILE]')
  }
  const report = await probeMcp({ timeoutMs, workItemId })
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
