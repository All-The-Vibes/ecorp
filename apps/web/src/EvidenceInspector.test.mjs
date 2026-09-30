import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import * as jsxRuntime from 'react/jsx-runtime'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'
import * as evidence from './sourceEvidence.ts'
import { elements, renderHooks } from './testSupport/renderHooks.mjs'

async function compile(file) {
  return ts.transpileModule(await readFile(new URL(file, import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText
}
const [hookCode, componentCode] = await Promise.all(['useEvidenceInspection.ts', 'EvidenceInspector.tsx'].map(compile))
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const encode = (text) => new TextEncoder().encode(text)
const base = 'a'.repeat(40), verification = 'b'.repeat(64)
const text = (node) => Array.isArray(node) ? node.map(text).join('')
  : node && typeof node === 'object' ? text(node.props?.children) : node == null ? '' : String(node)
function file(path, body = 'hello', overrides = {}) {
  const bytes = encode(body)
  return { path, status: 'A', mode: '100644', sha256: hash(bytes), bytes: bytes.length,
    media_type: 'text/plain', content_base64: Buffer.from(bytes).toString('base64'), ...overrides }
}
function manifest(changes = [file('README.md')], overrides = {}) {
  const patch = encode('diff --git a/README.md b/README.md\n+<img src=x onerror=alert(1)>\n')
  return { schema_version: 1, form: 'archive', base_commit: base, head_commit: null,
    branch: 'crony/source', verification_sha256: verification, changes,
    patch_sha256: hash(patch), patch_base64: Buffer.from(patch).toString('base64'),
    git_bundle_sha256: null, git_bundle_base64: null, ...overrides }
}
function evaluate(code, imports) {
  const exports = {}
  new Function('require', 'exports', code)((name) => {
    assert.ok(Object.hasOwn(imports, name), name)
    return imports[name]
  }, exports)
  return exports
}

// Execute the real leaf and hook with controlled transport/effects. Browser
// acceptance separately proves native authentication, DOM events and layout.
function fixture({ document = manifest(), sourceChange = {}, inputChange = {}, response } = {}) {
  const hooks = renderHooks(), calls = []
  const bytes = typeof document === 'string' ? encode(document) : encode(JSON.stringify(document))
  const source = { kind: 'source', runId: 'run-old', taskId: 'task-old', artifactId: 'artifact-old',
    sha256: hash(bytes), mediaType: 'application/vnd.ecorp.deliverable+json', bytes: bytes.length,
    baseCommit: base, verificationSha256: verification, retentionUntil: '2099-01-01T00:00:00Z',
    form: 'archive', headCommit: null, branch: 'crony/source', ...sourceChange }
  const hook = evaluate(hookCode, { react: hooks.react, './sourceEvidence': evidence })
  const component = evaluate(componentCode, { react: hooks.react, 'react/jsx-runtime': jsxRuntime,
    './sourceEvidence': evidence, './useEvidenceInspection': hook, './EvidenceInspector.css': {} })
  const input = { source, viewer: { server: 'https://ecorp.invalid/api', corpId: 'corp-a',
    actorId: 'actor-a', actorRole: 'member', roomId: 'room-a', missionId: 'mission-a' }, available: true,
  request(path, signal) {
    calls.push({ path, signal })
    return Promise.resolve(response ? response() : new Response(bytes, { headers: { 'content-type': source.mediaType } }))
  }, ...inputChange }
  const render = () => hooks.render(() => {
    const inner = component.EvidenceInspector(input)
    return inner.type(inner.props)
  })
  const button = (label) => {
    const matches = elements(hooks.value, (node) => node.type === 'button' && text(node) === label)
    assert.equal(matches.length, 1, label)
    return matches[0]
  }
  render()
  return {
    hooks, calls, input, component, render, button,
    get html() { return renderToStaticMarkup(hooks.value) }, get tree() { return hooks.value },
    click(label) { button(label).props.onClick(); hooks.flush() },
    async flush(predicate = () => !/Reading and checking|Checking preview bytes/.test(renderToStaticMarkup(hooks.value))) {
      for (let attempt = 0; attempt < 100; attempt++) {
        await new Promise(setImmediate); hooks.flush()
        if (predicate()) return
      }
      assert.fail('Inspector UI did not settle')
    },
    async select(path) {
      const item = elements(hooks.value, (node) => node.type === 'button' && node.props.className === 'evidence-file' && text(node).includes(path))[0]
      assert.ok(item, path); item.props.onClick(); hooks.flush(); await this.flush()
    },
    unmount: hooks.unmount,
  }
}

test('large manifests expose a bounded searchable page and exact identity without outcome controls', async () => {
  const f = fixture({ document: manifest(Array.from({ length: 83 }, (_, i) => file(`src/file-${String(i).padStart(3, '0')}.txt`))) })
  try {
    assert.equal(f.calls.length, 0)
    f.click('Inspect source changes')
    assert.match(f.html, /Reading and checking/)
    await f.flush()
    assert.match(f.html, /83 changed files/)
    assert.match(f.html, /Page 1 of 3/)
    assert.equal(elements(f.tree, (node) => node.type === 'li').length, 40)
    assert.match(f.html, /run-old.*task-old.*artifact-old/)
    assert.match(f.html, /Canonical source identity was not recorded/)
    f.click('Next files')
    assert.match(f.html, /Page 2 of 3/)
    assert.equal(elements(f.tree, (node) => node.type === 'li').length, 40)
    f.click('Next files')
    assert.equal(elements(f.tree, (node) => node.type === 'li').length, 3)
    assert.equal(f.button('Next files').props.disabled, true)
    const search = elements(f.tree, (node) => node.type === 'input')[0]
    search.props.onChange({ target: { value: 'file-041' } }); f.hooks.flush()
    assert.match(f.html, /1 matching file.*Page 1 of 1/)
    await f.select('file-041')
    assert.match(f.html, /aria-label="src\/file-041.txt"/)
    assert.match(f.html, /hello/)
    assert.doesNotMatch(f.html, />Approve|>Reject|Record decision|<iframe|<script/)
    assert.equal(f.calls.length, 1, 'file navigation does not perform new reads or effects')
  } finally { f.unmount() }
})

test('source and diff text stay inert; display masking does not rewrite recorded hashes', async () => {
  const unsafe = file('unsafe.html', '<script>globalThis.compromised = true</script>\npassword="synthetic-secret"\nhello\u202eworld', { media_type: 'text/html' })
  const f = fixture({ document: manifest([unsafe]) })
  try {
    f.click('Inspect source changes'); await f.flush(); await f.select('unsafe.html')
    assert.match(f.html, /&lt;script&gt;globalThis.compromised = true&lt;\/script&gt;/)
    assert.doesNotMatch(f.html, /<script>|synthetic-secret|hello\u202e/)
    assert.match(f.html, /1 line masked as possible credentials/)
    assert.match(f.html, /1 invisible control character/)
    assert.match(f.html, /hello\\u202eworld/)
    assert.match(f.html, new RegExp(unsafe.sha256))
    f.click('Inspect source diff'); await f.flush()
    assert.match(f.html, /&lt;img src=x onerror=alert\(1\)&gt;/)
    assert.doesNotMatch(f.html, /<img|<iframe|dangerouslySetInnerHTML/)
    assert.match(f.html, /Inspection does not record an outcome decision/)
  } finally { f.unmount() }
})

test('deleted, absent, sensitive, binary, unsupported and oversized file states are explicit', async () => {
  const entries = [
    [file('deleted.txt', '', { status: 'D', mode: null, sha256: null, bytes: null, media_type: null, content_base64: null }), /This file was deleted/],
    [file('report.txt', '', { content_base64: null }), /does not include its contents/],
    [file('.env', 'PRIVATE=value'), /potentially sensitive path/],
    [file('image.png', 'binary', { media_type: 'image/png' }), /Binary or non-UTF-8/],
    [file('object.custom', 'unknown', { media_type: 'application/x-custom' }), /no supported text preview/],
    [file('large.txt', 'x', { bytes: evidence.MAX_TEXT_PREVIEW_BYTES + 1 }), /Text preview exceeds 128 KiB/],
  ]
  const f = fixture({ document: manifest(entries.map(([entry]) => entry)) })
  try {
    f.click('Inspect source changes'); await f.flush()
    for (const [entry, message] of entries) {
      await f.select(entry.path)
      assert.match(f.html, message)
    }
    assert.doesNotMatch(f.html, /PRIVATE=value/)
  } finally { f.unmount() }
})

for (const [name, options, message] of [
  ['version', { document: manifest([], { schema_version: 2 }) }, /format or version is not supported/],
  ['digest', { sourceChange: { sha256: '0'.repeat(64) } }, /does not match the selected run/],
  ['denied', { response: () => new Response('private server message', { status: 403 }) }, /server denied access/],
  ['expired', { sourceChange: { retentionUntil: '2000-01-01T00:00:00Z' } }, /retention has expired/],
  ['oversize', { sourceChange: { bytes: evidence.MAX_EVIDENCE_BYTES + 1 } }, /16 MiB inspection limit/],
]) test(`${name} evidence shows its specific failure and no source content`, async () => {
  const f = fixture(options)
  try {
    if (!f.button('Inspect source changes').props.disabled) f.click('Inspect source changes')
    await f.flush()
    assert.match(f.html, message)
    assert.doesNotMatch(f.html, /private server message|Changed files|SHA-256 matches this selected run/)
    if (name === 'expired' || name === 'oversize') assert.equal(f.calls.length, 0)
  } finally { f.unmount() }
})

test('provider output is inspected as its own artifact and disconnect exposes no read control', async () => {
  const f = fixture({ document: 'provider notes', sourceChange: { kind: 'provider', mediaType: 'text/plain', form: null, retentionUntil: null } })
  try {
    f.click('Inspect provider output'); await f.flush()
    assert.match(f.html, /Selected provider output/)
    assert.doesNotMatch(f.html, /Changed files|Inspect source changes/)
    f.click('Close inspection')
    assert.doesNotMatch(f.html, /provider notes|SHA-256 matches this selected run/)
    const key = f.component.EvidenceInspector(f.input).key
    assert.equal(key, f.component.EvidenceInspector({ ...f.input, viewer: { ...f.input.viewer } }).key)
    for (const field of ['corpId', 'actorId', 'actorRole', 'roomId', 'missionId', 'server']) {
      assert.notEqual(key, f.component.EvidenceInspector({ ...f.input, viewer: { ...f.input.viewer, [field]: 'changed' } }).key)
    }
    assert.notEqual(key, f.component.EvidenceInspector({ ...f.input, available: false }).key)
    assert.notEqual(key, f.component.EvidenceInspector({ ...f.input, source: { ...f.input.source, runId: 'run-new' } }).key)
  } finally { f.unmount() }
  const unavailable = fixture({ inputChange: { available: false } })
  try {
    assert.equal(unavailable.button('Inspect source changes').props.disabled, true)
    assert.match(unavailable.html, /current access and connection are confirmed/)
    assert.equal(unavailable.calls.length, 0)
  } finally { unavailable.unmount() }
})
