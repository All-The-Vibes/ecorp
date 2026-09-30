import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'
import { budgetDestinationAvailable, buildBudgetOverview } from './budgetOverview.ts'
import { workSelectionForLink } from './workSelection.ts'

// Exercise App's real activation, work selection and delayed focus callbacks.
// Ledger predicates alone cannot catch an obsolete rendered callback firing.
const source = await readFile(new URL('./App.tsx', import.meta.url), 'utf8')
const ast = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const names = ['rememberCurrentWork', 'navigateToWorkspaceEntity', 'openBudgetRecord']
const callbacks = new Map()
let reveal
function visit(node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'revealEntityTarget') reveal = node.getText(ast)
  if (ts.isVariableDeclaration(node) && names.includes(node.name.getText(ast))) {
    callbacks.set(node.name.getText(ast), node.initializer.arguments[0].getText(ast))
  }
  ts.forEachChild(node, visit)
}
visit(ast)
assert.equal(callbacks.size, names.length)
const compiled = ts.transpileModule(names.map((name) => `const ${name} = ${callbacks.get(name)};`).join('\n') +
  '\nglobalThis.open = openBudgetRecord;', { compilerOptions: { target: ts.ScriptTarget.ES2023 } }).outputText
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const targets = [
  { kind: 'budget', missionId: id(20) },
  { kind: 'revision', missionId: id(20), revisionId: id(40) },
  { kind: 'suspension', missionId: id(20), runId: id(30) },
]
function setup() {
  const viewer = { corpId: id(1), actorId: id(2) }
  const changes = { errors: [], reveals: [], saved: [], views: [], modes: [], timers: [], clock: Date.now(), writeFails: false }
  const scoped = (n, extra) => ({ id: id(n), corp_id: id(1), ...extra })
  const data = { snapshot: { corp: { id: id(1), name: 'Current Corp' }, rooms: [scoped(10)],
    missions: [scoped(20, { room_id: id(10), title: 'Current mission', status: 'failed',
      original_budget_tokens: 100, original_budget_cost_microusd: 100,
      budget_tokens: 200, budget_cost_microusd: 200 })],
    tasks: [scoped(21, { mission_id: id(20), attempt_count: 2 })],
    runs: [scoped(30, { task_id: id(21), agent_id: id(3), status: 'cancelled', breaker_stage: 'suspend',
      resumed_from_run_id: null, input_tokens: 10, output_tokens: 1, cost_microusd: 0 }),
    scoped(31, { task_id: id(21), agent_id: id(3), status: 'completed', breaker_stage: null,
      resumed_from_run_id: id(30), input_tokens: 20, output_tokens: 2, cost_microusd: 0 })],
    mission_budget_revisions: [scoped(40, { mission_id: id(20), status: 'pending', version: 1,
      proposed_budget_tokens: 400, proposed_budget_cost_microusd: 400 })],
  } }
  const budgetContext = { snapshot: data.snapshot, viewer,
    stamp: { ...viewer, receivedAt: new Date(changes.clock).toISOString(), connection: 'live', refreshFailed: false } }
  const context = {
    Date: { now: () => changes.clock }, data, budgetContext,
    currentBudgetContext: { current: budgetContext }, currentViewer: { current: viewer }, selectedActorId: viewer.actorId,
    selectedWork: { missionId: id(20), taskId: id(21), runId: id(31) },
    budgetDestinationAvailable, buildBudgetOverview, workSelectionForLink,
    rememberSelectedWork: (choice) => { if (changes.writeFails) return false; changes.saved.push(choice); return true },
    setError: (message) => changes.errors.push(message), setEvidenceNavigationVersion: () => {},
    setRoomMissionId: () => {}, setSelectedRoomId: () => {}, setMissionComposerCollapsed: () => {},
    setFloorInspectorOpen: () => {}, setPresentationMode: (mode) => changes.modes.push(mode),
    setActiveWorkspaceView: (view) => changes.views.push(view), setAnnouncement: () => {}, statusLabel: (kind) => kind,
    revealEntityTarget: (...args) => { changes.reveals.push(args); return true },
    window: { history: { replaceState() {} }, setTimeout: (callback) => changes.timers.push(callback) },
  }
  vm.runInNewContext(compiled, context)
  return { context, changes, open: context.open, flush: () => changes.timers.splice(0).forEach((callback) => callback()) }
}

