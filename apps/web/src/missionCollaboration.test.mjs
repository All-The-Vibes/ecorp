import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { isValidElement } from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'
import * as collaboration from './missionCollaboration.ts'
import { discussionScopeKey } from './missionProjection.ts'

const alice = { id: 'alice', name: 'Alice', kind: 'human', role: 'owner' }
const bob = { id: 'bob', name: 'Bob', kind: 'human', role: 'member' }
function fixture() {
  return {
    corpId: 'corp', mission: { id: 'mission', room_id: 'room', requested_by: 'alice' },
    actor: alice, actors: [alice, bob], connection: 'live', snapshotFailed: false, now: Date.parse('2026-09-16T12:00:00Z'),
    tasks: [{ id: 'task', title: 'Build onboarding', mission_id: 'mission', assigned_agent_id: 'agent', status: 'running' }],
    runs: [{ id: 'run', task_id: 'task', agent_id: 'agent', runner_id: 'runner', status: 'running', execution_mode: 'provider' }],
    agents: [{ id: 'agent', name: 'Builder', adapter: 'codex', current_run_id: 'run' }],
    runners: [{ id: 'runner', corp_id: 'corp', hostname: 'qa', connected: true, status: 'connected', capabilities: [] }],
    leases: [{ agent_id: 'agent', actor_id: 'bob', expires_at: '2026-09-16T12:01:00Z' }], reviews: [],
  }
}
const row = (input) => collaboration.missionCollaboration(input).rows[0]

test('mission projection retains exact task, runner and human control attribution', () => {
  const input = fixture(), before = structuredClone(input), actual = row(input)
  assert.equal(collaboration.missionCollaboration(input).requester, 'Alice')
  assert.equal(actual.runId, 'run')
  assert.equal(actual.control, 'Control at snapshot: Bob')
  assert.equal(actual.controlsAvailable, true)
  assert.deepEqual(input, before)
})

test('foreign tasks and same-ID foreign-Corp runners cannot supply collaboration state', () => {
  const input = fixture()
  input.tasks.push({ ...input.tasks[0], id: 'other', mission_id: 'foreign' })
  input.runners[0].corp_id = 'foreign'
  assert.equal(collaboration.missionCollaboration(input).rows.length, 1)
  assert.equal(row(input).controlsAvailable, false)
  assert.equal(row(input).runnerState, 'Runner unavailable in this view')
})

for (const connection of ['offline', 'connecting']) test(`${connection} retains work without advertising live control or termination`, () => {
  const input = fixture(); input.connection = connection
  assert.equal(row(input).controlsAvailable, false)
  assert.equal(row(input).runId, 'run')
  assert.match(row(input).runnerState, /unconfirmed/)
})

test('a failed snapshot refresh retains exact work without advertising live controls', () => {
  const input = fixture(); input.snapshotFailed = true
  assert.equal(row(input).controlsAvailable, false)
  assert.equal(row(input).runId, 'run')
  assert.match(row(input).runnerState, /unconfirmed/)
  assert.doesNotMatch(row(input).control, /Control at snapshot: Bob/)
})

for (const now of [NaN, Infinity, 0, -1]) test(`invalid snapshot receipt ${now} cannot advertise live controls`, () => {
  const input = fixture(); input.now = now
  assert.equal(row(input).controlsAvailable, false)
  assert.equal(row(input).runId, 'run')
  assert.match(row(input).runnerState, /unconfirmed/)
})

for (const expiry of ['2026-09-16T11:59:00Z', '2026-09-16T12:00:00Z', 'bad']) test(`expired/malformed lease ${expiry} cannot claim a controller`, () => {
  const input = fixture(); input.leases[0].expires_at = expiry
  assert.equal(row(input).control, 'No unexpired control lease in this snapshot')
})

for (const mode of ['verifying', 'completed', 'lost', 'cancelled']) test(`${mode} has recorded evidence but no provider controls`, () => {
  const input = fixture(); input.runs[0].status = mode
  assert.equal(row(input).controlsAvailable, false)
  assert.equal(row(input).runId, 'run')
})

