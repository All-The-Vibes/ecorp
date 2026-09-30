// Controlled hooks execute the production panel and handlers. Browser acceptance
// separately exercises React reconciliation, focus, layout and the native stack.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import ts from 'typescript'
import * as jsxRuntime from 'react/jsx-runtime'
import * as revisionModel from './contractRevision.ts'
import { factoryContractRevisionSource } from './factoryCheckpointRecovery.ts'

const source = await readFile(new URL('./App.tsx', import.meta.url), 'utf8')
export const app = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
export function find(node, predicate) {
  if (predicate(node)) return node
  let result
  ts.forEachChild(node, child => { result ??= find(child, predicate) })
  return result
}
export const appFunction = name => find(app, n => ts.isFunctionDeclaration(n) && n.name?.text === name)
export function evaluate(code, globals) {
  vm.runInNewContext(ts.transpileModule(code, {
    compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, globals)
}
export const id = n => '00000000-0000-4000-8000-' + String(n).padStart(12, '0')
export const contract = () => ({
  objective: 'Retain the original scope', expected_output: 'Reviewed change',
  source_repository: null, source_base_ref: null, source_base_commit: null,
  acceptance_tests: ['Existing checks pass'], allowed_tools: ['read'], prohibited_actions: ['Do not publish'],
  references: [], write_scope: ['src/**'], budget_tokens: 1000, budget_cost_microusd: 1000,
  deadline_at: null, escalation: 'Ask the operator', secret_refs: [], model: null, reasoning_effort: null,
  deliverable: null,
})
export const policy = () => ({ checks: [{ type: 'artifact', min_bytes: 1 }], manual_gate: null })
export const mission = () => ({ id: id(2), room_id: id(3), requested_by: id(4), status: 'ready',
  description: 'Original specification', specification_version: 2, budget_tokens: 10000, budget_cost_microusd: 10000 })
export const task = () => ({ id: id(5), mission_id: id(2), status: 'ready', contract_version: 2,
  contract: contract(), verification_policy: policy(), required_adapter: 'fake-process' })
export const run = (changes = {}) => ({
  id: id(6), task_id: id(5), status: 'failed', provider_session_id: 'native-session',
  workspace_run_id: id(6), resumed_from_run_id: null, workspace_path: '/owned/work',
  workspace_disposition: 'preserved', workspace_detail: null, breaker_stage: null,
  execution_mode: 'provider', agent_id: id(7), runner_id: 'owned-runner',
  source_repository: null, source_base_ref: null, source_base_commit: null, ...changes,
})
export function elements(node) {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (!node || typeof node !== 'object' || !node.props) return []
  return [node, ...elements(node.props.children)]
}
export function text(node) {
  if (Array.isArray(node)) return node.map(text).join('')
  return node?.props ? text(node.props.children) : typeof node === 'string' || typeof node === 'number' ? String(node) : ''
}
export function panelHarness({ values = new Map(), storage, props: initialProps = {}, globals: suppliedGlobals = {} } = {}) {
  const cells = [], effects = [], requests = []
  let cursor = 0, sequence = 80
  let props = { corpId: id(1), mission: mission(), task: task(), runs: [],
    recoveryScope: null, recoveryLoad: null, actorId: id(4), actorRole: 'owner', busy: false,
    onRevise: async () => ({ status: 'unknown', message: 'Connection lost' }), ...initialProps,
  }
  const globals = {
    TextEncoder, ...revisionModel, factoryContractRevisionSource,
    require: name => { assert.equal(name, 'react/jsx-runtime'); return jsxRuntime }, exports: {},
    useState(initial) { const i = cursor++; if (!(i in cells)) cells[i] = typeof initial === 'function' ? initial() : initial
      return [cells[i], value => { cells[i] = typeof value === 'function' ? value(cells[i]) : value }] },
    useRef(initial) { const i = cursor++; return cells[i] ??= { current: initial } },
    useEffect(effect, deps) { const i = cursor++; if (!cells[i] || deps.some((v, n) => !Object.is(v, cells[i][n]))) {
      cells[i] = deps; effects.push(effect) } },
    window: { sessionStorage: storage ?? { getItem: key => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value) }, requestAnimationFrame: callback => callback() },
    crypto: { randomUUID: () => id(sequence++) }, API_URL: 'http://owned.invalid',
    terminalRun: status => ['completed', 'failed', 'cancelled', 'lost'].includes(status),
    ContractRevisionEditor: () => null, ...suppliedGlobals,
  }
  for (const name of ['factoryRecoveryScopeKey', 'currentFactoryRecoveryLoad', 'ContractRevisionPanel']) {
    evaluate(appFunction(name).getText(app), globals)
  }
  const render = () => {
    cursor = 0
    const view = globals.ContractRevisionPanel({ ...props, onRevise: (...args) => {
      requests.push(structuredClone(args))
      return props.onRevise(...args)
    } })
    while (effects.length) effects.shift()()
    return view
  }
  const button = label => elements(render()).find(n => n.type === 'button' && text(n).includes(label))
  const edit = (label, value) => {
    const field = elements(render()).find(n => n.type === 'label' && text(n).trim().startsWith(label))
    assert.ok(field, label)
    const input = elements(field).find(n => ['input', 'textarea'].includes(n.type))
    assert.ok(input, label); input.props.onChange({ target: { value } })
  }
  render()
  return { render, button, edit, requests, values, globals,
    replace(changes) { props = { ...props, ...changes } },
    draft() { return elements(render()).find(n => n.type === globals.ContractRevisionEditor)?.props.draft },
    patch(patch) { elements(render()).find(n => n.type === globals.ContractRevisionEditor)?.props.onChange(patch) },
    async submit() {
      const form = elements(render()).find(n => n.type === 'form')
      if (form) await form.props.onSubmit({ preventDefault() {} })
    },
  }
}
export function saveHarness(extra = {}) {
  const requests = [], announcements = [], errors = [], refreshes = []
  class ApiRequestError extends Error { constructor(status, message = 'Request refused') { super(message); this.status = status } }
  const globals = {
    bootstrap: { corp_id: id(1) }, selectedActor: { id: id(4) },
    currentViewer: { current: { corpId: id(1), actorId: id(4) } },
    setBusy() {}, setError: error => errors.push(error), setAnnouncement: value => announcements.push(value),
    api: async (...args) => { requests.push(args); return { revision: {
      id: id(90), version: 9, mission_id: id(2), task_id: id(5),
    }, replayed: false } },
    refresh: async (...args) => { refreshes.push(args) }, ApiRequestError, ...extra,
  }
  const handler = find(app, n => ts.isVariableDeclaration(n) && n.name.getText(app) === 'createContractRevision')
  evaluate('globalThis.save = ' + handler.initializer.getText(app), globals)
  const target = { scopeKey: JSON.stringify(['http://owned.invalid', id(1), id(4), id(3), id(2), id(5)]),
    corpId: id(1), actorId: id(4), roomId: id(3), missionId: id(2), taskId: id(5), version: 2,
    missionVersion: 2, nextAction: 'redispatch', sourceRunId: null, recoveryKey: null }
  const input = { task_id: id(5), expected_contract_version: 2, next_action: 'redispatch',
    source_run_id: null, idempotency_key: id(80), reason: 'Clarify', description: 'Original',
    contract: contract(), verification_policy: policy() }
  return { globals, requests, announcements, errors, refreshes, target, input,
    save: () => globals.save(target, input) }
}
