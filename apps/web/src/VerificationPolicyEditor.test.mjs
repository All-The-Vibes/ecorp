import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { isValidElement } from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'
import * as formText from './formText.ts'
import * as policyModel from './verificationPolicy.ts'

// Exercise the actual component and callbacks. Only React's local selection
// scheduling is controlled; this is not browser focus or runner acceptance.
const source = await readFile(new URL('./VerificationPolicyEditor.tsx', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, {
  fileName: 'VerificationPolicyEditor.tsx', reportDiagnostics: true,
  compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
})
assert.deepEqual(compiled.diagnostics, [])

function elements(node) {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (!isValidElement(node)) return []
  if (typeof node.type === 'function') return elements(node.type(node.props))
  return [node, ...elements(node.props.children)]
}
function text(node) {
  if (Array.isArray(node)) return node.map(text).join('')
  if (isValidElement(node)) return text(node.props.children)
  return node == null || typeof node === 'boolean' ? '' : String(node)
}
function harness(initialPolicy) {
  let policy = initialPolicy
  let selected = 0
  const changes = []
  const imports = {
    react: { useState: () => [selected, (value) => { selected = typeof value === 'function' ? value(selected) : value }] },
    'react/jsx-runtime': jsxRuntime,
    './formText': formText,
    './verificationPolicy': policyModel,
  }
  const exports = {}
  new Function('require', 'exports', compiled.outputText)((name) => {
    assert.ok(Object.hasOwn(imports, name), `Unexpected test import ${name}`)
    return imports[name]
  }, exports)
  const render = () => exports.VerificationPolicyEditor({ policy, idPrefix: 'fixture', onChange: (value) => { policy = value; changes.push(value) } })
  const find = (predicate) => {
    const matches = elements(render()).filter(predicate)
    assert.equal(matches.length, 1, 'Expected one control')
    return matches[0]
  }
  return {
    render, find, changes,
    get policy() { return policy },
    replacePolicy(value) { policy = value },
    button(label) { return find((node) => node.type === 'button' && text(node) === label) },
    control(label) {
      const container = find((node) => node.type === 'label' &&
        [node.props.children].flat().filter((child) => typeof child === 'string').join('').trim() === label)
      const inputs = elements(container).filter((node) => ['input', 'select', 'textarea'].includes(node.type))
      assert.equal(inputs.length, 1, label)
      return inputs[0]
    },
    tabs() { return elements(render()).filter((node) => node.type === 'button' && Object.hasOwn(node.props, 'aria-pressed')) },
    preview(value, heading) { return renderToStaticMarkup(exports.VerificationPolicyPreview({ policy: value, heading })) },
  }
}
const artifact = () => ({ type: 'artifact', min_bytes: 1 })
const policy = (checks = [artifact()], manual_gate = null) => ({ checks, manual_gate })
const change = (control, value) => control.props.onChange({ target: { value } })

test('editor preserves its accessible control names, preview hook, and all six check choices', () => {
  const h = harness(policy())
  const html = renderToStaticMarkup(h.render())
  assert.match(html, /data-testid="fixture-verification-editor"/)
  assert.match(html, /aria-label="Verifier checks"/)
  assert.match(html, /aria-label="Verifier check 1 type"/)
  assert.match(html, /<legend>Check 1<\/legend>/)
  assert.match(html, /data-testid="verification-policy-preview"/)
  const types = elements(h.control('Type')).filter((node) => node.type === 'option').map((node) => node.props.value)
  assert.deepEqual(types, ['artifact', 'file', 'command', 'test', 'json_schema', 'screenshot'])
  assert.equal(h.control('Minimum artifact bytes').props.min, 1)
})

test('switching check types resets their incompatible fields and retains the rest of the policy', () => {
  const manual = { type: 'independent_review', roles: ['member'], exclude_requester: false }
  const other = artifact()
  const original = policy([Object.freeze({ type: 'file', path: 'old.txt', min_bytes: 9 }), other], manual)
  Object.freeze(original.checks)
  Object.freeze(original)
  const h = harness(original)
  change(h.control('Type'), 'command')
  assert.deepEqual(h.policy.checks[0], { type: 'command', program: 'git', args: ['status', '--short'], timeout_ms: 60_000 })
  assert.equal(h.policy.checks[1], other)
  assert.equal(h.policy.manual_gate, manual)
  assert.equal(original.checks[0].path, 'old.txt')
  change(h.control('Arguments, one per line'), ' first argument \r\n--flag=a,b\n echo; literal \n')
  assert.deepEqual(h.policy.checks[0].args, ['first argument', '--flag=a,b', 'echo; literal'])
  change(h.control('Timeout in milliseconds'), '')
  assert.equal(h.policy.checks[0].timeout_ms, 0)
  assert.match(renderToStaticMarkup(h.render()), /timeout must be between 100 and 60,000 ms/)
})

test('every check-field callback retains the selected variant and unchanged checks', () => {
  const h = harness(policy())
  change(h.control('Minimum artifact bytes'), '17')
  assert.equal(h.policy.checks[0].min_bytes, 17)
  for (const type of ['file', 'screenshot']) {
    change(h.control('Type'), type)
    change(h.control('Worktree-relative path'), `evidence/${type}`)
    change(h.control('Minimum bytes'), '42')
    assert.deepEqual(h.policy.checks[0], { type, path: `evidence/${type}`, min_bytes: 42 })
  }
  change(h.control('Type'), 'test')
  change(h.control('Program'), 'node')
  change(h.control('Timeout in milliseconds'), '100')
  assert.deepEqual(h.policy.checks[0], { type: 'test', program: 'node', args: ['test'], timeout_ms: 100 })
  change(h.control('Type'), 'json_schema')
  change(h.control('JSON file'), 'result.json')
  change(h.control('Required top-level keys'), ' status \n\nstate\nstatus')
  assert.deepEqual(h.policy.checks[0], { type: 'json_schema', path: 'result.json', required_keys: ['status', 'state', 'status'] })
})

test('adding and removing checks preserves tab selection, including external policy shrink and the empty state', () => {
  const h = harness(policy())
  h.button('Add check').props.onClick()
  assert.deepEqual(h.tabs().map((tab) => tab.props['aria-pressed']), [false, true])
  assert.deepEqual(h.policy.checks[1], { type: 'file', path: 'README.md', min_bytes: 1 })
  h.button('Add check').props.onClick()
  h.tabs()[1].props.onClick()
  h.button('Remove').props.onClick()
  assert.deepEqual(h.tabs().map((tab) => tab.props['aria-pressed']), [true, false])
  h.tabs()[1].props.onClick()
  h.replacePolicy(policy([artifact()]))
  assert.equal(h.tabs()[0].props['aria-pressed'], true)
  h.button('Remove').props.onClick()
  assert.deepEqual(h.tabs(), [])
  assert.match(renderToStaticMarkup(h.render()), /Add a victory gate/)
  assert.match(renderToStaticMarkup(h.render()), /Add at least one verifier check/)
  h.button('Add check').props.onClick()
  assert.equal(h.tabs()[0].props['aria-pressed'], true)
})

test('the 16-check add button limit and oversized-policy feedback are retained', () => {
  const h = harness(policy(Array.from({ length: 16 }, artifact)))
  assert.equal(h.button('Add check').props.disabled, true)
  h.replacePolicy(policy(Array.from({ length: 17 }, artifact)))
  assert.equal(h.button('Add check').props.disabled, true)
  assert.match(renderToStaticMarkup(h.render()), /at most 16 checks/)
})

test('manual-gate transitions retain default role ordering, requester exclusion, and explicit removal', () => {
  const h = harness(policy())
  const originalChecks = h.policy.checks
  change(h.control('Final reviewer gate'), 'human_approval')
  assert.deepEqual(h.policy.manual_gate, { type: 'human_approval', roles: ['owner', 'admin'] })
  change(h.control('Eligible roles'), 'member, owner\r\nowner')
  assert.deepEqual(h.policy.manual_gate.roles, ['member', 'owner', 'owner'])
  change(h.control('Final reviewer gate'), 'independent_review')
  assert.deepEqual(h.policy.manual_gate, { type: 'independent_review', roles: ['member', 'manager', 'admin', 'owner'], exclude_requester: true })
  const checkbox = h.find((node) => node.type === 'input' && node.props.type === 'checkbox')
  assert.equal(checkbox.props.checked, true)
  checkbox.props.onChange({ target: { checked: false } })
  change(h.control('Eligible roles'), 'admin')
  assert.deepEqual(h.policy.manual_gate, { type: 'independent_review', roles: ['admin'], exclude_requester: false })
  assert.match(renderToStaticMarkup(h.render()), /Mission requester may decide if their role is eligible/)
  change(h.control('Final reviewer gate'), 'none')
  assert.equal(h.policy.manual_gate, null)
  assert.equal(h.policy.checks, originalChecks)
})

test('preview keeps exact check order, manual-role labels, heading overrides, and requester-exclusion guidance', () => {
  const h = harness(policy())
  const checks = [{ type: 'file', path: 'proof.txt', min_bytes: 1 }, artifact()]
  const html = h.preview(policy(checks, { type: 'independent_review', roles: ['member', 'owner'], exclude_requester: true }), 'Reviewed policy')
  assert.match(html, /Reviewed policy/)
  assert.ok(html.indexOf('File proof.txt') < html.indexOf('Provider artifact'))
  assert.match(html, /Independent Review · member, owner/)
  assert.match(html, /Mission requester is excluded from the decision/)
  assert.match(h.preview(policy(), undefined), /Completion gates/)
  assert.match(h.preview(policy(), undefined), /<strong>None<\/strong>/)
})
