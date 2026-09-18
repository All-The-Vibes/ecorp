import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import * as jsxRuntime from 'react/jsx-runtime'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'

// Execute the actual component with controlled hooks, transport and browser handles.
// These tests never navigate a real browser or authenticate a human.
const source = await readFile(new URL('./DelegatedPanel.tsx', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, {
  fileName: 'DelegatedPanel.tsx', reportDiagnostics: true,
  compilerOptions: {
    target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
  },
})
assert.deepEqual(compiled.diagnostics, [])
const tick = () => new Promise((resolve) => setImmediate(resolve))
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const operation = (changes = {}) => ({
  id: 'operation-1', mission_id: 'mission-1', task_id: 'task-1', run_id: 'run-1',
  status: 'waiting_for_authentication', expires_at: '2099-01-01T00:00:00Z',
  released: false, ...changes,
})
const snapshot = (operations = [], changes = {}) => ({
  provider: 'keycloak-test', enabled: true, operations, ...changes,
})

function harness(options = {}) {
  let slots = [], effects = [], cursor = 0, dirty = false, tree, key, props
  const calls = [], popups = [], navigations = [], timers = new Map(), listeners = new Map()
  let timerId = 0, refreshes = 0
  const browser = {
    location: {
      href: 'http://localhost:5173/?delegated_auth=returned', search: '?delegated_auth=returned',
      assign: (url) => navigations.push(url),
    },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    open() {
      if (options.blocked) return null
      const popup = {
        closed: false, opener: browser,
        close() { this.closed = true },
        location: { replace: (url) => navigations.push(url) },
      }
      popups.push(popup)
      return popup
    },
    setTimeout(callback) { const id = ++timerId; timers.set(id, callback); return id },
    clearTimeout(id) { timers.delete(id) },
    addEventListener(name, callback) { listeners.set(name, callback) },
    removeEventListener(name, callback) { if (listeners.get(name) === callback) listeners.delete(name) },
  }
  const document = { visibilityState: 'visible' }
  const different = (a, b) => !a || a.length !== b.length || b.some((value, i) => !Object.is(value, a[i]))
  const react = {
    useRef(initial) {
      const index = cursor++
      return slots[index] ??= { current: initial }
    },
    useState(initial) {
      const index = cursor++
      if (!slots[index]) {
        slots[index] = { value: typeof initial === 'function' ? initial() : initial }
        slots[index].set = (next) => {
          slots[index].value = typeof next === 'function' ? next(slots[index].value) : next
          dirty = true
        }
      }
      return [slots[index].value, slots[index].set]
    },
    useMemo(create, deps) {
      const index = cursor++
      if (different(slots[index]?.deps, deps)) slots[index] = { deps, value: create() }
      return slots[index].value
    },
    useCallback(callback, deps) { return react.useMemo(() => callback, deps) },
    useEffect(create, deps) {
      const index = cursor++
      if (different(slots[index]?.deps, deps)) {
        const effect = { deps, create, cleanup: slots[index]?.cleanup }
        slots[index] = effect
        effects.push(effect)
      }
    },
    useLayoutEffect(create, deps) { react.useEffect(create, deps) },
  }
  const exports = {}
  new Function('require', 'exports', 'window', 'document', compiled.outputText)((name) => {
    const imports = { react, 'react/jsx-runtime': jsxRuntime, './DelegatedPanel.css': {} }
    assert.ok(Object.hasOwn(imports, name), `Unexpected import ${name}`)
    return imports[name]
  }, exports, browser, document)
  props = {
    corpId: 'corp-a', roomId: 'room-a', actorId: 'alice',
    serverUrl: 'http://localhost:3000', onRefresh: () => { refreshes++ },
    api(path, init) {
      const response = deferred()
      calls.push({ path, init, response })
      return response.promise
    },
  }
  const unmount = () => {
    slots.forEach((slot) => slot.cleanup?.())
    slots = []
    effects = []
  }
  const render = (next = props) => {
    props = next
    const element = exports.DelegatedPanel(props)
    if (key !== element.key) { unmount(); key = element.key }
    for (let pass = 0; ; pass++) {
      assert.ok(pass < 20, 'component must settle')
      cursor = 0
      dirty = false
      tree = element.type(element.props)
      for (const effect of effects.splice(0)) { effect.cleanup?.(); effect.cleanup = effect.create() }
      if (!dirty) break
    }
  }
  const nodes = (node) => {
    if (Array.isArray(node)) return node.flatMap((child) => nodes(child))
    if (!node || typeof node !== 'object') return []
    return [node, ...nodes(node.props?.children)]
  }
  const text = (node) => {
    if (Array.isArray(node)) return node.map(text).join('')
    if (node && typeof node === 'object') return text(node.props?.children)
    return node == null ? '' : String(node)
  }
  render()
  return {
    calls, popups, navigations, timers, listeners, document, render, unmount,
    get props() { return props },
    get html() { return renderToStaticMarkup(tree) },
    get refreshes() { return refreshes },
    replayEffects() {
      const mountedEffects = slots.filter((slot) => slot.create)
      mountedEffects.forEach((effect) => effect.cleanup?.())
      mountedEffects.forEach((effect) => { effect.cleanup = effect.create() })
      render()
    },
    button(label) { return nodes(tree).find((node) => node.type === 'button' && text(node) === label) },
    click(label) {
      const button = this.button(label)
      assert.ok(button, `Missing button ${label}`)
      assert.ok(!button.props.disabled, `Disabled button ${label}`)
      button.props.onClick()
      render()
    },
    async flush() { await tick(); render(); await tick(); render() },
    async answer(data, index = calls.length - 1) { calls[index].response.resolve(data); await this.flush() },
    async poll(data) {
      const [id, callback] = timers.entries().next().value
      timers.delete(id)
      callback()
      await this.answer(data)
    },
  }
}

async function start(h) {
  await h.answer(snapshot())
  h.click('Run protected resource job')
  assert.equal(h.calls.at(-1).path, '/api/corps/corp-a/delegated/jobs')
  assert.deepEqual(JSON.parse(h.calls.at(-1).init.body), { actor_id: 'alice', room_id: 'room-a' })
  await h.answer({ mission_id: 'mission-1', task_id: 'task-1' })
  await h.answer(snapshot([operation()]))
}

test('reserves browser synchronously, starts the actual job, then automatically authorizes once', async () => {
  const h = harness()
  await start(h)
  assert.equal(h.popups.length, 1)
  assert.equal(h.calls.at(-1).path, '/api/corps/corp-a/delegated/operation-1/authorize')
  assert.deepEqual(JSON.parse(h.calls.at(-1).init.body), { actor_id: 'alice' })
  await h.answer({ browser_url: 'http://localhost:3000/api/delegated/browser/ticket-123' })
  assert.deepEqual(h.navigations, ['http://localhost:3000/api/delegated/browser/ticket-123'])
  assert.equal(h.popups[0].opener, null)
  await h.poll(snapshot([operation()]))
  await h.poll(snapshot([operation()]))
  assert.equal(h.calls.filter((call) => call.path.endsWith('/authorize')).length, 1)
  assert.match(h.html, /Keycloak.*TEST ONLY/)
  assert.ok(h.refreshes > 0)
  h.unmount()
  assert.equal(h.timers.size, 0)
})

test('durable callback state is read without reopening historical sign-ins or releasing receipts', async () => {
  const h = harness()
  assert.match(h.calls[0].path, /\?actor_id=alice$/)
  await h.answer(snapshot([operation()]))
  await h.poll(snapshot([operation({ status: 'authorized', private_preview: {
    sha256: 'a'.repeat(64), verified: true, subject_preserved: true,
  } })]))
  assert.equal(h.popups.length, 0)
  assert.ok(h.calls.every((call) => !call.init || call.init.method === 'GET'))
  assert.match(h.html, /Private receipt/)
  assert.match(h.html, /Subject preserved/)
  h.click('Release private receipt')
  assert.equal(h.calls.at(-1).path, '/api/corps/corp-a/delegated/operation-1/release')
  assert.deepEqual(h.calls.at(-1).init.headers, { 'content-type': 'application/json' })
  assert.deepEqual(JSON.parse(h.calls.at(-1).init.body), { actor_id: 'alice' })
  await h.answer({})
  await h.answer(snapshot([operation({ status: 'completed', released: true })]))
  assert.match(h.html, /Released/)
  h.unmount()
})

test('popup blocking exposes explicit resume without repeated authorization on polls', async () => {
  const h = harness({ blocked: true })
  await start(h)
  await h.answer({ browser_url: '/api/delegated/browser/ticket-123' })
  assert.match(h.html, /blocked|closed/i)
  assert.ok(h.button('Resume sign-in'))
  await h.poll(snapshot([operation()]))
  assert.equal(h.calls.filter((call) => call.path.endsWith('/authorize')).length, 1)
  assert.equal(h.navigations.length, 0)
  h.click('Resume sign-in')
  await h.flush()
  assert.deepEqual(h.navigations, ['http://localhost:3000/api/delegated/browser/ticket-123'])
  assert.equal(h.calls.filter((call) => call.path.endsWith('/authorize')).length, 1)
  h.unmount()
})

test('only the exact newly assigned mission and task can automatically open sign-in', async () => {
  const h = harness()
  await h.answer(snapshot([operation({ id: 'old' })]))
  h.click('Run protected resource job')
  assert.equal(h.popups.length, 1, 'reservation precedes the job response')
  await h.answer({ mission_id: 'new-mission', task_id: 'new-task' })
  await h.answer(snapshot([operation(), operation({ id: 'other', mission_id: 'new-mission' })]))
  assert.equal(h.calls.filter((call) => call.path.endsWith('/authorize')).length, 0)
  await h.poll(snapshot([operation({ mission_id: 'new-mission', task_id: 'new-task' })]))
  assert.equal(h.calls.at(-1).path, '/api/corps/corp-a/delegated/operation-1/authorize')
  h.unmount()
})

test('actor, corp, room and server changes fence delayed responses and discard private state', async () => {
  for (const change of [
    { actorId: 'bob' }, { corpId: 'corp-b' }, { roomId: 'room-b' },
    { serverUrl: 'http://localhost:4000' },
  ]) {
    const h = harness()
    await start(h)
    const oldAuthorization = h.calls.at(-1)
    h.render({ ...h.props, ...change })
    oldAuthorization.response.resolve({ browser_url: '/api/delegated/browser/old-ticket' })
    await h.flush()
    assert.equal(h.navigations.length, 0)
    assert.equal(h.popups[0].closed, true)
    assert.doesNotMatch(h.html, /mission-1|operation-1/)
    await h.answer(snapshot([operation()]))
    assert.equal(h.calls.filter((call) => call.path.endsWith('/authorize')).length, 1)
    h.unmount()
  }
})

test('cancel is explicit, fences an in-flight authorization and does not retry terminal work', async () => {
  const h = harness()
  await start(h)
  const authorization = h.calls.at(-1)
  h.click('Cancel job')
  assert.equal(h.calls.at(-1).path, '/api/corps/corp-a/delegated/operation-1/cancel')
  assert.deepEqual(JSON.parse(h.calls.at(-1).init.body), { actor_id: 'alice' })
  await h.answer({})
  authorization.response.resolve({ browser_url: '/api/delegated/browser/stale-ticket' })
  await h.flush()
  await h.answer(snapshot([operation({ status: 'cancelled' })]))
  assert.equal(h.navigations.length, 0)
  assert.equal(h.popups[0].closed, true)
  assert.ok(!h.button('Resume sign-in'))
  await h.poll(snapshot([operation({ status: 'cancelled' })]))
  assert.equal(h.calls.filter((call) => call.path.endsWith('/authorize')).length, 1)
  h.unmount()
})

test('terminal and elapsed operations never authorize automatically or offer a retry', async () => {
  for (const changes of [
    { status: 'cancelled' }, { status: 'expired' }, { status: 'failed' }, { status: 'completed' },
    { expires_at: '2000-01-01T00:00:00Z' },
  ]) {
    const h = harness()
    await h.answer(snapshot())
    h.click('Run protected resource job')
    await h.answer({ mission_id: 'mission-1', task_id: 'task-1' })
    await h.answer(snapshot([operation(changes)]))
    assert.equal(h.calls.filter((call) => call.path.endsWith('/authorize')).length, 0)
    assert.ok(!h.button('Resume sign-in'))
    assert.equal(h.popups[0].closed, true)
    h.unmount()
  }
})

test('no provider and polling failures fail closed with a visible explanation', async () => {
  const h = harness()
  await h.answer(snapshot([], { enabled: false }))
  assert.ok(h.button('Run protected resource job').props.disabled)
  assert.match(h.html, /not configured|unavailable|disabled/i)
  await h.poll(snapshot([], { provider: 'entra' }))
  assert.match(h.html, /Microsoft Entra/)
  const [id, callback] = h.timers.entries().next().value
  h.timers.delete(id)
  callback()
  h.calls.at(-1).response.reject(new Error('network down'))
  await h.flush()
  assert.match(h.html, /role="alert"/)
  assert.ok(h.button('Run protected resource job').props.disabled)
  h.unmount()
})

test('job and authorization failures are visible and never automatically resubmitted', async () => {
  const h = harness()
  await h.answer(snapshot())
  h.click('Run protected resource job')
  h.calls.at(-1).response.reject(new Error('job unavailable'))
  await h.flush()
  assert.match(h.html, /role="alert"/)
  assert.equal(h.popups[0].closed, true)
  h.click('Run protected resource job')
  await h.answer({ mission_id: 'mission-1', task_id: 'task-1' })
  await h.answer(snapshot([operation()]))
  h.calls.at(-1).response.reject(new Error('authorize unavailable'))
  await h.flush()
  assert.match(h.html, /role="alert"/)
  await h.poll(snapshot([operation()]))
  assert.equal(h.calls.filter((call) => call.path.endsWith('/authorize')).length, 1)
  assert.ok(h.button('Resume sign-in'))
  h.unmount()
})

test('only same-server ticket URLs may navigate, never IdP, credentials or unrelated routes', async () => {
  for (const browser_url of [
    'https://login.microsoftonline.com/authorize', 'javascript:alert(1)',
    'http://localhost:3000/api/delegated/browser/ticket?access_token=secret',
    'http://user:password@localhost:3000/api/delegated/browser/ticket',
    '/api/delegated/browser/', '/api/other/ticket',
  ]) {
    const h = harness()
    await start(h)
    await h.answer({ browser_url })
    assert.equal(h.navigations.length, 0)
    assert.match(h.html, /role="alert"/)
    assert.doesNotMatch(h.html, /access_token|password|javascript:/)
    h.unmount()
  }
})

test('manual foreground resume claims the owned assignment and cannot be followed by automatic reopening', async () => {
  const h = harness()
  await h.answer(snapshot())
  h.click('Run protected resource job')
  h.document.visibilityState = 'hidden'
  await h.answer({ mission_id: 'mission-1', task_id: 'task-1' })
  await h.answer(snapshot([operation()]))
  assert.equal(h.calls.filter((call) => call.path.endsWith('/authorize')).length, 0)
  h.document.visibilityState = 'visible'
  h.click('Resume sign-in')
  await h.answer({ browser_url: '/api/delegated/browser/manual-ticket' })
  await h.poll(snapshot([operation()]))
  assert.equal(h.calls.filter((call) => call.path.endsWith('/authorize')).length, 1)
  assert.equal(h.popups[0].closed, true, 'unused job reservation is closed')
  assert.deepEqual(h.navigations, ['http://localhost:3000/api/delegated/browser/manual-ticket'])
  h.unmount()
})

test('a consumed ticket is never reused by a later explicit resume', async () => {
  const h = harness()
  await start(h)
  await h.answer({ browser_url: '/api/delegated/browser/first-ticket' })
  h.popups[0].closed = true
  h.click('Resume sign-in')
  assert.equal(h.calls.filter((call) => call.path.endsWith('/authorize')).length, 2)
  await h.answer({ browser_url: '/api/delegated/browser/second-ticket' })
  assert.equal(h.navigations.at(-1), 'http://localhost:3000/api/delegated/browser/second-ticket')
  h.unmount()
})

test('StrictMode replay, focus and changing callback identities keep one live polling loop', async () => {
  const h = harness()
  const firstRead = h.calls[0]
  h.replayEffects()
  await h.answer(snapshot())
  firstRead.response.resolve(snapshot([operation()]))
  await h.flush()
  assert.doesNotMatch(h.html, /mission-1/)
  assert.equal(h.timers.size, 1)
  const originalApi = h.props.api
  const count = h.calls.length
  h.render({ ...h.props, api: (...args) => originalApi(...args), onRefresh() {} })
  assert.equal(h.calls.length, count)
  h.listeners.get('pageshow')()
  h.listeners.get('focus')()
  assert.equal(h.calls.length, count + 1, 'overlapping refreshes share a single request')
  await h.answer(snapshot())
  assert.equal(h.timers.size, 1)
  h.unmount()
  assert.equal(h.listeners.size, 0)
})

test('late job creation from a prior actor cannot claim an operation in a later scope', async () => {
  const h = harness()
  await h.answer(snapshot())
  h.click('Run protected resource job')
  const jobRequest = h.calls.at(-1)
  h.render({ ...h.props, actorId: 'bob' })
  await h.answer(snapshot())
  jobRequest.response.resolve({ mission_id: 'mission-1', task_id: 'task-1' })
  await h.flush()
  assert.equal(h.popups[0].closed, true)
  assert.equal(h.calls.filter((call) => call.path.endsWith('/authorize')).length, 0)
  assert.doesNotMatch(h.html, /mission-1/)
  h.unmount()
})