for (const target of targets) test(`${target.kind} opens its exact record without selecting a newer substitute`, () => {
  const s = setup()
  s.open(target)
  assert.deepEqual(s.changes.views, ['missions'])
  assert.deepEqual(s.changes.modes, ['operations'])
  assert.equal(s.changes.saved.length, 1)
  assert.equal(s.changes.saved[0].runId, target.kind === 'suspension' ? id(30) : id(31))
  assert.deepEqual(s.changes.reveals, [])
  s.flush()
  assert.deepEqual(s.changes.reveals, [[target.kind === 'revision' ? 'budget-revision' : target.kind === 'suspension' ? 'run' : 'budget',
    target.revisionId ?? target.runId ?? target.missionId]])
  assert.deepEqual(s.changes.errors, [])
})

const invalidations = [
  ['new snapshot', (s) => { s.context.currentBudgetContext.current = { ...s.context.budgetContext } }],
  ['scope change before rerender', (s) => { s.context.currentBudgetContext.current = null }],
  ['A to B to A', (s) => { s.context.currentViewer.current = { corpId: id(1), actorId: id(9) }
    s.context.currentViewer.current = { corpId: id(1), actorId: id(2) } }],
  ['another actor', (s) => { s.context.currentViewer.current = { corpId: id(1), actorId: id(9) } }],
  ['another Corp', (s) => { s.context.currentViewer.current = { corpId: id(9), actorId: id(2) } }],
  ['expired receipt', (s) => { s.changes.clock += 60_000 }],
  ['failed authorized read', (s) => { s.context.budgetContext.stamp.refreshFailed = true }],
  ['offline receipt', (s) => { s.context.budgetContext.stamp.connection = 'offline' }],
  ['missing room', (s) => { s.context.data.snapshot.rooms = [] }],
]
for (const [name, invalidate] of invalidations) {
  test(`${name} rejects activation before saving work or changing the view`, () => {
    const s = setup()
    // The callback belongs to the render that produced this receipt. Its viewer
    // must match that generation too, even if the IDs return to the same value.
    if (name === 'A to B to A') s.context.currentBudgetContext.current = null
    invalidate(s)
    s.open(targets[1])
    assert.deepEqual(s.changes.saved, [])
    assert.deepEqual(s.changes.views, [])
    assert.deepEqual(s.changes.modes, [])
    assert.deepEqual(s.changes.timers, [])
    assert.equal(s.changes.errors.length, 1)
  })
  test(`${name} rejects delayed focus after an accepted activation`, () => {
    const s = setup()
    s.open(targets[1])
    invalidate(s)
    s.flush()
    assert.deepEqual(s.changes.reveals, [])
    assert.equal(s.changes.errors.length, 1)
  })
}

test('a missing exact mission, revision or suspension cannot select other current work', () => {
  for (const target of [
    { ...targets[0], missionId: id(99) }, { ...targets[1], revisionId: id(99) },
    { ...targets[2], runId: id(31) }, { ...targets[2], missionId: id(99) },
  ]) {
    const s = setup()
    s.open(target)
    assert.deepEqual(s.changes.saved, [])
    assert.deepEqual(s.changes.views, [])
    assert.equal(s.changes.errors.length, 1)
  }
})

test('selection storage failure never schedules focus or opens another record', () => {
  const s = setup()
  s.changes.writeFails = true
  s.open(targets[1])
  assert.deepEqual(s.changes.views, [])
  assert.deepEqual(s.changes.timers, [])
  assert.equal(s.changes.errors.length, 1)
})

test('a target missing from the rendered DOM reports unavailability without a mission fallback', () => {
  const s = setup()
  s.context.revealEntityTarget = (...args) => { s.changes.reveals.push(args); return false }
  s.open(targets[1])
  s.flush()
  assert.deepEqual(s.changes.reveals, [['budget-revision', id(40)]])
  assert.equal(s.changes.errors.length, 1)
})

test('exact budget focus opens its history disclosure and honors reduced motion', () => {
  const compiledReveal = ts.transpileModule(`${reveal}; globalThis.reveal = revealEntityTarget`, {
    compilerOptions: { target: ts.ScriptTarget.ES2023 },
  }).outputText
  for (const reducedMotion of [false, true]) {
    const calls = []
    const details = { open: false, parentElement: null }
    const target = { closest: () => null, parentElement: { closest: () => details },
      scrollIntoView: (options) => calls.push(['scroll', options.behavior]), focus: () => calls.push(['focus']) }
    const context = { document: { querySelectorAll: () => [target] }, CSS: { escape: (value) => value },
      HTMLDetailsElement: class {}, window: { matchMedia: () => ({ matches: reducedMotion }) } }
    vm.runInNewContext(compiledReveal, context)
    assert.equal(context.reveal('budget-revision', id(40)), true)
    assert.equal(details.open, true)
    assert.deepEqual(calls, [['scroll', reducedMotion ? 'auto' : 'smooth'], ['focus']])
  }
})
