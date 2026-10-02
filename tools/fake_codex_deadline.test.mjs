import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'

// Execute the actual deterministic transport with in-memory files/timers. These
// are safe protocol tests, not server acceptance or a real provider qualification.
function fixture() {
  const script = fileURLToPath(new URL('../scripts/fake-codex-app-server.mjs', import.meta.url))
  const source = readFileSync(script, 'utf8')
  assert.equal(source.match(/^import .+ from 'node:[^']+'\r?$/gmu)?.length, 3)
  const applicationImport = "import { writeCheckpointApplication } from './checkpoint-application-fixture.mjs'"
  assert.equal(source.split(applicationImport).length, 2)
  const messages = [], writes = [], timers = new Map()
  let onLine, nextId = 0
  runInNewContext(source.replace(/^import .+ from 'node:[^']+'\r?$/gmu, '').replace(applicationImport, ''), {
    randomUUID: () => `fixture-${++nextId}`,
    writeFileSync: (file, bytes) => writes.push({ file, bytes }),
    existsSync: () => false,
    writeCheckpointApplication: () => assert.fail('No application marker was supplied'),
    createInterface: () => ({ on: (type, callback) => { assert.equal(type, 'line'); onLine = callback } }),
    process: { argv: [], cwd: () => '/fixture', platform: 'fixture', stdin: {},
      stdout: { write: line => { messages.push(JSON.parse(line)); return true } } },
    setTimeout: (callback, ms) => { const id = ++nextId; timers.set(id, { callback, ms }); return id },
    setInterval: (callback, ms) => { const id = ++nextId; timers.set(id, { callback, ms }); return id },
    clearTimeout: id => timers.delete(id), clearInterval: id => timers.delete(id),
  }, { timeout: 1000, filename: script })
  const send = (method, params = {}, id = ++nextId) => onLine(JSON.stringify({ id, method, params }))
  send('thread/start', { cwd: '/fixture' })
  const start = marker => send('turn/start', { input: [{ type: 'text', text: marker }] })
  return { messages, writes, timers, send, start }
}

test('deadline fixture reports late native success only after the explicit interrupt response', () => {
  const f = fixture()
  f.start('[deadline-complete-after-stop]')
  assert.deepEqual(f.writes, [{ file: '/fixture/base.txt', bytes: 'base\n' }])
  assert.ok(!f.messages.some(message => message.method === 'turn/completed'))
  assert.deepEqual([...f.timers.values()].map(timer => timer.ms), [100, 60_000])
  f.send('turn/interrupt', {}, 1000)
  const reply = f.messages.findIndex(message => message.id === 1000)
  const terminal = f.messages.findIndex(message => message.method === 'turn/completed')
  assert.ok(reply >= 0 && terminal > reply)
  assert.equal(f.messages[terminal].params.turn.status, 'completed')
  assert.equal(f.timers.size, 0)
  f.send('turn/interrupt')
  assert.equal(f.messages.filter(message => message.method === 'turn/completed').length, 1)
})

test('ordinary delayed fixture still reports interrupted and never emits a success answer', () => {
  const f = fixture()
  f.start('[steering-contention]')
  f.send('turn/interrupt')
  assert.equal(f.messages.find(message => message.method === 'turn/completed').params.turn.status, 'interrupted')
  assert.ok(!f.messages.some(message => message.method === 'item/agentMessage/delta'))
  assert.equal(f.timers.size, 0)
})

test('late-success opt-in is reset for the next native turn', () => {
  const f = fixture()
  f.start('[deadline-complete-after-stop]')
  f.send('turn/interrupt')
  f.start('[steering-contention]')
  f.send('turn/interrupt')
  assert.deepEqual(f.messages.filter(message => message.method === 'turn/completed')
    .map(message => message.params.turn.status), ['completed', 'interrupted'])
  assert.equal(f.timers.size, 0)
})