test('a provider-free run and a superseded agent assignment expose no live controls', () => {
  const input = fixture(); input.runs[0].execution_mode = 'verification_only'
  assert.equal(row(input).controlsAvailable, false)
  input.runs[0].execution_mode = 'provider'; input.agents[0].current_run_id = 'newer-run'
  assert.equal(row(input).controlsAvailable, false)
  input.agents[0].current_run_id = 'run'; input.tasks[0].assigned_agent_id = 'another-agent'
  assert.equal(row(input).controlsAvailable, false)
})

test('runner grace and offline remain distinct; neither supplies human presence', () => {
  const input = fixture(); input.runners[0].connected = false; input.runners[0].status = 'grace'
  assert.equal(row(input).runnerState, 'Runner reconnecting')
  assert.equal(row(input).controlsAvailable, false)
  input.runners[0].status = 'offline'
  assert.equal(row(input).runnerState, 'Runner offline')
  assert.equal(Object.hasOwn(row(input), 'humanPresence'), false)
})

test('review links bind exact run/task and explain role and requester exclusion', () => {
  const input = fixture(); input.runs[0].status = 'waiting_for_approval'
  input.reviews = [{ run_id: 'run', task_id: 'task', status: 'pending', decided_by: null,
    gate: { type: 'independent_review', roles: ['owner', 'member'], exclude_requester: true } }]
  assert.equal(row(input).controlsAvailable, false)
  assert.match(row(input).review.blockedReason, /different authorized room member/)
  input.actor = bob
  assert.equal(row(input).review.blockedReason, null)
  input.actor = { ...bob, role: 'guest' }
  assert.match(row(input).review.blockedReason, /guest role cannot/)
  input.reviews[0].task_id = 'foreign'
  assert.equal(row(input).review, null)
})

test('missing and historical identities never become fabricated named owners or current controllers', () => {
  const input = fixture(); input.actors = []; input.agents = []
  assert.equal(collaboration.missionCollaboration(input).requester, 'Requester unavailable')
  assert.equal(row(input).agentName, 'Assignment unavailable')
  assert.equal(row(input).controlsAvailable, false)
  input.runs = []; input.tasks[0].assigned_agent_id = null
  assert.equal(row(input).runnerState, 'Not assigned to a runner yet')
})

test('draft cache survives surface remounts but never crosses Corp/actor/room/mission', () => {
  const cache = new Map(), scope = { corpId: 'corp', actorId: 'alice', roomId: 'room', missionId: 'mission' }
  const key = discussionScopeKey(scope), draft = { body: 'Review this', replyToId: 'msg', linkValue: 'run:run' }
  collaboration.saveDiscussionDraft(cache, key, draft)
  draft.body = 'changed caller'
  assert.equal(cache.get(key).body, 'Review this')
  for (const field of Object.keys(scope)) assert.equal(cache.get(discussionScopeKey({ ...scope, [field]: 'other' })), undefined)
  collaboration.saveDiscussionDraft(cache, key, collaboration.emptyDiscussionDraft())
  assert.equal(cache.size, 0)
})

const source = await readFile(new URL('./MissionCollaborationPanel.tsx', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS } }).outputText
const exports = {}
new Function('require', 'exports', compiled)((name) => {
  const imports = { 'react/jsx-runtime': jsxRuntime, './missionCollaboration': collaboration, './MissionCollaborationPanel.css': {} }
  assert.ok(Object.hasOwn(imports, name), `Unexpected import ${name}`)
  return imports[name]
}, exports)
function buttons(node, found = []) {
  if (Array.isArray(node)) node.forEach((child) => buttons(child, found))
  else if (isValidElement(node)) { if (node.type === 'button') found.push(node); buttons(node.props.children, found) }
  return found
}

test('actual component navigation only requests exact context; rendering sends no commands', () => {
  const actions = [], tree = exports.MissionCollaborationPanel({ input: fixture(),
    onSection: (id) => actions.push(['section', id]), onInspectRun: (id) => actions.push(['run', id]), onViewAgent: (id) => actions.push(['agent', id]) })
  const markup = renderToStaticMarkup(tree)
  assert.match(markup, /not a human presence roster/)
  assert.deepEqual(actions, [])
  buttons(tree).forEach((button) => { assert.equal(button.props.type, 'button'); button.props.onClick() })
  assert.deepEqual(actions, [['section', 'brief'], ['section', 'tasks'], ['section', 'evidence'], ['section', 'discussion'], ['agent', 'agent'], ['run', 'run']])
})

