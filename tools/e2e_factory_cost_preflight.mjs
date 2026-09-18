// Native CLI + actual HTTP server + explicitly owned PostgreSQL. No reset, runner,
// provider, remote GitHub, dependency install, or configured-checkout mutation.
import assert from 'node:assert/strict'
import { execFile as execFileCallback } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const execFile = promisify(execFileCallback)
const root = path.resolve(import.meta.dirname, '..')
const required = (key) => {
  assert.ok(process.env[key], `${key} is required`)
  return process.env[key]
}
assert.equal(required('ECORP_ISSUE79_OWNED_DATABASE'), '1')
const server = required('CRONY_SERVER_HTTP')
assert.equal(new URL(server).hostname, '127.0.0.1')
assert.equal(required('PGHOST'), '127.0.0.1')
const binary = required('CRONY_CLI_BINARY')
const psql = required('ECORP_PSQL_BINARY')
const corp = required('ECORP_TEST_CORP_ID')
const actor = required('ECORP_TEST_ACTOR_ID')
for (const id of [corp, actor]) assert.match(id, /^[0-9a-f-]{36}$/)
const output = path.resolve(root, required('ECORP_TEST_OUTPUT'))
assert.ok(output.startsWith(`${root}${path.sep}`), 'output must stay in this worktree')
await mkdir(output, { recursive: true })
const statePath = path.join(output, 'github.json')
const nonce = randomUUID()
const issue = {
  id: `ISSUE79_${nonce}`, number: 79, title: 'Cost admission canary',
  body: '## Acceptance criteria\n- [ ] Reject incompatible costs without effects',
  url: 'https://github.com/fixture/project/issues/79', state: 'OPEN',
  createdAt: '2026-09-16T00:00:00Z', updatedAt: '2026-09-16T00:00:00Z',
  labels: [{ name: 'factory:ready' }],
}
const itemId = `ITEM79_${nonce}`
const github = {
  repository: 'fixture/project',
  project: { id: `PROJECT79_${nonce}`, number: 7, owner: 'fixture',
    title: 'Owned cost fixture', status_field_id: 'STATUS79',
    status_options: [{ id: 'todo', name: 'Todo' }, { id: 'active', name: 'In Progress' }] },
  items: [{ id: itemId, status: 'Todo', content: {
    type: 'Issue', number: 79, title: issue.title, body: issue.body,
    url: issue.url, repository: 'fixture/project',
  } }],
  issues: { 79: issue },
}
await writeFile(statePath, JSON.stringify(github))

