// Explicit deterministic transport fixture. This never contacts a provider.
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import readline from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

if (process.argv.includes('--version')) {
  console.log('ecorp-codex-stop-fixture 1')
  process.exit(0)
}
const scenario = process.argv.find(arg => arg.startsWith('--scenario='))?.slice(11)
if (!['delayed-thread', 'blocked-stdin', 'completed-after-interrupt',
  'foreign-terminal', 'delayed-output', 'budget-delayed-output', 'foreign-turn-before-response',
  'completed-before-response', 'duplicate-startup', 'early-overflow',
  'owned-tree'].includes(scenario)) {
  throw new Error('An explicit stop fixture scenario is required')
}
const threadId = 'stop-fixture-thread'
const turnId = 'stop-fixture-turn'
const send = value => process.stdout.write(`${JSON.stringify(value)}\n`)
const notify = (method, params) => send({ method, params })
const terminal = (status, thread = threadId) => notify('turn/completed', {
  threadId: thread, turn: { id: turnId, status },
})
const usage = reports => notify('thread/tokenUsage/updated', {
  threadId, turnId, tokenUsage: {
    total: { totalTokens: reports * 12, inputTokens: reports * 10, outputTokens: reports * 2 },
    last: { totalTokens: 12, inputTokens: 10, outputTokens: 2 },
  },
})
writeFileSync('stop-fixture-process.json', JSON.stringify({ pid: process.pid, scenario }))
setInterval(() => {}, 250)
const lines = readline.createInterface({ input: process.stdin })
lines.on('line', async line => {
  const message = JSON.parse(line)
  if (message.method === 'initialize') {
    if (scenario === 'duplicate-startup') {
      send({ id: 3, error: { message: 'unsolicited turn failure' } })
      send({ id: 2, result: { thread: { id: 'unsolicited-thread' } } })
    }
    send({ id: message.id, result: {} })
  }
  if (['thread/start', 'thread/resume'].includes(message.method)) {
    console.error('stop-fixture:thread-pending')
    const respond = () => send({ id: message.id, result: { thread: { id: threadId } } })
    if (scenario === 'delayed-thread') setTimeout(respond, 400)
    else respond()
  }
  if (message.method === 'turn/start') {
    if (scenario === 'foreign-turn-before-response') {
      const foreignTurn = 'different-turn-on-the-same-thread'
      notify('turn/started', { threadId, turn: { id: foreignTurn, status: 'inProgress' } })
      notify('turn/completed', { threadId, turn: { id: foreignTurn, status: 'completed' } })
      setTimeout(() => {
        send({ id: message.id, result: { turn: { id: turnId } } })
        terminal('interrupted')
      }, 400)
      return
    }
    if (scenario === 'completed-before-response') {
      notify('turn/started', { threadId, turn: { id: turnId, status: 'inProgress' } })
      usage(1)
      terminal('completed')
      setTimeout(() => {
        writeFileSync('turn-response-written.txt', JSON.stringify({ observed_at: new Date().toISOString() }))
        send({ id: message.id, result: { turn: { id: turnId } } })
      }, 500)
      return
    }
    if (scenario === 'early-overflow') {
      for (let i = 0; i < 65; i += 1) {
        notify('turn/started', { threadId, turn: { id: `foreign-${i}`, status: 'inProgress' } })
      }
      return
    }
    send({ id: message.id, result: { turn: { id: turnId } } })
    notify('turn/started', { threadId, turn: { id: turnId, status: 'inProgress' } })
    if (scenario === 'duplicate-startup') {
      send({ id: 1, error: { message: 'delayed duplicate initialize failure' } })
      send({ id: 2, result: { thread: { id: 'duplicate-thread' } } })
      send({ id: 3, result: { turn: { id: 'duplicate-turn' } } })
      send({ id: 3, error: { message: 'delayed duplicate turn failure' } })
      terminal('interrupted')
    } else if (scenario === 'owned-tree') {
      spawn(process.execPath, [
        fileURLToPath(new URL('./fake-external-agent.mjs', import.meta.url)),
        '--fixture-tree-parent', 'stop-fixture-tree.json', '--stubborn',
      ], { stdio: 'ignore' })
      const deadline = Date.now() + 5000
      while (true) {
        try {
          const pids = JSON.parse(readFileSync('stop-fixture-tree.json', 'utf8'))
          if (pids.parent && pids.grandchild) break
        } catch {
          // Wait only for this fixture's explicitly owned descendant markers.
        }
        if (Date.now() >= deadline) throw new Error('Owned descendants did not start')
        await delay(20)
      }
      console.error('stop-fixture:tree-running')
    } else if (scenario === 'delayed-thread') {
      writeFileSync('unexpected-start.txt', 'A turn started after the stop directive.\n')
      terminal('completed')
    } else if (scenario === 'blocked-stdin') {
      process.stdin.pause()
      console.error('stop-fixture:stdin-paused')
    } else if (scenario === 'foreign-terminal') {
      terminal('completed', 'another-thread')
      console.error('stop-fixture:foreign-terminal')
    } else if (scenario === 'budget-delayed-output') {
      // Cross 80%, 95%, and 100% of the explicitly configured 100-token
      // budget, then repeat the same cumulative report. Replayed last-usage
      // counters must neither charge again nor cross the 110% stop threshold.
      let reports = 0
      setInterval(() => usage(reports = Math.min(9, reports + 1)), 250)
      console.error('stop-fixture:turn-running')
    } else {
      console.error('stop-fixture:turn-running')
    }
  }
  if (message.method === 'turn/steer') send({ id: message.id, result: { turnId } })
  if (message.method === 'turn/interrupt') {
    send({ id: message.id, result: {} })
    if (scenario === 'completed-after-interrupt') terminal('completed')
    else if (scenario === 'delayed-output') {
      let reports = 0
      const interval = setInterval(() => {
        reports += 1
        usage(reports)
        if (reports === 100) clearInterval(interval)
      }, 100)
    } else if (scenario !== 'budget-delayed-output') terminal('interrupted')
  }
})
