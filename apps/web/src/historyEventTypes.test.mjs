import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import * as history from './history.ts'

const domain = await readFile(new URL('../../../crates/crony-domain/src/history.rs', import.meta.url), 'utf8')
const declaration = domain.match(/pub const HISTORY_EVENT_TYPES: &\[&str\] = &\[([\s\S]*?)\];/u)
assert.ok(declaration, 'Read the current server event projection contract')
const serverTypes = [...declaration[1].matchAll(/"([a-z][a-z0-9._]*)"/gu)].map((match) => match[1])

test('browser and server use the same history event allowlist', () => {
  assert.deepEqual(history.HISTORY_EVENT_TYPES, serverTypes)
  for (const status of [...serverTypes, 'other']) {
    assert.ok(history.normalizeHistoryFilters({ ...history.emptyHistoryFilters(), status }), status)
  }
})

test('unknown well-formed event names cannot become history requests', () => {
  const filters = { ...history.emptyHistoryFilters(), status: 'not.a.real.event' }
  assert.equal(history.normalizeHistoryFilters(filters), null)
  assert.throws(() => history.historyRequestPath({
    corpId: '00000000-0000-4000-8000-000000000001',
    actorId: '00000000-0000-4000-8000-000000000002',
    filters, cursor: null, after: null, pageSize: 25,
  }), /Invalid history request/u)
})