async function sql(query) {
  return (await execFile(psql, ['-X', '-At', '-v', 'ON_ERROR_STOP=1', '-c', query], {
    cwd: root, windowsHide: true, timeout: 30_000,
  })).stdout.trim()
}
async function ledger() {
  return sql(`SELECT jsonb_build_object(
    'items',(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY id),'[]') FROM factory_work_items x WHERE corp_id='${corp}'),
    'operations',(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY idempotency_key),'[]') FROM factory_operations x WHERE corp_id='${corp}'),
    'missions',(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY id),'[]') FROM missions x WHERE corp_id='${corp}'),
    'tasks',(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY id),'[]') FROM tasks x WHERE corp_id='${corp}'),
    'runs',(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY id),'[]') FROM runs x WHERE corp_id='${corp}'),
    'connections',(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY id),'[]') FROM workspace_connections x WHERE corp_id='${corp}'),
    'events',(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY seq),'[]') FROM events x WHERE corp_id='${corp}'))`)
}
async function post(body) {
  const response = await fetch(`${server}/api/corps/${corp}/factory/work-items/claim`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(10_000),
  })
  return { status: response.status, body: await response.json() }
}
async function cli(cost, strategy, dryRun, exact = true, selectors = {}) {
  const args = ['--server', server, 'factory', corp, actor, '--owner', 'fixture',
    '--project-number', '7', '--repository', 'fixture/project', '--source-base-ref', selectors.sourceBaseRef ?? 'main',
    '--source-repository-path', selectors.sourceRepositoryPath ?? output,
    '--adapter', strategy === 'studio-swarm' || selectors.workspaceConnectionId ? 'github-copilot' : 'fake-process',
    '--strategy', strategy, '--budget-tokens', '1000', '--budget-cost-microusd', String(cost),
    '--github-cli', process.execPath]
  if (selectors.workspaceConnectionId) args.push('--workspace-connection-id', selectors.workspaceConnectionId)
  if (dryRun) args.push('--dry-run')
  if (exact) args.push('--issue', '79')
  try {
    return { code: 0, ...await execFile(binary, args, {
      cwd: root, windowsHide: true, timeout: 45_000,
      env: { ...process.env,
        ECORP_GITHUB_CLI_PREFIX_ARGS_JSON: JSON.stringify([path.join(root, 'tools', 'fake_github_cli.mjs')]),
        ECORP_FAKE_GITHUB_STATE: statePath },
    }) }
  } catch (error) {
    return { code: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }
  }
}
const initial = await ledger()
const initialState = JSON.parse(initial)
for (const table of ['items', 'operations', 'missions', 'tasks', 'runs']) {
  assert.equal(initialState[table].length, 0, 'use a new owned fixture Corp')
}
let invalidCliCases = 0
for (const dryRun of [false, true]) {
  for (const [strategy, cost] of [
    ['single', 20_000_000], ['single', 10_000_001], ['single', '9223372036854775807'],
    ['parallel-specialists', 23_333_333], ['parallel-specialists', 2],
    ['studio-swarm', 18_181_817], ['studio-swarm', 3],
  ]) {
    const beforeGithub = await readFile(statePath, 'utf8')
    const result = await cli(cost, strategy, dryRun)
    assert.notEqual(result.code, 0)
    assert.match(result.stderr, /cost budget/)
    assert.equal(await readFile(statePath, 'utf8'), beforeGithub, 'GitHub was touched before rejection')
    assert.ok(await ledger() === initial, 'invalid CLI invocation changed durable state')
    invalidCliCases++
  }
}
const policy = {
  schema_version: 1, source_of_truth: 'github_project', auto_merge: false,
  repository_allowlist: ['fixture/project'], source_base_ref: 'main',
  source_base_commit: 'b'.repeat(40), adapter_allowlist: ['fake-process'],
  strategy_allowlist: ['single'], model: null, reasoning_effort: null,
  write_scope: ['**'], allowed_tools: ['filesystem'],
  prohibited_actions: ['No external effects'], secret_ids: [], verification_required: true,
  budget_tokens: 1000, budget_cost_microusd: 1_000_000,
}
const claim = {
  actor_id: actor, source_project_owner: 'fixture', source_project_number: 7,
  source_project_item_id: itemId, source_repository_owner: 'fixture',
  source_repository_name: 'project', source_issue_number: 79, source_issue_node_id: issue.id,
  source_issue_url: issue.url, source_title: issue.title, source_revision: issue.updatedAt,
  idempotency_key: `issue79-${nonce}`, lease_seconds: 300, policy,
}
let invalidServerCases = 0
for (const [strategy, cost] of [
  ['single', 20_000_000], ['single', 10_000_001],
  ['parallel-specialists', 23_333_333], ['studio-swarm', 18_181_817],
]) {
  const rejected = await post({ ...claim, policy: {
    ...policy, strategy_allowlist: [strategy], budget_cost_microusd: cost,
  } })
  assert.equal(rejected.status, 400)
  assert.ok(await ledger() === initial, 'invalid HTTP claim changed durable state')
  invalidServerCases++
}
// Valid costs still pass local admission; no matching fixture checkout/runner is
// configured. This prevents a reject-everything implementation passing.
for (const cost of [1, 10_000_000]) {
  const result = await cli(cost, 'single', true)
  assert.notEqual(result.code, 0)
  assert.doesNotMatch(result.stderr, /cost budget/)
  assert.ok(JSON.parse(await readFile(statePath, 'utf8')).graphql_calls > 0)
  assert.ok(await ledger() === initial)
}
const connectionA = randomUUID()
const connectionB = randomUUID()
// Owned offline metadata only; no runner or native provider process is started.
await sql(`INSERT INTO runner_nodes (id,corp_id,hostname,os,connection_epoch,status)
  VALUES ('issue79-${nonce}','${corp}','owned-fixture','windows','${randomUUID()}','offline');
  INSERT INTO workspace_connections
    (id,corp_id,room_id,created_by,runner_id,label,agent,configuration,status)
  SELECT fixture.id::uuid,'${corp}',room.id,'${actor}','issue79-${nonce}',
    fixture.label,'github-copilot','{}'::jsonb,'offline'
  FROM (VALUES ('${connectionA}','Original connection'),('${connectionB}','Other connection')) fixture(id,label)
  CROSS JOIN LATERAL (SELECT id FROM rooms WHERE corp_id='${corp}' ORDER BY created_at,id LIMIT 1) room`)
