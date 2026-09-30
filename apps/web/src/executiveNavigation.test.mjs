import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'
import { buildExecutiveOverview, executiveDestinationAvailable } from './executiveOverview.ts'
import { executiveFixture } from './testSupport/executiveFixture.mjs'
import { workSelectionForLink } from './workSelection.ts'

// Run the actual App callbacks: a valid model alone does not prove an obsolete
// rendered link cannot navigate after authority or the receipt has changed.
const source = await readFile(new URL('./App.tsx', import.meta.url), 'utf8')
const ast = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const names = ['rememberCurrentWork', 'navigateToWorkspaceEntity', 'openExecutiveRecord']
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
  '\nglobalThis.open = openExecutiveRecord;', { compilerOptions: { target: ts.ScriptTarget.ES2023 } }).outputText
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const targets = [
  { kind: 'mission', id: id(20), missionId: id(20) },
  { kind: 'task', id: id(21), missionId: id(20) },
  { kind: 'run', id: id(30), missionId: id(20) },
  { kind: 'artifact', id: id(40), missionId: id(20) },
]
function setup() {
  const identifiers = { 'corp-a': id(1), alice: id(2), 'agent-a': id(3), 'runner-a': id(4),
    'room-a': id(10), 'mission-a': id(20), 'task-a': id(21), 'run-a': id(30), 'artifact-a': id(40), 'event-a': id(50) }
  const fixture = JSON.parse(JSON.stringify(executiveFixture()), (_key, value) =>
    typeof value === 'string' ? identifiers[value] ?? value : value)
  const { viewer, stamp, snapshot, runners } = fixture
  snapshot.runs.unshift({ ...snapshot.runs[0], id: id(31), artifact_id: id(41),
    status: 'completed', verification_status: 'passed' })
  snapshot.tasks[0].attempt_count = 2
  snapshot.agents[0].current_run_id = id(31)
  const data = { snapshot, runners }
  const budgetContext = { snapshot, viewer, stamp }
  const changes = { errors: [], reveals: [], saved: [], views: [], modes: [], timers: [],
    clock: fixture.now, writeFails: false }
  const context = {
    Date: { now: () => changes.clock }, data, budgetContext,
    currentBudgetContext: { current: budgetContext }, currentViewer: { current: viewer }, selectedActorId: viewer.actorId,
    selectedWork: { missionId: id(20), taskId: id(21), runId: id(31) },
    buildExecutiveOverview, executiveDestinationAvailable, workSelectionForLink,
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

for (const target of targets) test(`Executive ${target.kind} opens its exact context beside a newer completed run`, () => {
  const s = setup()
  s.open(target)
  assert.deepEqual(s.changes.views, ['missions'])
  assert.deepEqual(s.changes.modes, ['operations'])
  assert.equal(s.changes.saved.length, 1)
  assert.equal(s.changes.saved[0].missionId, id(20))
  assert.equal(s.changes.saved[0].taskId, id(21))
  assert.equal(s.changes.saved[0].runId, target.kind === 'mission' ? id(31) : target.kind === 'task' ? null : id(30))
  assert.deepEqual(s.changes.reveals, [])
  s.flush()
  assert.deepEqual(s.changes.reveals, [[target.kind, target.id]])
  assert.deepEqual(s.changes.errors, [])
})

const invalidations = [
  ['new snapshot receipt', (s) => { s.context.currentBudgetContext.current = { ...s.context.budgetContext } }],
  ['scope change before rerender', (s) => { s.context.currentBudgetContext.current = null }],
  ['A to B to A', (s) => { s.context.currentViewer.current = { corpId: id(1), actorId: id(9) }
    s.context.currentViewer.current = { corpId: id(1), actorId: id(2) } }],
  ['another actor', (s) => { s.context.currentViewer.current = { corpId: id(1), actorId: id(9) } }],
  ['another Corp', (s) => { s.context.currentViewer.current = { corpId: id(9), actorId: id(2) } }],
  ['expired receipt', (s) => { s.changes.clock += 60_000 }],
  ['future receipt', (s) => { s.changes.clock-- }],
  ['failed authorized read', (s) => { s.context.budgetContext.stamp.refreshFailed = true }],
  ['offline', (s) => { s.context.budgetContext.stamp.connection = 'offline' }],
  ['reconnecting', (s) => { s.context.budgetContext.stamp.connection = 'connecting' }],
  ['missing room ancestry', (s) => { s.context.data.snapshot.rooms = [] }],
  ['removed exact task', (s) => { s.context.data.snapshot.tasks = [] }],
  ['removed exact run', (s) => { s.context.data.snapshot.runs = s.context.data.snapshot.runs.filter((run) => run.id !== id(30)) }],
]
for (const [name, invalidate] of invalidations) {
  test(`${name} rejects Executive activation before saving or changing the view`, () => {
    const s = setup()
    // Scope handlers invalidate the rendered receipt immediately. IDs alone
    // cannot make a callback from an earlier A generation current again.
    if (name === 'A to B to A') s.context.currentBudgetContext.current = null
    invalidate(s)
    s.open(targets[2])
    assert.deepEqual(s.changes.saved, [])
    assert.deepEqual(s.changes.views, [])
    assert.deepEqual(s.changes.modes, [])
    assert.deepEqual(s.changes.timers, [])
    assert.equal(s.changes.errors.length, 1)
  })
  test(`${name} rejects delayed Executive focus after accepted activation`, () => {
    const s = setup()
    s.open(targets[2])
    invalidate(s)
    s.flush()
    assert.deepEqual(s.changes.reveals, [])
    assert.equal(s.changes.errors.length, 1)
  })
}

test('missing or foreign Executive destinations never choose current neighboring work', () => {
  for (const target of targets.flatMap((target) => [
    { ...target, id: id(99) }, { ...target, missionId: id(99) },
  ])) {
    const s = setup()
    s.open(target)
    assert.deepEqual(s.changes.saved, [])
    assert.deepEqual(s.changes.views, [])
    assert.equal(s.changes.errors.length, 1)
  }
})

test('ambiguous artifact ownership refuses both immediate and delayed navigation', () => {
  for (const delayed of [false, true]) {
    const s = setup()
    if (delayed) s.open(targets[3])
    s.context.data.snapshot.runs[0].artifact_id = id(40)
    if (delayed) s.flush()
    else s.open(targets[3])
    assert.deepEqual(s.changes.reveals, [])
    if (!delayed) assert.deepEqual(s.changes.saved, [])
    assert.equal(s.changes.errors.length, 1)
  }
})

test('work selection storage failure keeps the Executive view and never schedules focus', () => {
  const s = setup()
  s.changes.writeFails = true
  s.open(targets[2])
  assert.deepEqual(s.changes.views, [])
  assert.deepEqual(s.changes.modes, [])
  assert.deepEqual(s.changes.timers, [])
  assert.equal(s.changes.errors.length, 1)
})

test('a missing exact DOM target reports unavailability without a mission fallback', () => {
  const s = setup()
  s.context.revealEntityTarget = (...args) => { s.changes.reveals.push(args); return false }
  s.open(targets[3])
  s.flush()
  assert.deepEqual(s.changes.reveals, [['artifact', id(40)]])
  assert.equal(s.changes.errors.length, 1)
})

test('Executive focus opens exact record disclosures and respects reduced motion', () => {
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
    assert.equal(context.reveal('run', id(30)), true)
    assert.equal(details.open, true)
    assert.deepEqual(calls, [['scroll', reducedMotion ? 'auto' : 'smooth'], ['focus']])
  }
})