test('actual disconnected component retains readable evidence with an explicit warning', () => {
  const input = fixture(); input.connection = 'offline'; input.tasks[0].title = '<script>unsafe</script>'
  const markup = renderToStaticMarkup(exports.MissionCollaborationPanel({ input, onSection() {}, onInspectRun() {}, onViewAgent() {} }))
  assert.match(markup, /does not mean the runner stopped/)
  assert.match(markup, /&lt;script&gt;unsafe/)
  assert.doesNotMatch(markup, /Open Builder controls/)
  assert.match(markup, /Inspect this run/)
})

test('actual failed-refresh component distinguishes stale data from a disconnected transport', () => {
  const input = fixture(); input.snapshotFailed = true
  const markup = renderToStaticMarkup(exports.MissionCollaborationPanel({ input, onSection() {}, onInspectRun() {}, onViewAgent() {} }))
  assert.match(markup, /Last snapshot refresh failed/)
  assert.match(markup, /Showing recorded state/)
  assert.doesNotMatch(markup, /Receiving shared updates|Shared updates disconnected|Open Builder controls/)
  assert.match(markup, /Inspect this run/)
})

test('actual component rejects missing receipt freshness and restores controls after a successful refresh', () => {
  const input = fixture(); input.now = NaN
  const render = () => renderToStaticMarkup(exports.MissionCollaborationPanel({ input, onSection() {}, onInspectRun() {}, onViewAgent() {} }))
  assert.match(render(), /Snapshot freshness unavailable/)
  assert.doesNotMatch(render(), /Receiving shared updates|Open Builder controls/)
  input.now = Date.parse('2026-09-16T12:00:00Z'); input.snapshotFailed = false
  assert.match(render(), /Receiving shared updates/)
  assert.match(render(), /Open Builder controls/)
})