assert.equal(await sql(`SELECT count(*) FROM workspace_connections
  WHERE corp_id='${corp}' AND id IN ('${connectionA}','${connectionB}')`), '2')
const accepted = await post({ ...claim, policy: {
  ...policy, workspace_connection_id: connectionA, adapter_allowlist: ['github-copilot'],
} })
assert.equal(accepted.status, 200)
const workId = accepted.body.work_item.id
assert.match(workId, /^[0-9a-f-]{36}$/)
// Historical fixture only. Product code must never rewrite this policy.
await sql(`UPDATE factory_work_items SET policy=(policy-'source_base_commit') ||
  '{"budget_cost_microusd":20000000,"source_commit_upgrade_required":true}'::jsonb
  WHERE corp_id='${corp}' AND id='${workId}'`)
const legacyBefore = await ledger()
const matchingSelectors = {
  workspaceConnectionId: connectionA, sourceBaseRef: 'main',
  sourceRepositoryPath: path.join(output, 'checkout-must-not-exist'),
}
let legacySelectorDenials = 0
for (const dryRun of [true, false]) {
  for (const [selectors, expectedError] of [
    [{ ...matchingSelectors, workspaceConnectionId: connectionB }, /workspace connection differs/],
    [{ sourceBaseRef: 'main' }, /workspace connection differs/],
    [{ ...matchingSelectors, sourceBaseRef: 'release' }, /source base ref mismatch/],
  ]) {
    const beforeGithub = JSON.parse(await readFile(statePath, 'utf8'))
    const rejected = await cli(1_000_000, 'single', dryRun, true, selectors)
    assert.notEqual(rejected.code, 0)
    assert.match(rejected.stderr, expectedError)
    assert.equal(await ledger(), legacyBefore, 'selector mismatch mutated or pinned the legacy claim')
    const afterGithub = JSON.parse(await readFile(statePath, 'utf8'))
    assert.deepEqual(afterGithub.items, beforeGithub.items)
    assert.deepEqual(afterGithub.effect_log ?? [], beforeGithub.effect_log ?? [])
    assert.equal(afterGithub.item_edits ?? 0, beforeGithub.item_edits ?? 0)
    legacySelectorDenials++
  }
}
const preview = await cli(1_000_000, 'single', true, true, matchingSelectors)
assert.equal(preview.code, 0, preview.stderr)
assert.match(JSON.parse(preview.stdout).legacy_cost_policy_rejection, /10000000/)
assert.ok(await ledger() === legacyBefore, 'legacy preview was not read-only')
const broad = await cli(1_000_000, 'single', true, false, matchingSelectors)
assert.equal(broad.code, 0, broad.stderr)
assert.equal(JSON.parse(broad.stdout).selected, null)
assert.match(JSON.stringify(JSON.parse(broad.stdout).evaluated), /explicit terminal reconciliation/)
assert.ok(await ledger() === legacyBefore)
const reconciled = await cli(1_000_000, 'single', false, true, matchingSelectors)
assert.equal(reconciled.code, 0, reconciled.stderr)
const result = JSON.parse(reconciled.stdout)
assert.equal(result.mode, 'legacy_cost_policy_reconciled')
assert.equal(result.work_item.state, 'failed')
const finalState = JSON.parse(await ledger())
assert.ok(JSON.stringify(finalState.items[0].policy) === JSON.stringify(JSON.parse(legacyBefore).items[0].policy))
for (const table of ['missions', 'tasks', 'runs']) assert.equal(finalState[table].length, 0)
assert.equal(finalState.events.filter((event) => event.type === 'factory.state_changed').length, 1)
const finalGithub = JSON.parse(await readFile(statePath, 'utf8'))
assert.equal(finalGithub.items[0].status, 'Todo')
assert.equal(finalGithub.item_edits ?? 0, 0)
assert.equal((finalGithub.effect_log ?? []).length, 0)
const summary = {
  invalidCliCases, invalidServerCases, validBoundaryCliCases: 2,
  legacySelectorDenials, matchingSelectorsPreserved: true,
  legacyDryRun: true, broadPollingSkips: true, auditedTerminalReconciliation: true,
  projectMutations: 0, missions: 0, tasks: 0, runs: 0,
  nativeCli: binary, server, realPostgres: true, realGithub: false, providerExecution: false,
}
await writeFile(path.join(output, 'result.json'), `${JSON.stringify(summary, null, 2)}\n`)
console.log(JSON.stringify(summary, null, 2))
