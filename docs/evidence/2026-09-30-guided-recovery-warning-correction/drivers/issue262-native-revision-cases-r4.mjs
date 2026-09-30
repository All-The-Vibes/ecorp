import { exerciseSavedWarningCases } from './issue262-native-warning-cases-r1.mjs'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

export async function exerciseRevisionCases(t) {
  const { page, server, demo, api, expect, graph, create, effect, rawRequest, open, exact, show, panel, card, check, capture, browserPost, report, save, wait } = t
  const created = await create('guided pre-dispatch revision'), mid = created.mission_id, tid = created.task_id
  let before = await graph(mid), task = before.tasks.find(item => item.id === tid)
  assert.equal(before.runs.length, 0); assert.equal(task.contract_version, 1)
  let revision = await open(created)
  const saveButton = () => revision.getByRole('button', { name: 'Save revision', exact: true })
  await expect(revision.getByLabel('Revision reason')).toBeFocused()
  await expect(saveButton()).toBeDisabled()
  await expect(revision).toContainText('Contract v1; mission specification v1')
  await expect(revision).toContainText('Pre-execution; no run')
  await expect(revision).toContainText('Editing and saving never dispatch or resume work.')
  await revision.getByLabel('Revision reason').fill('Clarify acceptance using labeled fields; retain every original boundary.')
  await revision.getByLabel('Task objective').fill('')
  await expect(revision.getByLabel('Task objective')).toHaveAttribute('aria-invalid', 'true')
  await expect(saveButton()).toBeDisabled()
  const errorId = await revision.getByLabel('Task objective').getAttribute('aria-describedby')
  assert.ok(errorId); await expect(page.locator('#' + errorId)).toBeVisible()
  await revision.getByLabel('Task objective').fill('Produce result.md and prove its native verifier result.\nKeep Unicode context: résumé 日本語.')
  await revision.getByLabel('Expected output').fill('A preserved result.md with persisted passing native evidence.')
  await revision.getByLabel('When to escalate').fill('Stop when the approved scope cannot be met; retain evidence.')
  await revision.getByLabel('Mission description / specification').fill('A corrected bounded specification, saved separately from execution.')
  // The native planner appends the requested criteria to its bounded defaults.
  // Verify focus against the authoritative created contract, not request counts.
  const criteriaCount = task.contract.acceptance_tests.length
  const referenceCount = task.contract.references.length
  assert.ok(criteriaCount > 0)
  const criterion = number => revision.getByRole('textbox', { name: 'Acceptance criteria ' + number, exact: true })
  const criteriaGroup = revision.getByRole('group', { name: 'Acceptance criteria', exact: true })
  await expect(criteriaGroup.getByRole('textbox')).toHaveCount(criteriaCount)
  await revision.getByRole('button', { name: 'Add acceptance criteria entry', exact: true }).click()
  await expect(criteriaGroup.getByRole('textbox')).toHaveCount(criteriaCount + 1)
  await expect(criterion(criteriaCount + 1)).toBeFocused()
  await criterion(criteriaCount + 1).fill('The revision is saved once across reconnect.')
  await revision.getByRole('button', { name: 'Remove acceptance criteria ' + (criteriaCount + 1), exact: true }).click()
  await expect(criteriaGroup.getByRole('textbox')).toHaveCount(criteriaCount)
  await expect(criterion(criteriaCount)).toBeFocused()
  await revision.getByRole('button', { name: 'Add references entry', exact: true }).click()
  const addedReference = revision.getByRole('textbox', { name: 'References ' + (referenceCount + 1), exact: true })
  await expect(addedReference).toBeFocused()
  await addedReference.fill('approved-context://keyboard-and-reconnect')
  let editors = await exact(revision)
  const guided = JSON.parse(await editors.contract.inputValue())
  for (const key of ['source_repository', 'source_base_ref', 'source_base_commit', 'budget_tokens', 'budget_cost_microusd', 'deadline_at', 'secret_refs', 'model', 'reasoning_effort', 'deliverable']) {
    assert.deepEqual(guided[key], task.contract[key], 'Guided edits preserve ' + key)
  }
  assert.equal(Object.hasOwn(guided, 'workspace_connection_id'), Object.hasOwn(task.contract, 'workspace_connection_id'))
  // Draft-only representability uses synthetic IDs. It does not authorize a
  // connection, grant a secret, or issue a server request with these values.
  const allFields = { ...guided, workspace_connection_id: randomUUID(), deadline_at: '2030-01-02T03:04:05Z',
    source_base_ref: 'feature/résumé]', secret_refs: [{ secret_id: randomUUID(), env_name: 'ISSUE262_REFERENCE_ONLY', tool: 'shell', resource: 'fixture://bounded' }],
    model: 'gpt-5.4', reasoning_effort: 'medium', deliverable: { form: 'archive', paths: ['résumé.txt', 'folder/proof.json'], commit_after_verification: false } }
  await editors.contract.fill(JSON.stringify(allFields, null, 2))
  await revision.getByLabel('Task objective').fill('Roundtrip every supported exact field without a submission.')
  const roundtrip = JSON.parse(await editors.contract.inputValue())
  assert.deepEqual({ ...roundtrip, objective: allFields.objective }, allFields)
  check('browser_exact_all_supported_fields_roundtrip_draft_only', { fields: Object.keys(roundtrip).sort(), synthetic_reference_ids_only: true, submitted: false })
  await editors.contract.fill('{broken')
  await expect(saveButton()).toBeDisabled()
  await expect(revision).toContainText('Correct the task contract in the advanced JSON editor')
  await expect(editors.contract).toHaveAttribute('aria-invalid', 'true')
  await editors.contract.fill(JSON.stringify(guided, null, 2))
  await revision.getByRole('button', { name: 'Add check', exact: true }).click()
  await revision.getByLabel('Verifier check 2 type', { exact: true }).selectOption('file')
  await revision.getByLabel('Worktree-relative path').fill('result.md')
  await revision.getByLabel('Minimum bytes', { exact: true }).fill('50')
  const policy = JSON.parse(await editors.policy.inputValue())
  assert.deepEqual(policy, { checks: [{ type: 'artifact', min_bytes: 1 }, { type: 'file', path: 'result.md', min_bytes: 50 }], manual_gate: null })
  await expect(saveButton()).toBeEnabled()
  await expect(revision.locator('.contract-change-summary')).toContainText('Before and after')
  await expect(revision.locator('.contract-change-summary')).toContainText('Verification policy')
  await capture('guided-desktop-before-after')
  check('guided_fields_errors_focus_lists_and_existing_verifier_editor', { desktop: 1440, reduced_motion: await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches), before_after: true })

  await page.setViewportSize({ width: 390, height: 844 })
  await revision.getByLabel('Revision reason').focus(); await page.keyboard.press('Tab')
  await expect(revision.getByLabel('Mission description / specification')).toBeFocused()
  const bounds = await revision.evaluate(element => ({ width: element.getBoundingClientRect().width, scroll: element.scrollWidth, client: element.clientWidth,
    viewport: document.documentElement.clientWidth, document: document.documentElement.scrollWidth }))
  assert.ok(bounds.document <= bounds.viewport + 1 && bounds.scroll <= bounds.client + 1, JSON.stringify(bounds))
  await capture('guided-mobile-390-keyboard')
  await revision.getByRole('button', { name: 'Keep draft and close', exact: true }).click()
  await expect(revision.getByRole('button', { name: 'Continue revision draft', exact: true })).toBeFocused()
  await revision.getByRole('button', { name: 'Continue revision draft', exact: true }).click()
  await expect(revision.getByLabel('Revision reason')).toBeFocused()
  check('mobile_390_keyboard_close_reopen_preserves_draft', bounds)
  await page.setViewportSize({ width: 1440, height: 1050 })

  const aliceDraft = await (await exact(revision)).contract.inputValue()
  const revisionRoute = api(`/missions/${mid}/contract-revisions`)
  const denialInput = { actor_id: demo.bob_actor_id, task_id: tid, expected_contract_version: 1, next_action: 'redispatch', source_run_id: null,
    reason: 'Verify role admission in the owned development fixture.', idempotency_key: randomUUID(), description: before.mission.description,
    contract: task.contract, verification_policy: task.verification_policy }
  const memberDenied = await rawRequest(revisionRoute, denialInput)
  assert.equal(memberDenied.status, 403)
  const outsiderDenied = await rawRequest(revisionRoute, { ...denialInput, actor_id: demo.eve_actor_id, idempotency_key: randomUUID() })
  assert.equal(outsiderDenied.status, 403)
  const foreignCorpDenied = await rawRequest(`/api/corps/${randomUUID()}/missions/${mid}/contract-revisions`, { ...denialInput, actor_id: demo.alice_actor_id, idempotency_key: randomUUID() })
  assert.ok([403, 404].includes(foreignCorpDenied.status))
  await page.locator('#operator-actor').selectOption(demo.bob_actor_id)
  await show(mid, tid); await expect(panel(tid)).toHaveCount(0)
  await page.locator('#operator-actor').selectOption(demo.alice_actor_id)
  revision = await open(created)
  assert.equal(await (await exact(revision)).contract.inputValue(), aliceDraft)
  assert.equal((await graph(mid)).revisions.length, 0)
  check('native_member_outsider_and_corp_denials_preserve_actor_draft', { member: memberDenied.status, outsider: outsiderDenied.status, corp: foreignCorpDenied.status, revisions: 0 })

  let lostResponse = null, submitted = null, intercepted = 0
  const lostOperation = t.intent('save-with-real-response-loss', revisionRoute)
  await page.route(server + revisionRoute, async route => {
    assert.equal(++intercepted, 1, 'Exactly one original save before replay')
    submitted = route.request().postDataJSON()
    const response = await route.fetch()
    lostResponse = { status: response.status(), body: await response.json() }
    lostOperation.request_body = submitted; lostOperation.response = lostResponse; lostOperation.completed = true; save()
    await route.abort('failed')
  })
  // The durable pending notice is visible during submission too. Synchronize
  // with the deliberate network failure before inspecting the committed receipt.
  const requestLost = page.waitForEvent('requestfailed', request =>
    request.url() === server + revisionRoute && request.method() === 'POST')
  await saveButton().click()
  await requestLost
  await expect(revision).toContainText('Save outcome unconfirmed')
  await expect(revision.getByRole('button', { name: 'Retry exact request', exact: true })).toBeEnabled()
  assert.ok(lostResponse, 'The response-loss handler captured the native save receipt')
  assert.equal(lostResponse.status, 200); assert.equal(lostResponse.body.replayed, false)
  assert.equal(lostResponse.body.revision.version, 2)
  await expect(revision.getByLabel('Revision reason')).toBeDisabled()
  await page.unroute(server + revisionRoute)
  const afterLost = await graph(mid)
  assert.equal(afterLost.revisions.length, 1); assert.equal(afterLost.runs.length, 0)
  await capture('real-server-commit-response-lost')
  await page.reload({ waitUntil: 'networkidle' })
  await expect(page.locator('.live-live')).toBeVisible({ timeout: 25000 })
  revision = await open(created)
  await expect(revision).toContainText('Save outcome unconfirmed')
  await expect(revision.getByLabel('Task objective')).toBeDisabled()
  const replay = await browserPost('retry-after-reconnect', revisionRoute, revision.getByRole('button', { name: 'Retry exact request', exact: true }))
  const replayOperation = report.operations.find(operation => operation.name === 'retry-after-reconnect')
  assert.deepEqual(replayOperation.request_body, submitted)
  assert.equal(replay.replayed, true); assert.equal(replay.revision.id, lostResponse.body.revision.id)
  await expect(revision).toContainText('Saved revision v2 (confirmed by exact replay)')
  assert.equal((await graph(mid)).revisions.length, 1); assert.equal((await graph(mid)).runs.length, 0)
  await capture('exact-retry-confirmed-after-reconnect')
  check('native_response_loss_reload_exact_replay_single_revision_no_execution', { revision_id: replay.revision.id, version: 2, same_body_and_key: true, requests: 2, revisions: 1, runs: 0 })

  revision = await exerciseSavedWarningCases(t, created, revisionRoute)

  await revision.getByRole('button', { name: 'Start another revision', exact: true }).click()
  await revision.getByLabel('Revision reason').fill('Preserve this local edit across a concurrent revision.')
  await revision.getByLabel('Expected output').fill('The local draft survives the changed authoritative baseline.')
  const staleDraft = JSON.parse(await (await exact(revision)).contract.inputValue())
  const current = await graph(mid), currentTask = current.tasks.find(item => item.id === tid)
  const concurrentBody = { actor_id: demo.alice_actor_id, task_id: tid, expected_contract_version: 2, next_action: 'redispatch', source_run_id: null,
    reason: 'Owned second-client revision to exercise a real stale baseline.', idempotency_key: randomUUID(), description: current.mission.description,
    contract: { ...currentTask.contract, expected_output: 'Other client changed the expected output.' }, verification_policy: currentTask.verification_policy }
  const concurrent = await effect('concurrent-server-revision', revisionRoute, concurrentBody)
  assert.equal(concurrent.revision.version, 3)
  await expect(revision).toContainText('This draft is stale')
  await expect(saveButton()).toBeDisabled()
  assert.deepEqual(JSON.parse(await (await exact(revision)).contract.inputValue()), staleDraft)
  const staleRefused = await rawRequest(revisionRoute, { ...concurrentBody, idempotency_key: randomUUID(), reason: 'Deliberate stale-version admission probe.' })
  assert.equal(staleRefused.status, 400)
  await capture('real-stale-version-preserved')
  await revision.getByRole('button', { name: 'Use current baseline, keep edits', exact: true }).click()
  await expect(revision).toContainText('Contract v3; mission specification v3')
  await expect(revision.getByLabel('Revision reason')).toHaveValue('Preserve this local edit across a concurrent revision.')
  assert.deepEqual(JSON.parse(await (await exact(revision)).contract.inputValue()), staleDraft)
  const reconciled = await browserPost('save-explicitly-reconciled-draft', revisionRoute, saveButton())
  assert.equal(reconciled.revision.version, 4)
  await expect(revision).toContainText('Saved revision v4')
  const ready = await graph(mid)
  assert.equal(ready.runs.length, 0); assert.equal(ready.revisions.length, 3)
  check('native_stale_version_denial_and_explicit_reconciliation', { conflict_status: staleRefused.status, retained_draft: true, version: 4, revisions: 3, runs: 0 })
  await browserPost('explicit-launch-after-save', api(`/missions/${mid}/launch`), card(mid).getByRole('button', { name: 'Start mission', exact: true }))
  const completed = await wait(async () => {
    const result = await graph(mid)
    return result.runs.length === 1 && result.runs[0].status === 'completed' && result.runs[0].verification_status === 'passed' && result
  }, 'pre-dispatch revised contract completes through native runner')
  const run = completed.runs[0], evidence = completed.state.snapshot.verification_evidence.filter(item => item.run_id === run.id)
  assert.deepEqual(evidence.map(item => item.kind).sort(), ['artifact', 'file'])
  assert.ok(evidence.every(item => item.status === 'passed'))
  assert.equal(completed.tasks[0].contract_version, 4)
  await capture('revised-mission-native-verification')
  check('browser_explicit_launch_native_contract_v4_verified', { mission_id: mid, task_id: tid, run_id: run.id, verification_status: run.verification_status, evidence: evidence.map(({ id, kind, status }) => ({ id, kind, status })) })
  report.redispatch = { created, final: completed }; save()
}
