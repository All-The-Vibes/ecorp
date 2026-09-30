import assert from 'node:assert/strict'

// Mutate only this owned browser draft. The saved receipt and pending request
// below come from a real server save and exact replay in the same fresh stack.
export async function exerciseSavedWarningCases(t, created, revisionRoute) {
  const { page, server, demo, expect, graph, show, panel, open, capture, check } = t
  const mid = created.mission_id, tid = created.task_id
  const saved = await page.evaluate(({ mid, tid, actorId }) => {
    const entries = Object.keys(sessionStorage)
      .filter(key => key.startsWith('ecorp:contract-revision:'))
      .map(key => ({ key, serialized: sessionStorage.getItem(key) }))
      .filter(entry => {
        const draft = JSON.parse(entry.serialized)
        return draft.target.missionId === mid && draft.target.taskId === tid && draft.target.actorId === actorId
      })
    if (entries.length !== 1) throw new Error('Exactly one owned saved draft is required')
    return entries[0]
  }, { mid, tid, actorId: demo.alice_actor_id })
  const original = JSON.parse(saved.serialized)
  const before = await graph(mid)
  assert.equal(original.result.status, 'saved')
  assert.equal(original.result.id, before.revisions[0].id)
  assert.equal(original.result.version, 2)
  assert.equal(before.revisions.length, 1)
  assert.equal(before.runs.length, 0)
  let revisionRequests = 0
  const onRequest = request => {
    if (request.method() === 'POST' && request.url() === server + revisionRoute) revisionRequests++
  }
  page.on('request', onRequest)
  const invalid = [
    { name: 'object', value: { detail: 'Malformed warning' } },
    { name: 'array-of-object', value: [{ detail: 'Malformed warning' }] },
    { name: 'array-of-string', value: ['Snapshot unavailable'] },
    { name: 'empty-array', value: [] },
    { name: 'empty-object', value: {} },
    { name: 'null', value: null },
    { name: 'boolean-true', value: true },
    { name: 'boolean-false', value: false },
    { name: 'number', value: 7 },
    { name: 'zero', value: 0 },
  ]
  try {
    for (const entry of invalid) {
      const corrupted = structuredClone(original)
      corrupted.result.refreshWarning = entry.value
      const serialized = JSON.stringify(corrupted)
      await page.evaluate(({ key, serialized }) => sessionStorage.setItem(key, serialized), { key: saved.key, serialized })
      await page.reload({ waitUntil: 'networkidle' })
      await expect(page.locator('.live-live')).toBeVisible({ timeout: 25000 })
      await show(mid, tid)
      const blocked = panel(tid)
      await expect(blocked).toContainText('Stored save result cannot be verified.')
      await expect(blocked.getByRole('alert')).toContainText('No request was sent.')
      await expect(blocked.getByRole('button', { name: 'Revise contract for redispatch', exact: true })).toBeDisabled()
      await expect(blocked.getByRole('button', { name: 'Retry exact request', exact: true })).toHaveCount(0)
      await expect(blocked.locator('.contract-revision-result')).toHaveCount(0)
      assert.equal(await page.evaluate(key => sessionStorage.getItem(key), saved.key), serialized, entry.name + ' retains the malformed storage bytes')
      if (entry.name === 'object') await capture('malformed-saved-warning-blocked-without-request')
    }
    const afterInvalid = await graph(mid)
    assert.deepEqual(afterInvalid.revisions, before.revisions)
    assert.equal(afterInvalid.runs.length, 0)
    assert.equal(revisionRequests, 0)
    check('native_saved_receipt_malformed_warning_reload_fails_closed', {
      saved_receipt_from_native_server: true, local_storage_corruption_only: true,
      values: invalid.map(entry => entry.name), revision_requests: revisionRequests,
      revisions: afterInvalid.revisions.length, runs: 0, storage_bytes_preserved: true,
    })

    for (const entry of [
      { name: 'absent' }, { name: 'empty-string', value: '' },
      { name: 'text', value: 'Snapshot unavailable after save' },
    ]) {
      const valid = structuredClone(original)
      if (Object.hasOwn(entry, 'value')) valid.result.refreshWarning = entry.value
      else delete valid.result.refreshWarning
      const serialized = JSON.stringify(valid)
      await page.evaluate(({ key, serialized }) => sessionStorage.setItem(key, serialized), { key: saved.key, serialized })
      await page.reload({ waitUntil: 'networkidle' })
      await expect(page.locator('.live-live')).toBeVisible({ timeout: 25000 })
      const restored = await open(created)
      await expect(restored).toContainText('Saved revision v2 (confirmed by exact replay)')
      await expect(restored.getByRole('alert')).toHaveCount(0)
      await expect(restored.getByRole('button', { name: 'Retry exact request', exact: true })).toHaveCount(0)
      if (entry.value) {
        await expect(restored).toContainText('Saved successfully; refresh is unavailable: ' + entry.value)
        await capture('valid-saved-warning-restored-with-receipt')
      } else {
        await expect(restored).not.toContainText('Saved successfully; refresh is unavailable:')
      }
      assert.equal(await page.evaluate(key => sessionStorage.getItem(key), saved.key), serialized)
    }
    assert.equal(revisionRequests, 0)
    const after = await graph(mid)
    assert.deepEqual(after.revisions, before.revisions)
    assert.equal(after.runs.length, 0)
    check('native_saved_receipt_optional_text_warning_restores_without_replay', {
      values: ['absent', 'empty-string', 'text'], revision_requests: revisionRequests,
      revisions: after.revisions.length, runs: 0, exact_pending_request_preserved: true,
      warning_variants: 'synthetic local browser storage values on a genuine native saved receipt',
    })
  } finally {
    page.off('request', onRequest)
    await page.evaluate(({ key, serialized }) => sessionStorage.setItem(key, serialized), saved)
  }
  await page.reload({ waitUntil: 'networkidle' })
  await expect(page.locator('.live-live')).toBeVisible({ timeout: 25000 })
  return open(created)
}