test('App preserves main snapshot metadata and exact-run navigation while passing numeric receipt freshness', async () => {
  const app = await readFile(new URL('./App.tsx', import.meta.url), 'utf8')
  assert.ok(/receivedAt: string; refreshFailed: boolean/.test(app), 'Keep main snapshot metadata')
  assert.ok(/receivedAt: new Date\(\)\.toISOString\(\), refreshFailed: false/.test(app), 'Keep ISO snapshot receipt')
  assert.ok(/now: Date\.parse\(snapshotLoad\?\.receivedAt \?\? ''\)/.test(app), 'Convert snapshot receipt at projection boundary')
  assert.ok(/snapshotFailed: snapshotLoad\?\.refreshFailed \?\? true/.test(app), 'Fail closed without a snapshot')
  assert.ok(/\$\{selectedMission\.id\}:\$\{evidenceNavigationVersion\}/.test(app), 'Keep exact-run remount')
  assert.ok(/runner-indicator \$\{snapshotCurrent && connectedRunners\.length/.test(app), 'Gate global runner status on snapshot freshness')
  assert.ok(/className=\{snapshotCurrent && connectedRunners\.length \? 'journey-complete'/.test(app), 'Start guide must not confirm stale runner connectivity')
  assert.ok(/\{!snapshotCurrent \? 'Runner state unconfirmed until the snapshot refreshes\.'/.test(app), 'Start guide explains unconfirmed state without suggesting reenrollment')
})

test('App embeds existing scoped discussion and pins evidence before exact-run navigation', async () => {
  const app = await readFile(new URL('./App.tsx', import.meta.url), 'utf8')
  assert.match(app, /source="mission" drafts=\{discussionDrafts\}/)
  assert.match(app, /mission: missionScope/)
  assert.match(app, /rememberEvidenceRun\(runId\)[\s\S]*?requestAnimationFrame/)
  assert.match(app, /drafts.save\(draftKey, next\)/)
  assert.match(app, /drafts.complete\(draftKey, draft\)/)
  assert.match(app, /clearBrowserOperation\(operationStorageKey, idempotencyKey\)/)
  assert.doesNotMatch(source, /fetch\(|WebSocket|localStorage|setInterval/)
})

test('late completion notifies remounted composers without clearing a newer or same-text draft', () => {
  const store = collaboration.createDiscussionDraftStore(), updates = []
  const stop = store.subscribe(() => updates.push(store.get('scope')))
  const first = { body: 'A draft', replyToId: null, linkValue: '' }
  store.save('scope', first)
  const submitted = store.get('scope')
  store.save('scope', first) // New edit generation, even with the same text.
  assert.equal(store.complete('scope', submitted), false)
  assert.equal(store.get('scope').body, 'A draft')
  const newer = store.get('scope')
  assert.equal(store.complete('scope', newer), true)
  assert.equal(store.get('scope').body, '')
  assert.equal(updates.at(-1).body, '', 'remounted composers observe the cleared draft')
  assert.equal(store.get('scope'), store.get('scope'), 'empty snapshots remain stable')
  stop()
  store.save('scope', first)
  assert.equal(updates.length, 3)
})

test('late operation acknowledgment cannot clear a replacement idempotency key', async () => {
  const app = await readFile(new URL('./App.tsx', import.meta.url), 'utf8')
  const file = ts.createSourceFile('App.tsx', app, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const fn = file.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'clearBrowserOperation')
  const code = ts.transpileModule(fn.getText(file), { compilerOptions: { target: ts.ScriptTarget.ES2023 } }).outputText
  const storage = new Map([['scope', JSON.stringify({ key: 'newer', payload: 'new draft' })]])
  const clear = new Function('window', `${code}; return clearBrowserOperation;`)({ sessionStorage: {
    getItem: (key) => storage.get(key) ?? null, removeItem: (key) => storage.delete(key),
  } })
  clear('scope', 'older'); assert.equal(storage.has('scope'), true)
  clear('scope', 'newer'); assert.equal(storage.has('scope'), false)
})

test('actual App selection never substitutes another mission after the selected record disappears', async () => {
  const app = await readFile(new URL('./App.tsx', import.meta.url), 'utf8')
  const file = ts.createSourceFile('App.tsx', app, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let initializer
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === 'collaborationMission') initializer = node.initializer
    ts.forEachChild(node, visit)
  }
  visit(file)
  assert.ok(initializer)
  const code = ts.transpileModule(`exports.select = (data, selectedMissionId) => (${initializer.getText(file)});`, {
    compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS },
  }).outputText
  const selected = {}
  new Function('exports', 'selectCollaborationMission', code)(selected, collaboration.selectCollaborationMission)
  const remaining = { id: 'other-mission' }, data = { snapshot: { missions: [remaining] } }
  assert.equal(selected.select(data, 'missing-selected-mission'), undefined)
  assert.equal(selected.select(data, null), remaining)
  assert.equal(selected.select(data, 'other-mission'), remaining)
  assert.equal(selected.select(null, 'other-mission'), undefined)
  assert.match(app, /const selectedMission = collaborationMission/)
})

test('actual briefing navigation has a visible destination for legacy empty descriptions', async () => {
  const app = await readFile(new URL('./App.tsx', import.meta.url), 'utf8')
  const file = ts.createSourceFile('App.tsx', app, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let brief
  const visit = (node) => {
    if (ts.isJsxElement(node) && node.openingElement.attributes.properties.some((attribute) =>
      ts.isJsxAttribute(attribute) && attribute.name.getText(file) === 'className' &&
      attribute.initializer?.text === 'mission-dossier mission-briefing')) brief = node
    ts.forEachChild(node, visit)
  }
  visit(file)
  assert.ok(brief)
  while (brief.parent && (ts.isParenthesizedExpression(brief.parent) || ts.isConditionalExpression(brief.parent) || ts.isJsxExpression(brief.parent))) brief = brief.parent
  const expression = ts.isJsxExpression(brief) ? brief.expression : brief
  const compiledBrief = ts.transpileModule(`exports.render = (mission) => (${expression.getText(file)});`, {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS },
  }).outputText
  const rendered = {}
  new Function('require', 'exports', compiledBrief)((name) => { assert.equal(name, 'react/jsx-runtime'); return jsxRuntime }, rendered)
  const markup = renderToStaticMarkup(rendered.render({ id: 'legacy', description: '' }))
  assert.match(markup, /id="mission-brief-legacy"/)
  assert.match(markup, /No additional specification is recorded/)
  assert.match(renderToStaticMarkup(rendered.render({ id: 'full', description: 'Approved scope' })), /Approved scope/)
})
