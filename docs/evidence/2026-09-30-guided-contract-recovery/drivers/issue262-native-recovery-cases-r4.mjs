import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

const terminal = run => ['completed', 'failed', 'cancelled', 'lost'].includes(run.status)

export async function exerciseRecoveryCases(t) {
  const { page, demo, api, expect, graph, contract, create, rawRequest, open, exact, show, card,
    check, capture, browserPost, report, save, wait } = t
  const created = await create('native provider recovery', {
    preferred_adapter: 'codex', title: '[fail] Issue262 retained native provider session',
    description: 'Fail the first synthetic native turn and retain its isolated worktree.',
    contract: { ...contract('Produce a bounded output through the native Codex adapter.'),
      write_scope: ['base.txt', 'resumed.txt', 'resume-prompt.txt'] },
  })
  const mid = created.mission_id, tid = created.task_id
  await show(mid, tid)
  await browserPost('launch-native-resume-source', api(`/missions/${mid}/launch`), card(mid).getByRole('button', { name: 'Start mission', exact: true }))
  const failed = await wait(async () => {
    const result = await graph(mid)
    // A failed first attempt may already be terminal while the scheduler is
    // about to dispatch its allowed retry. Require the authoritative final task.
    return result.mission.status === 'failed' && result.tasks.find(item => item.id === tid)?.status === 'failed'
      && result.runs.length && result.runs.every(run => terminal(run) && ['preserved', 'removed'].includes(run.workspace_disposition))
      && result.runs.some(run => run.task_id === tid && run.status === 'failed' && run.provider_session_id && run.workspace_disposition === 'preserved') && result
  }, 'native failed Codex session and preserved workspace', 90000)
  const sourceRun = failed.runs.find(run => run.task_id === tid && run.status === 'failed' && run.provider_session_id && run.workspace_disposition === 'preserved')
  const task = failed.tasks.find(item => item.id === tid)
  report.recovery_source = { mission_id: mid, task_id: tid, source_run_id: sourceRun.id, task_status: task.status, attempt_count: task.attempt_count, max_attempts: task.max_attempts }; save()
  await show(mid, tid)
  await page.locator(`#mission-evidence-${mid}`).selectOption(sourceRun.id)
  const revision = await open(created, 'resume'), editors = await exact(revision)
  const saveButton = revision.getByRole('button', { name: 'Save revision', exact: true })
  await expect(revision).toHaveAttribute('data-source-run-id', sourceRun.id)
  await expect(revision).toContainText(`Contract v${task.contract_version}`)
  await revision.getByLabel('Revision reason').fill('Narrow the retained provider session to the exact remaining work and correct its verifier.')
  await expect(revision).toContainText('separate Resume control')
  const baselineContract = JSON.parse(await editors.contract.inputValue())
  const route = api(`/missions/${mid}/contract-revisions`)
  const baselineBody = { actor_id: demo.alice_actor_id, task_id: tid, expected_contract_version: task.contract_version,
    next_action: 'resume', source_run_id: sourceRun.id, reason: 'Owned authority regression probe; must be refused.',
    description: failed.mission.description, contract: task.contract, verification_policy: task.verification_policy }
  const probes = [
    ['tools', { allowed_tools: [...task.contract.allowed_tools, 'unbounded-network'] }, 'Resume cannot add tools.'],
    ['write-scope', { write_scope: [...task.contract.write_scope, 'outside-approved-scope.txt'] }, 'Resume can only retain or narrow the existing write scope.'],
    ['prohibition', { prohibited_actions: task.contract.prohibited_actions.slice(1) }, 'Resume must retain every existing prohibition.'],
    ['source', { source_base_ref: 'unapproved-source-ref' }, 'Resume must retain the original source base ref.'],
    ['workspace-connection', { workspace_connection_id: randomUUID() }, 'Resume must retain the original workspace connection id.'],
    ['budget', { budget_tokens: task.contract.budget_tokens + 1 }, 'Resume must retain the original budget tokens.'],
  ]
  const denials = []
  for (const [name, patch, message] of probes) {
    await editors.contract.fill(JSON.stringify({ ...baselineContract, ...patch }, null, 2))
    await expect(saveButton).toBeDisabled()
    await expect(revision).toContainText(message)
    const body = { ...baselineBody, idempotency_key: randomUUID(), contract: { ...task.contract, ...patch } }
    const operation = t.intent('native-authority-denial-' + name, route, body)
    const result = await rawRequest(route, body)
    operation.response = result; operation.completed = true; save()
    assert.equal(result.status, 400, `${name} widening must fail natively`)
    denials.push({ name, status: result.status })
  }
  const unchanged = await graph(mid)
  assert.equal(unchanged.revisions.length, 0)
  assert.deepEqual(unchanged.runs.map(run => run.id).sort(), failed.runs.map(run => run.id).sort())
  assert.deepEqual(unchanged.tasks.find(item => item.id === tid).contract, task.contract)
  await capture('native-resume-authority-errors')
  check('native_and_guided_resume_authority_denials', { source_run_id: sourceRun.id, denials, new_revisions: 0, new_runs: 0 })

  const replacement = { ...baselineContract,
    objective: 'Resume only to produce resumed.txt and validate the corrected bounded prompt.',
    expected_output: 'A verified resumed.txt in the same preserved provider workspace.',
    allowed_tools: ['filesystem'],
    write_scope: ['resumed.txt', 'resume-prompt.txt'],
    prohibited_actions: [...baselineContract.prohibited_actions, 'perform work outside the two remaining recovery outputs'],
    acceptance_tests: [...baselineContract.acceptance_tests, 'The native resume retains session and workspace and persists file and test evidence.'],
  }
  const policy = { checks: [
    { type: 'file', path: 'resumed.txt', min_bytes: 8 },
    { type: 'test', program: 'node', args: ['-e', "const fs=require('fs');const p=fs.readFileSync('resume-prompt.txt','utf8');process.exit(p.includes('Resume only the bounded remaining work')&&p.includes('Resume only to produce resumed.txt')?0:1)"], timeout_ms: 5000 },
  ], manual_gate: null }
  await editors.contract.fill(JSON.stringify(replacement, null, 2))
  await editors.policy.fill(JSON.stringify(policy, null, 2))
  await revision.getByLabel('Mission description / specification').fill('Resume only the bounded remaining work in the preserved provider session.')
  await expect(saveButton).toBeEnabled()
  await capture('native-resume-before-after')
  const saved = await browserPost('save-native-resume-revision', route, saveButton)
  await expect(revision).toContainText(`Saved revision v${saved.revision.version}`)
  await expect(revision).toContainText('No work was started.')
  const afterSave = await graph(mid)
  assert.equal(afterSave.runs.length, failed.runs.length)
  assert.equal(afterSave.revisions.length, 1)
  check('native_resume_revision_saved_without_execution', { source_run_id: sourceRun.id, revision_id: saved.revision.id, runs_before: failed.runs.length, runs_after: afterSave.runs.length })
  const resumed = await browserPost('explicit-native-resume-after-save', api(`/runs/${sourceRun.id}/resume`), card(mid).getByRole('button', { name: 'Resume agent session', exact: true }))
  const completed = await wait(async () => {
    const result = await graph(mid)
    return result.runs.some(run => run.id === resumed.run_id && run.status === 'completed' && run.verification_status === 'passed') && result
  }, 'corrected revision verified through native resume', 90000)
  const resumedRun = completed.runs.find(run => run.id === resumed.run_id)
  const evidence = completed.state.snapshot.verification_evidence.filter(item => item.run_id === resumed.run_id)
  assert.equal(resumedRun.resumed_from_run_id, sourceRun.id)
  assert.equal(resumedRun.provider_session_id, sourceRun.provider_session_id)
  assert.equal(resumedRun.workspace_path, sourceRun.workspace_path)
  assert.equal(completed.tasks.find(item => item.id === tid).contract_version, 2)
  assert.deepEqual(evidence.map(item => item.kind).sort(), ['file', 'test'])
  assert.ok(evidence.every(item => item.status === 'passed'))
  await capture('native-resume-file-and-test-evidence')
  check('browser_native_codex_resume_preserved_session_workspace_and_verifier', { mission_id: mid, source_run_id: sourceRun.id, resumed_run_id: resumedRun.id,
    same_session: true, same_worktree: true, evidence: evidence.map(({ id, kind, status }) => ({ id, kind, status })) })
  report.resume = { created, source: failed, saved_revision: saved, final: completed }; save()

  const budgetCreated = await create('native budget restriction', { preferred_adapter: 'codex', title: '[budget-stream] Issue262 bounded recovery restriction',
    // The existing native fixture emits two 3,000-token usage frames. At 6,000
    // authorized tokens this reaches suspend (100%), not irreversible stop (110%).
    budget_tokens: 6000, contract: contract('Preserve outputs at the configured budget boundary.') })
  const budgetMid = budgetCreated.mission_id, budgetTid = budgetCreated.task_id
  await show(budgetMid, budgetTid)
  await browserPost('launch-native-budget-source', api(`/missions/${budgetMid}/launch`), card(budgetMid).getByRole('button', { name: 'Start mission', exact: true }))
  const exhausted = await wait(async () => {
    const result = await graph(budgetMid)
    return result.runs.length && result.runs.every(terminal) && result.runs.some(run => run.provider_session_id && run.workspace_disposition === 'preserved')
      && result.runs.reduce((sum, run) => sum + run.input_tokens + run.output_tokens, 0) >= result.mission.budget_tokens && result
  }, 'native recorded budget exhaustion with retained session', 90000)
  const budgetRun = exhausted.runs.find(run => run.provider_session_id && run.workspace_disposition === 'preserved')
  report.budget_source = { created: budgetCreated, exhausted }; save()
  assert.equal(exhausted.mission.budget_tokens, 6000)
  assert.equal(budgetRun.input_tokens + budgetRun.output_tokens, 6000)
  assert.equal(budgetRun.breaker_stage, 'suspend', 'This fixture must exercise exhausted-budget suspension without a stop')
  assert.equal(budgetRun.budget_tokens_limit, 6000)
  await show(budgetMid, budgetTid)
  await page.locator(`#mission-evidence-${budgetMid}`).selectOption(budgetRun.id)
  const budgetRevision = await open(budgetCreated, 'resume')
  await expect(budgetRevision).toContainText('Budget is exhausted. Saving a revision cannot restore execution authority.')
  await expect(card(budgetMid).getByRole('button', { name: 'Budget revision required', exact: true })).toBeDisabled()
  await expect(card(budgetMid).getByTestId('budget-resume-guidance')).toContainText('no authorized budget remaining')
  await budgetRevision.getByLabel('Revision reason').fill('Clarify remaining work without changing any authorized budget.')
  await budgetRevision.getByLabel('Expected output').fill('Preserve the current checkpoint until the separate existing budget recovery is authorized.')
  const budgetSaved = await browserPost('save-revision-with-budget-exhausted', api(`/missions/${budgetMid}/contract-revisions`), budgetRevision.getByRole('button', { name: 'Save revision', exact: true }))
  await expect(budgetRevision).toContainText('resolve the budget restriction in the existing budget recovery controls')
  await expect(card(budgetMid).getByRole('button', { name: 'Budget revision required', exact: true })).toBeDisabled()
  const restricted = await graph(budgetMid)
  assert.equal(restricted.mission.budget_tokens, exhausted.mission.budget_tokens)
  assert.equal(restricted.mission.budget_cost_microusd, exhausted.mission.budget_cost_microusd)
  assert.equal(restricted.runs.length, exhausted.runs.length)
  await capture('native-no-budget-revision-cannot-authorize-resume')
  check('native_no_budget_guidance_save_preserves_restriction', { mission_id: budgetMid, source_run_id: budgetRun.id,
    revision_id: budgetSaved.revision.id, budget_tokens: restricted.mission.budget_tokens, runs_before: exhausted.runs.length, runs_after: restricted.runs.length })
  report.budget = { created: budgetCreated, exhausted, after_revision: restricted }; save()
  await exerciseSyntheticGuidance(t, failed, created, sourceRun)
}

