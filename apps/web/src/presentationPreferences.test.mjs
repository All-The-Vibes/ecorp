import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'
import * as jsxRuntime from 'react/jsx-runtime'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'

const bootstrap = await readFile(new URL('../public/presentation-preferences.js', import.meta.url), 'utf8')
const index = await readFile(new URL('../index.html', import.meta.url), 'utf8')
const key = (name) => `ecorp.console.${name}`
function browser({ dark = false, values = {}, readFails = false, writeFails = false } = {}) {
  const stored = new Map(Object.entries(values)), native = new Map(), mediaEvents = new Map(), writes = []
  const root = { dataset: {}, style: {} }, meta = { content: '' }
  const storage = {
    getItem(name) { if (readFails) throw new Error('Storage denied'); return stored.get(name) ?? null },
    setItem(name, value) { if (writeFails) throw new Error('Storage full'); writes.push([name, value]); stored.set(name, value) },
  }
  const media = { matches: dark, addEventListener: (name, listener) => mediaEvents.set(name, listener) }
  const context = {
    document: { documentElement: root, querySelector: (selector) => selector === 'meta[name="theme-color"]' ? meta : null },
    window: { localStorage: storage, matchMedia: () => media, addEventListener: (name, listener) => native.set(name, listener) },
  }
  vm.runInNewContext(bootstrap, context)
  return { root, meta, storage, stored, writes, store: context.window.ecorpPresentation,
    os(value) { media.matches = value; mediaEvents.get('change')() },
    storageEvent(name, value, area = storage) {
      if (name === null) stored.clear()
      else if (value === null) stored.delete(name)
      else stored.set(name, value)
      native.get('storage')({ key: name, storageArea: area })
    },
  }
}

test('blocking local bootstrap precedes the application and initializes the first theme', () => {
  assert.ok(index.indexOf('src="/presentation-preferences.js"') < index.indexOf('type="module"'))
  assert.match(index, /<script src="\/presentation-preferences\.js"><\/script>/)
  for (const dark of [false, true]) {
    const b = browser({ dark })
    assert.deepEqual({ ...b.store.getSnapshot() }, { theme: 'system', resolvedTheme: dark ? 'dark' : 'light', mode: 'operations', storageUnavailable: false })
    assert.equal(b.root.dataset.theme, dark ? 'dark' : 'light')
    assert.equal(b.root.style.colorScheme, dark ? 'dark' : 'light')
    assert.equal(b.meta.content, dark ? '#151a20' : '#e8e8e4')
    assert.deepEqual(b.writes, [], 'Loading presentation must not mutate preferences or any operational state')
  }
})

test('System tracks native OS changes while an explicit override survives OS changes and reload', () => {
  const b = browser()
  let notifications = 0
  const unsubscribe = b.store.subscribe(() => { notifications++ })
  b.os(true)
  assert.equal(b.store.getSnapshot().resolvedTheme, 'dark')
  b.store.setTheme('light')
  const explicit = b.store.getSnapshot()
  b.os(false); b.os(true)
  assert.equal(b.store.getSnapshot(), explicit, 'Irrelevant OS changes preserve immutable snapshot identity')
  assert.equal(b.root.dataset.theme, 'light')
  const reload = browser({ dark: true, values: Object.fromEntries(b.stored) })
  assert.equal(reload.store.getSnapshot().theme, 'light')
  assert.equal(reload.root.dataset.theme, 'light')
  b.store.setTheme('system')
  assert.equal(b.root.dataset.theme, 'dark')
  assert.equal(notifications, 3)
  unsubscribe(); b.os(false)
  assert.equal(notifications, 3)
})

test('mode and theme persist independently and accept no identity, role or action input', () => {
  const b = browser({ dark: true })
  b.store.setMode('executive')
  b.store.setTheme('light')
  assert.deepEqual(b.writes, [[key('mode'), 'executive'], [key('theme'), 'light']])
  assert.equal(b.root.dataset.presentation, 'executive')
  assert.equal(b.store.getSnapshot().mode, 'executive')
  const reload = browser({ values: Object.fromEntries(b.stored) })
  assert.equal(reload.store.getSnapshot().mode, 'executive')
  assert.equal(reload.store.getSnapshot().resolvedTheme, 'light')
  const before = b.store.getSnapshot()
  for (const bad of [null, undefined, 'admin', 'execute', '<script>', 1, {}]) {
    b.store.setTheme(bad); b.store.setMode(bad)
  }
  assert.equal(b.store.getSnapshot(), before)
  assert.equal(b.writes.length, 2)
  assert.equal(Object.isFrozen(before), true)
  assert.deepEqual(Object.keys(b.store).sort(), ['getSnapshot', 'setMode', 'setTheme', 'subscribe'])
})

test('invalid persisted values use System and Operations without rewriting unrelated storage', () => {
  const b = browser({ values: { [key('theme')]: 'invalid', [key('mode')]: 'owner', 'private.other': 'untouched' } })
  assert.equal(b.store.getSnapshot().theme, 'system')
  assert.equal(b.store.getSnapshot().mode, 'operations')
  assert.equal(b.stored.get('private.other'), 'untouched')
  assert.deepEqual(b.writes, [])
})

test('native local-storage updates synchronize tabs; session storage and unrelated keys do not', () => {
  const b = browser()
  b.storageEvent(key('theme'), 'dark')
  b.storageEvent(key('mode'), 'executive')
  assert.equal(b.root.dataset.theme, 'dark')
  assert.equal(b.root.dataset.presentation, 'executive')
  const before = b.store.getSnapshot()
  b.storageEvent('unrelated', 'x')
  b.storageEvent(key('theme'), 'light', {})
  assert.equal(b.store.getSnapshot(), before)
  b.storageEvent(null)
  assert.equal(b.store.getSnapshot().theme, 'system')
  assert.equal(b.store.getSnapshot().mode, 'operations')
  assert.deepEqual(b.writes, [])
})

for (const failure of ['readFails', 'writeFails']) test(`${failure} keeps usable tab preferences and visibly reports reduced persistence`, () => {
  const b = browser({ [failure]: true })
  b.store.setTheme('dark'); b.store.setMode('executive')
  assert.equal(b.store.getSnapshot().storageUnavailable, true)
  assert.equal(b.root.dataset.theme, 'dark')
  assert.equal(b.root.dataset.presentation, 'executive')
})

test('native preference controls have stable accessible labels and all independent choices', async () => {
  const source = await readFile(new URL('./PresentationControls.tsx', import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText
  const exports = {}
  new Function('require', 'exports', compiled)((name) => {
    assert.equal(name, 'react/jsx-runtime'); return jsxRuntime
  }, exports)
  const html = renderToStaticMarkup(jsxRuntime.jsx(exports.PresentationControls, {
    preferences: { theme: 'system', mode: 'executive', resolvedTheme: 'dark', storageUnavailable: true },
    onTheme() {}, onMode() {},
  }))
  for (const id of ['console-theme', 'console-mode']) {
    assert.ok(html.includes(`for="${id}"`)); assert.ok(html.includes(`id="${id}"`))
  }
  for (const value of ['system', 'light', 'dark', 'executive', 'operations']) assert.ok(html.includes(`value="${value}"`))
  assert.match(html, /role="status"/)
  assert.match(html, /browser storage is unavailable/)
  assert.doesNotMatch(html, /disabled|role="switch"/)
})
