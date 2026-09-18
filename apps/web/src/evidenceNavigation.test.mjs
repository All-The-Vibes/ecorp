import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'
import { evidenceSelectionKey, readEvidenceSelection, rememberEvidenceSelection } from './evidenceSelection.ts'
import { pendingReviewForRun, selectMissionEvidenceRun } from './workflowContext.ts'

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const text = await readFile(new URL('./App.tsx', import.meta.url), 'utf8')
const ast = ts.createSourceFile('App.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
let callback
let reveal
function visit(node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'revealEntityTarget') reveal = node.getText(ast)
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'navigateToWorkspaceEntity') {
    callback = node.initializer.arguments[0].getText(ast)
  }
  ts.forEachChild(node, visit)
}
visit(ast)
assert.ok(callback, 'Execute the actual App navigation handler, not a reimplementation')
const compiled = ts.transpileModule(`const navigate = ${callback}; globalThis.navigate = navigate`, {
  compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS },
}).outputText

function setup({ writeFails = false, viewerActor = id(2), selectedActor = id(2) } = {}) {
  const store = new Map()
  const older = { id: id(31), task_id: id(21), artifact_id: id(41), status: 'waiting_for_approval' }
  const newer = { id: id(32), task_id: id(22), artifact_id: id(42), status: 'completed' }
  const data = { snapshot: { corp: { id: id(1) }, runs: [newer, older],
    tasks: [{ id: id(21), mission_id: id(20) }, { id: id(22), mission_id: id(20) }],
    missions: [{ id: id(20) }] } }
  const storage = { getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => { if (writeFails) throw new Error('storage denied'); store.set(key, value) } }
  const changes = { version: 0, errors: [], views: [], selected: [], reveals: [] }
  const context = { data, currentViewer: { current: { corpId: id(1), actorId: viewerActor } },
    selectedActorId: selectedActor, API_URL: 'http://127.0.0.1:18865',
    evidenceSelectionKey, rememberEvidenceSelection,
    setError: (error) => changes.errors.push(error),
    setEvidenceNavigationVersion: (update) => { changes.version = update(changes.version) },
    setSelectedMissionId: (value) => changes.selected.push(value), setMissionComposerCollapsed: () => {},
    setRoomMissionId: () => {}, setSelectedRoomId: () => {},
    setActiveWorkspaceView: (value) => changes.views.push(value), setAnnouncement: () => {},
    revealEntityTarget: (...args) => { changes.reveals.push(args); return true }, statusLabel: (value) => value,
    window: { sessionStorage: storage, history: { replaceState: () => {} }, setTimeout: (fn) => fn() } }
  vm.runInNewContext(compiled, context)
  const key = evidenceSelectionKey({ server: context.API_URL, corpId: id(1), actorId: id(2), missionId: id(20) })
  store.set(key, newer.id)
  return { context, changes, store, storage, key, older, newer, data, navigate: context.navigate }
}

test('Factory exact-run navigation replaces a remembered newer outcome before mission remount', () => {
  const s = setup()
  s.navigate('run', s.older.id)
  assert.equal(readEvidenceSelection(() => s.storage, s.key), s.older.id)
  assert.equal(s.changes.version, 1)
  const reviews = [{ run_id: s.older.id, task_id: s.older.task_id, status: 'pending' }]
  const selected = selectMissionEvidenceRun(s.data.snapshot.runs, reviews, readEvidenceSelection(() => s.storage, s.key))
  assert.equal(selected.id, s.older.id)
  assert.equal(pendingReviewForRun(selected, reviews).run_id, s.older.id)
  assert.deepEqual(s.changes.errors, [])
  assert.deepEqual(s.changes.views, ['missions'])
  s.store.set(s.key, s.newer.id)
  s.navigate('run', s.older.id)
  assert.equal(s.changes.version, 2, 'Repeated explicit navigation must remount the same mission too')
})

test('run navigation ignores the duplicate activity marker in a hidden Factory tab', () => {
  const calls = []
  const hidden = { closest: () => ({ hidden: true }) }
  const visible = { closest: () => null, parentElement: null,
    scrollIntoView: () => calls.push('scroll-visible'), focus: () => calls.push('focus-visible') }
  const compiledReveal = ts.transpileModule(`${reveal}; globalThis.reveal = revealEntityTarget`, {
    compilerOptions: { target: ts.ScriptTarget.ES2023 },
  }).outputText
  const context = { document: { querySelectorAll: () => [hidden, visible] },
    CSS: { escape: (value) => value }, HTMLDetailsElement: class {} }
  vm.runInNewContext(compiledReveal, context)
  assert.equal(context.reveal('run', id(31)), true)
  assert.deepEqual(calls, ['scroll-visible', 'focus-visible'])
  context.document.querySelectorAll = () => [hidden]
  assert.equal(context.reveal('run', id(31)), false)
})

test('artifact navigation chooses its exact producer while mission-only navigation preserves the current choice', () => {
  const s = setup()
  s.navigate('mission', id(20))
  assert.equal(s.store.get(s.key), s.newer.id)
  assert.equal(s.changes.version, 0)
  s.navigate('artifact', s.older.artifact_id)
  assert.equal(s.store.get(s.key), s.older.id)
  assert.equal(s.changes.version, 1)
})

test('unavailable run/task/mission cannot overwrite remembered evidence or open another run', () => {
  for (const missing of ['run', 'task', 'mission']) {
    const s = setup()
    if (missing === 'run') s.data.snapshot.runs = [s.newer]
    if (missing === 'task') s.data.snapshot.tasks = []
    if (missing === 'mission') s.data.snapshot.missions = []
    s.navigate('run', s.older.id)
    assert.equal(s.store.get(s.key), s.newer.id)
    assert.equal(s.changes.version, 0)
    assert.equal(s.changes.views.length, 0)
    assert.equal(s.changes.errors.length, 1)
  }
})

test('storage failure or obsolete viewer fails closed before navigation', () => {
  for (const options of [{ writeFails: true }, { viewerActor: id(3) }]) {
    const s = setup(options)
    s.navigate('run', s.older.id)
    assert.equal(s.store.get(s.key), s.newer.id)
    assert.equal(s.changes.version, 0)
    assert.equal(s.changes.views.length, 0)
    assert.match(s.changes.errors[0], /No different run has been opened/)
  }
})

test('explicit navigation writes only the selected viewer scope and only the run identity', () => {
  const s = setup({ viewerActor: id(3), selectedActor: id(3) })
  s.navigate('run', s.older.id)
  const otherKey = evidenceSelectionKey({ server: s.context.API_URL, corpId: id(1), actorId: id(3), missionId: id(20) })
  assert.equal(s.store.get(s.key), s.newer.id)
  assert.equal(s.store.get(otherKey), s.older.id)
  assert.equal(s.store.size, 2)
  assert.doesNotMatch(callback, /\b(fetch|api)\s*\(/, 'Navigation grants no server authority')
})
