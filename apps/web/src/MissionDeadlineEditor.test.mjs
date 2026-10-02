import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { isValidElement } from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'
import * as deadlineModel from './missionDeadline.ts'

const source = await readFile(new URL('./MissionDeadlineEditor.tsx', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, {
  fileName: 'MissionDeadlineEditor.tsx', reportDiagnostics: true,
  compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
})
assert.deepEqual(compiled.diagnostics, [])
const imports = { 'react/jsx-runtime': jsxRuntime, './missionDeadline': deadlineModel }
const exports = {}
new Function('require', 'exports', compiled.outputText)((name) => {
  assert.ok(Object.hasOwn(imports, name), `Unexpected component import ${name}`)
  return imports[name]
}, exports)
const elements = (node) => Array.isArray(node) ? node.flatMap(elements) : !isValidElement(node) ? [] :
  [node, ...elements(node.props.children)]
const policy = { deadline_at: '2026-10-02T12:10:00Z', reserve: { seconds: 120, task_keys: ['implementation', 'review'] } }

test('deadline editor has explicit labels, local timezone, blank defaults and no launch controls', () => {
  const draft = deadlineModel.emptyMissionDeadlineDraft()
  const root = exports.MissionDeadlineEditor({ draft, result: deadlineModel.readMissionDeadlineDraft(draft, 0), onChange() {} })
  const nodes = elements(root)
  const fields = nodes.filter((node) => ['input', 'textarea'].includes(node.type))
  assert.equal(fields.length, 3)
  for (const field of fields) {
    assert.equal(field.props.value, '')
    assert.equal(nodes.filter((node) => node.type === 'label' && node.props.htmlFor === field.props.id).length, 1)
  }
  assert.equal(nodes.some((node) => node.type === 'button'), false)
  const html = renderToStaticMarkup(root)
  assert.match(html, /Deadline in local time/)
  assert.match(html, /No deadline or reserve is supplied by default/)
  assert.match(html, /datetime-local/)
})

test('editor callbacks preserve other explicit fields and do not mutate the draft', () => {
  const draft = Object.freeze({ deadlineLocal: '2026-10-02T12:10:00', reserveSeconds: '120', reserveTaskKeys: 'review' })
  const changes = []
  const nodes = elements(exports.MissionDeadlineEditor({ draft,
    result: { policy, error: null, admissionClosesAt: 1 }, onChange: (value) => changes.push(value) }))
  const changesById = { 'mission-deadline': ['deadlineLocal', '2026-10-02T12:20:00'],
    'mission-reserve-seconds': ['reserveSeconds', '150'], 'mission-reserve-keys': ['reserveTaskKeys', 'implementation\nreview'] }
  for (const [id, [field, value]] of Object.entries(changesById)) {
    nodes.find((node) => node.props.id === id).props.onChange({ target: { value } })
    assert.deepEqual(changes.at(-1), { ...draft, [field]: value })
  }
  assert.equal(draft.reserveSeconds, '120')
})

test('saved readback projects the original shared deadline and the reserved task cutoff', () => {
  const read = (taskKey) => renderToStaticMarkup(exports.MissionDeadlineReadback({ deadline: policy,
    taskKey, contractDeadline: '2026-10-02T12:10:00.000+00:00' }))
  assert.match(read('research'), /data-task-deadline="2026-10-02T12:08:00.000Z"/)
  assert.match(read('implementation'), /data-task-deadline="2026-10-02T12:10:00.000Z"/)
  assert.match(read('review'), /120 seconds reserved/)
  assert.match(read('review'), /data-mission-deadline="2026-10-02T12:10:00Z"/)
  assert.doesNotMatch(read('review'), /accepted success|physical stop confirmed|remaining time:|reset budget/i)
})

test('a missing or changed task contract cannot be presented as an agreed deadline', () => {
  for (const contractDeadline of [null, '2026-10-02T12:11:00Z', '2026-10-02T12:10:00.000000001Z']) {
    const html = renderToStaticMarkup(exports.MissionDeadlineReadback({ deadline: policy, taskKey: 'review', contractDeadline }))
    assert.match(html, /data-deadline-state="mismatch"/)
    assert.match(html, /do not agree/)
    assert.doesNotMatch(html, /data-task-deadline=/)
  }
  const unknown = renderToStaticMarkup(exports.MissionDeadlineReadback({ deadline: { deadline_at: 'unknown' } }))
  assert.match(unknown, /data-deadline-state="unknown"/)
})

test('untimed and legacy task deadlines remain explicit without inventing a mission policy', () => {
  const untimed = renderToStaticMarkup(exports.MissionDeadlineReadback({ deadline: null }))
  assert.match(untimed, /No mission deadline declared/)
  const legacy = renderToStaticMarkup(exports.MissionDeadlineReadback({ deadline: undefined, contractDeadline: policy.deadline_at }))
  assert.match(legacy, /Task contract deadline/)
  assert.doesNotMatch(legacy, /data-mission-deadline=/)
})