async function exerciseSyntheticGuidance(t, nativeFailed, created, sourceRun) {
  const { browser, web, server, demo, report, save, check, expect, snapshot, hash, qa, showOn } = t
  const nativeBefore = await snapshot()
  const stableNative = state => hash(JSON.stringify({ tasks: state.snapshot.tasks, missions: state.snapshot.missions,
    runs: state.snapshot.runs, revisions: state.snapshot.mission_contract_revisions, actors: state.snapshot.actors }))
  const nativeDigest = stableNative(nativeBefore), mid = created.mission_id, tid = created.task_id
  const syntheticCases = []
  for (const name of ['stop', 'quarantine', 'factory-handoff', 'factory-error', 'factory-missing-source', 'factory-stale', 'factory-quarantine']) {
    // These are display variants only. They never alter PostgreSQL or call a
    // controller. All API effects, including bootstrap, are intercepted below.
    const data = structuredClone(nativeFailed.state)
    const row = data.snapshot.runs.find(run => run.id === sourceRun.id)
    if (name === 'stop') row.breaker_stage = 'stop'
    if (name === 'quarantine' || name === 'factory-quarantine') row.workspace_disposition = 'quarantined'
    const item = { id: randomUUID(), corp_id: demo.corp_id, source_project_owner: 'owned-fixture', source_project_number: 1,
      source_project_item_id: 'display-only', source_repository_owner: 'owned-fixture', source_repository_name: 'no-effects',
      source_issue_number: 262, source_issue_url: 'https://example.invalid/display-only/262', source_title: 'Synthetic controller context',
      source_revision: 'browser-only', state: 'verification_failed', version: 1, claim_owner_id: demo.alice_actor_id,
      lease_expires_at: '2030-01-01T00:00:00Z', policy: { source_base_ref: sourceRun.source_base_ref ?? 'HEAD' }, mission_id: mid, failure_detail: 'Synthetic display variant only.' }
    const isFactory = name.startsWith('factory-')
    if (isFactory) data.snapshot.factory_work_items = [...data.snapshot.factory_work_items, item]
    const recovery = { work_item: item, mission_id: mid, task_id: tid, source_run_id: sourceRun.id,
      workspace_fingerprint: sourceRun.workspace_fingerprint, expected_head_commit: sourceRun.source_base_commit,
      remaining_attempts: 2, remaining_mission_tokens: 1000, remaining_mission_cost_microusd: 1000, recoveries: [] }
    if (name === 'factory-missing-source') recovery.source_run_id = ''
    if (name === 'factory-stale') recovery.work_item = { ...item, version: 2 }
    const ctx = await browser.newContext({ viewport: { width: name === 'factory-handoff' ? 390 : 1440, height: 1050 }, reducedMotion: 'reduce', serviceWorkers: 'block' })
    const blocked = [], errors = [], served = []
    await ctx.routeWebSocket('**/*', socket => {
      if (socket.url().startsWith(server.replace(/^http/, 'ws') + '/ws/corps/')) socket.send(JSON.stringify({ type: 'ready', replayed_through: 0 }))
      else socket.close({ code: 1008, reason: 'Display fixture only' })
    })
    await ctx.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url())
      if (url.origin === web && ['GET', 'HEAD'].includes(request.method())) return route.continue()
      if (url.origin !== server) return route.abort('blockedbyclient')
      if (url.pathname === '/api/demo/bootstrap' && url.search === '?seed_crew=false' && request.method() === 'POST' && request.postData() === '{}') {
        served.push('synthetic-bootstrap'); return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(demo) })
      }
      if (['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
        if (url.pathname === `/api/corps/${demo.corp_id}/snapshot`) {
          served.push('synthetic-snapshot'); return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) })
        }
        if (url.pathname === `/api/corps/${demo.corp_id}/factory/work-items/${item.id}/verification-recoveries`) {
          served.push('synthetic-recovery-context')
          return route.fulfill({ status: name === 'factory-error' ? 503 : 200, contentType: 'application/json',
            body: JSON.stringify(name === 'factory-error' ? { error: 'Synthetic unavailable controller context.' } : recovery) })
        }
        return route.continue() // Other read-only product lookups use the owned server.
      }
      blocked.push({ method: request.method(), path: url.pathname }); return route.abort('blockedbyclient')
    })
    const p = await ctx.newPage(); p.on('pageerror', error => errors.push(error.message))
    try {
      await p.goto(web + '/#missions', { waitUntil: 'networkidle' })
      await showOn(p, mid, tid)
      const c = p.locator('[data-mission-id="' + mid + '"]')
      const revision = p.getByTestId(`contract-revision-${tid}`)
      if (name === 'stop') {
        await expect(revision).toHaveCount(0)
        await expect(c.getByRole('button', { name: 'Stop-stage run cannot resume', exact: true })).toBeDisabled()
        await expect(c.getByTestId('budget-resume-guidance')).toContainText('Start a new bounded mission')
      } else if (name === 'quarantine') {
        await expect(revision).toHaveCount(0)
        await expect(c.getByRole('button', { name: 'Resume agent session', exact: true })).toHaveCount(0)
      } else if (name === 'factory-handoff') {
        await revision.getByRole('button', { name: 'Revise contract for source correction', exact: true }).click()
        await revision.getByLabel('Revision reason').fill('Display-only review of the trusted-controller handoff; never submitted.')
        await expect(revision).toHaveAttribute('data-source-run-id', sourceRun.id)
        await expect(revision).toContainText('source-correction handoff in Recovery details below')
        await expect(c.getByRole('button', { name: 'Resume agent session', exact: true })).toHaveCount(0)
        const guidance = c.getByTestId('factory-verification-recovery')
        await expect(guidance).toContainText('Copying is not granting and executes nothing.')
        await expect(guidance.getByRole('button', { name: 'Copy source-correction command', exact: true })).toBeEnabled()
        const beforePolicy = JSON.parse(await revision.getByLabel('Typed verifier policy · JSON').inputValue())
        const exactDetails = revision.locator('.contract-exact-editor')
        if (!(await exactDetails.evaluate(element => element.open))) await exactDetails.locator('summary').click()
        await revision.getByLabel('Revision reason').fill('Display-only attempt to remove Factory verification; never submitted.')
        await revision.getByLabel('Typed verifier policy · JSON').fill(JSON.stringify({ ...beforePolicy, checks: [] }))
        await expect(revision.getByRole('button', { name: 'Save revision', exact: true })).toBeDisabled()
        const extent = await p.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }))
        assert.ok(extent.scroll <= extent.width + 1, JSON.stringify(extent))
      } else if (name === 'factory-quarantine') {
        const guidance = c.getByTestId('factory-verification-recovery')
        await expect(guidance).toContainText('Quarantine warning')
        await expect(guidance.getByRole('button', { name: 'Copy source-correction command', exact: true })).toHaveCount(0)
        await expect(c.getByRole('button', { name: 'Resume agent session', exact: true })).toHaveCount(0)
      } else {
        const notice = p.getByTestId(`contract-revision-source-${tid}`)
        await expect(notice).toContainText('Recovery source unavailable.')
        await expect(revision).toHaveCount(0)
        await expect(c.getByRole('button', { name: 'Resume agent session', exact: true })).toHaveCount(0)
        await expect(c.getByRole('button', { name: 'Refresh recovery context', exact: true })).toBeEnabled()
      }
      assert.deepEqual(errors, [])
      assert.deepEqual(blocked, [], 'No unauthorized effect attempted in a display-only fixture')
      const file = `synthetic-guidance-${name}-${randomUUID().slice(0, 8)}.png`
      await p.screenshot({ path: join(qa, 'evidence', file), fullPage: true })
      report.screenshots['synthetic-' + name] = file
      syntheticCases.push({ name, browser_only: true, native_execution: false, intercepted_api_mutations: 0,
        synthetic_gets: served, viewport: p.viewportSize(), screenshot: file })
      save()
    } finally { await ctx.close() }
  }
  assert.equal(stableNative(await snapshot()), nativeDigest, 'Display fixtures must not change native task, mission, run, revision or actor state')
  check('synthetic_browser_recovery_restrictions_and_controller_handoff', { cases: syntheticCases, native_state_unchanged: true, native_controller_execution: false })
}
