import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { isValidElement } from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'
import * as requests from './humanPublicationRequest.ts'
import { missionResultScope } from './missionResultContext.ts'

// Actual card, hook and controller. Only React scheduling, time and transport
// are controlled; these regressions do not replace complete-stack acceptance.
async function compile(name) {
  const compiled = ts.transpileModule(await readFile(new URL(name, import.meta.url), 'utf8'), {
    fileName: name, reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  })
  assert.deepEqual(compiled.diagnostics, [])
  return compiled.outputText
}
function evaluate(source, imports) {
  const exports = {}
  new Function('require', 'exports', source)((name) => {
    assert.ok(Object.hasOwn(imports, name), `Unexpected import ${name}`)
    return imports[name]
  }, exports)
  return exports
}
const [cardCode, hookCode, workCode] = await Promise.all([
  compile('PublicationRequestCard.tsx'), compile('useHumanPublicationRequest.ts'), compile('WorkResultCard.tsx'),
])
const { WorkResultCard } = evaluate(workCode, { 'react/jsx-runtime': jsxRuntime, './WorkResultCard.css': {} })
const ids = {
  corpId: 'corp-a', actorId: 'alice', roomId: 'room-a', missionId: 'mission-a',
  workItemId: 'item-a', sourceRepository: 'owner/repo',
}
const scope = missionResultScope(ids)
const source = Object.freeze({
  id: 'deliverable-a', task_id: 'task-a', run_id: 'run-a', artifact_id: 'artifact-a',
  head_commit: 'a'.repeat(40), sha256: 'b'.repeat(64), verification_sha256: 'c'.repeat(64),
})
const otherSource = Object.freeze({ ...source, id: 'deliverable-b', run_id: 'run-b', head_commit: 'e'.repeat(40) })
function previewFor(selected = source) {
  return {
    plan: {
      source_deliverable_id: selected.id, target_repository: ids.sourceRepository,
      base_ref: 'main', branch: 'ecorp/result-review', title: '<ScRiPt data-purpose="preview">plain title</ScRiPt>',
      body: 'Review this exact result.\nNo deployment is requested.',
    },
    commit_sha: selected.head_commit, artifact_sha256: selected.sha256,
    verification_sha256: selected.verification_sha256, source_revision: 'source-a', fingerprint: 'd'.repeat(64),
  }
}
function hosts(node) {
  if (Array.isArray(node)) return node.flatMap(hosts)
  if (!isValidElement(node)) return []
  if (typeof node.type === 'function') return hosts(node.type(node.props))
  return [node, ...hosts(node.props.children)]
}
function text(node) {
  if (Array.isArray(node)) return node.map(text).join(' ')
  if (!isValidElement(node)) return typeof node === 'string' || typeof node === 'number' ? String(node) : ''
  return text(typeof node.type === 'function' ? node.type(node.props) : node.props.children)
}
function button(tree, name) {
  const found = hosts(tree).filter((node) => node.type === 'button' && name.test(text(node)))
  assert.equal(found.length, 1)
  assert.equal(found[0].props.type, 'button')
  return found[0]
}
function fixture(overrides = {}) {
  const slots = [], effects = [], calls = [], timers = new Map(), downloads = []
  let cursor = 0, dirty = false, tree, refreshes = 0, timerId = 0, writes = 0
  const different = (a, b) => !a || a.length !== b.length || b.some((value, index) => !Object.is(value, a[index]))
  const react = {
    useMemo(create, deps) {
      const index = cursor++
      if (different(slots[index]?.deps, deps)) slots[index] = { deps, value: create() }
      return slots[index].value
    },
    useCallback(callback, deps) { return react.useMemo(() => callback, deps) },
    useRef(value) { return react.useMemo(() => ({ current: value }), []) },
    useState(initial) {
      const index = cursor++
      if (!slots[index]) {
        const slot = { value: typeof initial === 'function' ? initial() : initial }
        slot.set = (next) => { slot.value = typeof next === 'function' ? next(slot.value) : next; dirty = true; writes++ }
        slots[index] = slot
      }
      return [slots[index].value, slots[index].set]
    },
    useEffect(create, deps) {
      const index = cursor++
      if (different(slots[index]?.deps, deps)) {
        slots[index] = { deps, create, cleanup: slots[index]?.cleanup }
        effects.push(slots[index])
      }
    },
  }
  const api = (path, init) => {
    let resolve, reject
    const promise = new Promise((yes, no) => { resolve = yes; reject = no })
    calls.push({ path, init, resolve, reject })
    return promise
  }
  const hook = evaluate(hookCode, {
    react,
    './humanPublicationRequest': {
      ...requests,
      humanPublicationRequest(selectedScope, selected, transport, publish, onSaved) {
        return requests.humanPublicationRequest(selectedScope, selected, transport, publish, onSaved, {
          setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id },
          clearTimeout(id) { timers.delete(id) },
        })
      },
    },
  })
  const { PublicationRequestCard } = evaluate(cardCode, {
    react, 'react/jsx-runtime': jsxRuntime, './useHumanPublicationRequest': hook, './WorkResultCard': { WorkResultCard },
  })
  let props = {
    scope, result: { state: 'available', candidates: [source] }, api,
    onRefresh: () => { refreshes++ }, onDownload: (selected) => downloads.push(selected), ...overrides,
  }
  const render = (next = props) => { props = next; cursor = 0; dirty = false; tree = PublicationRequestCard(props) }
  const commit = () => {
    for (let pass = 0; ; pass++) {
      assert.ok(pass < 10, 'effect updates must settle')
      for (const effect of effects.splice(0)) { effect.cleanup?.(); effect.cleanup = effect.create() }
      if (!dirty) return
      render()
    }
  }
  const update = (next = props) => { render(next); commit() }
  return {
    update, render, commit, calls, timers, downloads,
    get tree() { return tree }, get props() { return props }, get refreshes() { return refreshes }, get writes() { return writes },
    get html() { return renderToStaticMarkup(tree) },
    async flush() { await new Promise((resolve) => setImmediate(resolve)); update() },
    reconnectEffects() {
      for (const slot of slots) if (slot.create) { slot.cleanup?.(); slot.cleanup = slot.create() }
      if (dirty) update()
    },
    unmount() { slots.forEach((slot) => slot.cleanup?.()); effects.length = 0; assert.equal(timers.size, 0) },
  }
}

