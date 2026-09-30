import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import * as jsxRuntime from 'react/jsx-runtime'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'
import * as history from './history.ts'
import { elements, renderHooks } from './testSupport/renderHooks.mjs'

const compiled = ts.transpileModule(await readFile(new URL('./HistoryPanel.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const text = (node) => Array.isArray(node) ? node.map(text).join('')
  : node && typeof node === 'object' ? text(node.props?.children) : node == null ? '' : String(node)
const tick = () => new Promise((resolve) => setImmediate(resolve))
function fixture() {
  const hooks = renderHooks(), calls = [], navigations = [], focus = [], exports = {}
  const imports = { react: hooks.react, 'react/jsx-runtime': jsxRuntime, './history': history, './HistoryPanel.css': {} }
  new Function('require', 'exports', compiled)((name) => {
    assert.ok(Object.hasOwn(imports, name), name); return imports[name]
  }, exports)
  let props = { corpId: id(1), corpName: 'Private Corp', actorId: id(2), actorName: 'Reviewer',
    rooms: [{ id: id(3), name: 'Engineering' }], actors: [{ id: id(2), name: 'Reviewer' }],
    revision: 'access-1', connected: true, onNavigate: (link) => navigations.push(link),
    api(path, init) {
      let resolve, reject
      const promise = new Promise((yes, no) => { resolve = yes; reject = no })
      calls.push({ path, init, resolve, reject }); return promise
    } }
  const render = (next = props) => {
    props = next
    hooks.render(() => exports.HistoryPanel(props))
    const heading = elements(hooks.value, (n) => n.type === 'h3')[0]
    heading.props.ref.current = { focus: () => focus.push(text(heading)) }
    return hooks.value
  }
  const button = (label) => {
    const matches = elements(hooks.value, (n) => n.type === 'button' && text(n) === label)
    assert.equal(matches.length, 1, label); return matches[0]
  }
  const control = (label) => {
    const parent = elements(hooks.value, (n) => n.type === 'label' && text(n).startsWith(label))[0]
    assert.ok(parent, label)
    return elements(parent, (n) => n.type === 'input' || n.type === 'select')[0]
  }
  const answer = (index, { count = 25, start = 80, next = 'abcd', cause = null, link = true } = {}) => {
    const url = new URL(calls[index].path, 'http://fixture.invalid'), filters = history.emptyHistoryFilters()
    for (const key of Object.keys(filters)) filters[key] = url.searchParams.get(key) ?? filters[key]
    calls[index].resolve({ corp_id: url.pathname.split('/')[3], actor_id: url.searchParams.get('actor_id'),
      filters, page_size: 25, observed_at: '2026-09-29T15:00:00Z', next_cursor: next,
      entries: Array.from({ length: count }, (_, i) => ({ id: id(start - i), kind: filters.kind,
        room_id: id(3), title: '<script>never execute</script>', summary: 'Safe static summary', status: 'run.completed',
        actor_id: id(2), actor_name: 'Reviewer', created_at: '2026-09-29T12:00:00Z', seq: String(start - i),
        mission_id: link ? id(4) : null, task_id: link ? id(5) : null, run_id: link ? id(6) : null, cause_id: cause })) })
  }
  render()
  return { hooks, calls, navigations, focus, render, button, control, answer,
    submit() { elements(hooks.value, (n) => n.type === 'form')[0].props.onSubmit({ preventDefault() {} }); render() },
    get props() { return props }, get tree() { return hooks.value }, get html() { return renderToStaticMarkup(hooks.value) },
    async flush() { await tick(); render() }, unmount: hooks.unmount }
}

test('history shows loading, applied scope, safe details and explicit partial-history limits', async () => {
  const f = fixture()
  try {
    assert.match(f.html, /Loading authorized history/)
    assert.match(f.html, /Private Corp.*Reviewer/)
    assert.match(f.html, /not a complete export or a count of all work/)
    assert.match(f.html, /Events are ordered by journal sequence/)
    assert.equal(f.button('Next page').props.disabled, true)
    f.answer(0); await f.flush()
    assert.match(f.html, /25 records on this page/)
    assert.match(f.html, /&lt;script&gt;never execute&lt;\/script&gt;/)
    assert.doesNotMatch(f.html, /<script>|Loading authorized/)
    assert.equal(elements(f.tree, (n) => n.props?.['data-history-id']).length, 25)
    assert.equal(f.focus.length, 0, 'initial/background loading must not steal focus')
    elements(f.tree, (n) => n.type === 'button' && text(n) === 'Open exact run')[0].props.onClick()
    assert.deepEqual(f.navigations, [{ kind: 'run', id: id(6) }])
  } finally { f.unmount() }
})

test('next/previous use server cursors and preserve the applied query until explicit refresh', async () => {
  const f = fixture()
  try {
    f.answer(0); await f.flush()
    f.button('Next page').props.onClick(); f.render()
    assert.match(f.calls[1].path, /cursor=abcd/)
    assert.doesNotMatch(f.html, /25 records on this page/)
    f.answer(1, { count: 2, start: 55, next: null }); await f.flush()
    assert.match(f.html, /page 2/)
    assert.match(f.html, /2 records on this page/)
    assert.equal(f.button('Next page').props.disabled, true)
    assert.equal(f.focus.length, 1)
    f.button('Previous page').props.onClick(); f.render()
    assert.doesNotMatch(f.calls[2].path, /cursor=/)
    f.answer(2); await f.flush()
    assert.match(f.html, /page 1/)
    f.button('Refresh history').props.onClick(); f.render()
    assert.doesNotMatch(f.calls[3].path, /cursor=/)
    assert.match(f.html, /Search refreshed from the first page/)
  } finally { f.unmount() }
})

test('draft input does not silently change applied filters; invalid IDs make no request', async () => {
  const f = fixture()
  try {
    f.answer(0); await f.flush()
    f.control('Search titles').props.onChange({ target: { value: 'literal %_' } }); f.render()
    assert.equal(f.calls.length, 1)
    const applied = elements(f.tree, (n) => n.props?.['data-testid'] === 'history-applied')[0]
    assert.doesNotMatch(text(applied), /literal/)
    f.control('Mission ID').props.onChange({ target: { value: 'invalid-id' } }); f.render(); f.submit()
    assert.match(f.html, /Use valid IDs/)
    assert.equal(f.calls.length, 1)
    f.control('Mission ID').props.onChange({ target: { value: id(4) } }); f.render(); f.submit()
    assert.equal(new URL(f.calls[1].path, 'http://fixture.invalid').searchParams.get('search'), 'literal %_')
    assert.match(f.html, /literal %_/)
    assert.equal(f.calls[0].init.signal.aborted, true)
    f.answer(1, { count: 0, next: null }); await f.flush()
    assert.match(f.html, /No authorized records match/)
    assert.match(f.html, /not a statement about hidden or retained history/)
    assert.equal(f.button('Next page').props.disabled, true)
    f.button('Clear filters').props.onClick(); f.render()
    assert.equal(new URL(f.calls[2].path, 'http://fixture.invalid').searchParams.has('mission_id'), false)
  } finally { f.unmount() }
})

test('unknown well-formed event filters show a form error without replacing authorized results or requesting the server', async () => {
  const f = fixture()
  try {
    f.answer(0); await f.flush()
    f.control('Event type').props.onChange({ target: { value: 'not.a.real.event' } }); f.render(); f.submit()
    assert.equal(f.calls.length, 1)
    assert.match(f.html, /supported status/u)
    assert.match(f.html, /25 records on this page/u)
    assert.doesNotMatch(f.html, /History is unavailable|Loading authorized history/u)
    const applied = elements(f.tree, (n) => n.props?.['data-testid'] === 'history-applied')[0]
    assert.doesNotMatch(text(applied), /not\.a\.real\.event/u)
    f.control('Event type').props.onChange({ target: { value: 'other' } }); f.render(); f.submit()
    assert.equal(new URL(f.calls[1].path, 'http://fixture.invalid').searchParams.get('status'), 'other')
  } finally { f.unmount() }
})

test('causal navigation clears incompatible filters and names the exact event with no payload rendering', async () => {
  const f = fixture()
  try {
    f.answer(0, { count: 1, next: null, cause: id(19), link: false }); await f.flush()
    assert.match(f.html, /No authorized work link recorded/)
    f.button('Open causal event').props.onClick(); f.render()
    const params = new URL(f.calls[1].path, 'http://fixture.invalid').searchParams
    assert.equal(params.get('record_id'), id(19))
    assert.equal(params.get('kind'), 'event')
    for (const name of ['room_id', 'mission_id', 'attributed_actor_id', 'status']) assert.equal(params.has(name), false)
    assert.match(f.html, /Opened the exact causal event.*Other filters were cleared/)
    assert.match(f.html, /Exact event/)
  } finally { f.unmount() }
})

test('revocation, disconnect and stale responses cannot retain or substitute history rows', async () => {
  const f = fixture()
  try {
    f.answer(0); await f.flush()
    f.render({ ...f.props, revision: 'access-revoked', rooms: [] })
    assert.doesNotMatch(f.html, /25 records on this page/)
    assert.equal(f.calls[0].init.signal.aborted, true)
    f.calls[1].reject(new Error('database password must never render')); await f.flush()
    assert.match(f.html, /History is unavailable/)
    assert.doesNotMatch(f.html, /password/)
    f.render({ ...f.props, connected: false })
    assert.match(f.html, /Live updates are disconnected or stale/)
    assert.match(f.html, /Loading authorized history/)
    f.render({ ...f.props, connected: true })
    f.answer(2); await f.flush()
    assert.doesNotMatch(f.html, /25 records on this page/)
    f.answer(3, { count: 0, next: null }); await f.flush()
    assert.match(f.html, /No authorized records match/)
  } finally { f.unmount() }
})