test('card requires a source choice and exact preview before offering the request', async () => {
  const f = fixture({ result: { state: 'available', candidates: [source, otherSource] } })
  try {
    f.update()
    assert.equal(f.calls.length, 0)
    assert.equal(button(f.tree, /^Preview pull request$/).props.disabled, true)
    const select = hosts(f.tree).find((node) => node.type === 'select')
    assert.equal(select.props.value, '')
    select.props.onChange({ target: { value: otherSource.id } })
    f.update()
    assert.equal(button(f.tree, /^Preview pull request$/).props.disabled, false)
    button(f.tree, /^Preview pull request$/).props.onClick()
    f.update()
    assert.equal(hosts(f.tree).find((node) => node.type === 'select').props.disabled, true)
    assert.equal(JSON.parse(f.calls[0].init.body).source_deliverable_id, otherSource.id)
    f.calls[0].resolve(previewFor(otherSource))
    await f.flush()
    assert.match(text(f.tree), /Review the pull request target/)
    assert.match(text(f.tree), /owner\/repo.*main/)
    assert.ok(text(f.tree).includes(otherSource.head_commit))
    assert.ok(text(f.tree).includes(otherSource.run_id))
    assert.equal(button(f.tree, /^Request pull request$/).props.disabled, false)
    assert.ok(f.html.includes('&lt;ScRiPt data-purpose=&quot;preview&quot;&gt;plain title&lt;/ScRiPt&gt;'),
      'React renders the exact mixed-case, attributed markup as escaped title text')
    assert.equal(hosts(f.tree).filter((node) => node.type === 'a').length, 0)
    assert.equal(f.calls.length, 1, 'preview never starts publication')
    button(f.tree, /^Download source bundle$/).props.onClick()
    assert.deepEqual(f.downloads, [otherSource])
  } finally { f.unmount() }
})

test('hook fences changed source and scope, including old submit callbacks', async () => {
  const f = fixture()
  try {
    f.update()
    button(f.tree, /^Preview pull request$/).props.onClick()
    f.calls[0].resolve(previewFor())
    await f.flush()
    const oldSubmit = button(f.tree, /^Request pull request$/).props.onClick
    f.update({ ...f.props, result: { state: 'available', candidates: [otherSource] } })
    oldSubmit()
    assert.equal(f.calls.length, 1)
    assert.ok(button(f.tree, /^Preview pull request$/))
    button(f.tree, /^Preview pull request$/).props.onClick()
    const oldPreview = f.calls[1]
    f.update({ ...f.props, scope: missionResultScope({ ...ids, actorId: 'bob' }) })
    assert.equal(oldPreview.init.signal.aborted, true)
    oldPreview.resolve(previewFor(otherSource))
    await f.flush()
    assert.ok(button(f.tree, /^Preview pull request$/))
    assert.equal(f.calls.length, 2)
    assert.equal(f.refreshes, 0)
  } finally { f.unmount() }
})

test('effect reconnect clears stale readiness without a duplicate request', async () => {
  const f = fixture()
  try {
    f.update()
    f.reconnectEffects()
    assert.equal(f.calls.length, 0, 'StrictMode lifecycle never publishes on its own')
    button(f.tree, /^Preview pull request$/).props.onClick()
    f.calls[0].resolve(previewFor())
    await f.flush()
    assert.ok(button(f.tree, /^Request pull request$/))
    f.reconnectEffects()
    assert.ok(button(f.tree, /^Preview pull request$/), 'a replacement controller requires a new preview')
    assert.equal(f.calls.length, 1)
  } finally { f.unmount() }
})

test('an uncertain request offers refresh and never resubmits itself', async () => {
  const f = fixture()
  try {
    f.update()
    button(f.tree, /^Preview pull request$/).props.onClick()
    f.calls[0].resolve(previewFor())
    await f.flush()
    button(f.tree, /^Request pull request$/).props.onClick()
    f.update()
    assert.equal(f.calls.length, 2)
    f.calls[1].reject(new Error('PRIVATE PROVIDER FAILURE'))
    await f.flush()
    assert.match(text(f.tree), /may already be saved/)
    assert.doesNotMatch(text(f.tree), /PRIVATE|PROVIDER|FAILURE/)
    assert.equal(hosts(f.tree).filter((node) => node.type === 'button' && /^(Request|Preview) pull request$/.test(text(node))).length, 0)
    button(f.tree, /^Refresh result$/).props.onClick()
    assert.equal(f.refreshes, 1)
    assert.equal(f.calls.length, 2)
  } finally { f.unmount() }
})
