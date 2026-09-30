// Native browser -> server -> runner acceptance. Only the delayed response and
// browser snapshot transport failure are controlled; all creation, dispatch,
// verification, signed artifacts and source archives come from the owned stack.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join, relative, isAbsolute } from 'node:path'
import { execFileSync } from 'node:child_process'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')

export async function exerciseNativeMissionCreation({ browser, expect, qa, server, web, demo, source, snapshot, wait, check, save, report, intent }) {
  const base = '/api/corps/' + demo.corp_id
  const before = (await snapshot()).snapshot
  const beforeSource = {
    status: execFileSync('git', ['-C', join(qa, 'source'), 'status', '--porcelain'], { encoding: 'utf8' }).trim(),
    head: execFileSync('git', ['-C', join(qa, 'source'), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    readme: hash(readFileSync(join(qa, 'source/README.md'))),
  }
  report.native_mission_creation = {
    scope: 'Real single-task creation and launch through the browser into the owned native fake-process runner. The second case delays delivery of a real creation response and temporarily rejects only this browser context snapshot reads. No server outcome is fabricated, no provider inference or external publication is involved, and no claim of server idempotency across browser reloads is made.',
    cases: [],
  }
  save()
  for (const name of ['ordinary', 'delayed-refresh-failure']) {
    const delayed = name !== 'ordinary'
    const title = '[portable-deliverable] Issue264 native creation ' + name
    const editedTitle = 'Unsubmitted native draft after ' + name
    const result = { name, title, status: 'running', creates: 0, launches: 0, controlled_snapshot_failures: 0, unexpected_requests: [], page_errors: [], route_errors: [] }
    report.native_mission_creation.cases.push(result); save()
    const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, reducedMotion: 'reduce', acceptDownloads: true, serviceWorkers: 'block' })
    let releaseCreate, blockSnapshots = false
    const deliveryGate = new Promise(resolve => { releaseCreate = resolve })
    const verifyRoutes = () => assert.deepEqual(result.route_errors, [], 'Native creation transport must not hide a fixture error')
    let page
    try {
      await context.addInitScript(({ corp, actor }) => {
        localStorage.setItem('ecorp.console.mode', 'operations')
        sessionStorage.setItem('ecorp_corp_id', corp)
        sessionStorage.setItem('ecorp_actor_id', actor)
      }, { corp: demo.corp_id, actor: demo.alice_actor_id })
      await context.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url()), method = request.method()
        try {
          if (url.origin === web && ['GET', 'HEAD'].includes(method)) return await route.continue()
          if (url.origin !== server) {
            result.unexpected_requests.push({ method, origin: url.origin, path: url.pathname }); save()
            return await route.abort()
          }
          if (method === 'GET' && url.pathname === base + '/snapshot' && blockSnapshots) {
            result.controlled_snapshot_failures++; save()
            return await route.fulfill({ status: 503, contentType: 'application/json', headers: { 'access-control-allow-origin': web }, body: JSON.stringify({ error: 'Controlled browser snapshot transport failure' }) })
          }
          if (method === 'POST' && url.pathname === base + '/missions') {
            assert.equal(result.creates, 0, 'Never forward a duplicate native create')
            result.creates++
            const submitted = request.postDataJSON()
            assert.equal(submitted.title, title)
            assert.equal(submitted.requested_by, demo.alice_actor_id)
            assert.equal(submitted.preferred_adapter, 'fake-process')
            assert.equal(submitted.strategy, 'single')
            assert.equal(submitted.deliverable.form, 'archive')
            assert.equal(submitted.source.repository, source.repository)
            assert.equal(submitted.source.base_ref, source.base_ref)
            assert.equal(submitted.source.base_commit, source.base_commit)
            result.submitted = submitted
            const operation = intent('native-create-' + name, url.pathname)
            const response = await route.fetch({ maxRedirects: 0, maxRetries: 0, timeout: 20000 })
            operation.response_status = response.status(); save()
            assert.equal(response.status(), 200, 'Real server creation must succeed')
            const bytes = await response.body(), body = JSON.parse(bytes)
            assert.match(body.mission_id, /^[0-9a-f-]{36}$/i)
            result.mission_id = body.mission_id
            operation.mission_id = body.mission_id
            operation.completed = true
            operation.response_sha256 = hash(bytes); save()
            if (delayed) await deliveryGate
            await route.fulfill({ response })
            result.creation_response_delivered = true; save()
            return
          }
          if (method === 'POST' && result.mission_id && url.pathname === base + '/missions/' + result.mission_id + '/launch') {
            assert.equal(result.launches, 0, 'Never forward a duplicate native launch')
            result.launches++
            assert.equal(request.postDataJSON().requested_by, demo.alice_actor_id)
            const operation = intent('native-create-launch-' + name, url.pathname)
            const response = await route.fetch({ maxRedirects: 0, maxRetries: 0, timeout: 20000 })
            operation.response_status = response.status(); save()
            assert.equal(response.status(), 200, 'Real single-task launch must succeed')
            const bytes = await response.body(), body = JSON.parse(bytes)
            assert.match(body.run_id, /^[0-9a-f-]{36}$/i)
            assert.equal(body.runner_id, 'pr265-activity-qa')
            assert.deepEqual(body.run_ids, [body.run_id])
            assert.deepEqual(body.runner_ids, [body.runner_id])
            assert.equal(body.replayed, false)
            result.launch_response = body
            operation.completed = true
            operation.response_sha256 = hash(bytes); save()
            return await route.fulfill({ response })
          }
          if (['GET', 'HEAD', 'OPTIONS'].includes(method) ||
              (method === 'POST' && [base + '/missions/preview', '/api/demo/bootstrap'].includes(url.pathname))) return await route.continue()
          result.unexpected_requests.push({ method, path: url.pathname }); save()
          return await route.abort()
        } catch (error) {
          result.route_errors.push(String(error.stack ?? error)); save()
          try { await route.abort() } catch { /* Preserve the original route error. */ }
        }
      })
      page = await context.newPage()
      page.on('pageerror', error => { result.page_errors.push(error.message); save() })
      await page.goto(web + '/#missions', { waitUntil: 'networkidle' })
      await expect(page.locator('.live-live')).toBeVisible({ timeout: 20000 })
      await expect(page.locator('#operator-actor')).toHaveValue(demo.alice_actor_id)
      await page.getByRole('link', { name: 'Missions', exact: true }).click()
      if (!(await page.locator('#mission-title').isVisible())) await page.getByRole('button', { name: 'New mission', exact: true }).click()
      await page.locator('#mission-title').fill(title)
      const options = await page.locator('#mission-repository option').evaluateAll(options => options.map(option => ({ value: option.value, text: option.textContent })))
      const targets = options.filter(option => option.value && option.text.includes(source.repository) && option.text.includes(source.base_commit.slice(0, 12)))
      assert.equal(targets.length, 1, 'Choose the exact owned source tuple')
      await page.locator('#mission-repository').selectOption(targets[0].value)
      await page.getByRole('checkbox', { name: /Confirm this target/ }).check()
      await page.locator('summary').filter({ hasText: /^Model, limits and output/ }).click()
      await page.getByRole('checkbox', { name: /Developer fixtures/ }).check()
      await page.locator('#mission-adapter').selectOption('fake-process')
      await page.locator('#mission-strategy').selectOption('single')
      await page.locator('#mission-deliverable').selectOption('archive')
      await page.getByRole('checkbox', { name: /Save without starting/ }).uncheck()
      await page.getByRole('checkbox', { name: /Commit verified work/ }).uncheck()
      await page.getByRole('button', { name: 'Review and build', exact: true }).click()
      await expect(page.locator('.mission-submit')).toBeEnabled()
      await page.locator('.mission-submit').click()
      await wait(() => { verifyRoutes(); return result.mission_id }, 'actual server creation: ' + name)
      if (delayed) {
        await page.getByRole('button', { name: 'Back to setup', exact: true }).click()
        await page.locator('#mission-title').fill(editedTitle)
        blockSnapshots = true
        releaseCreate()
      }
      await wait(() => { verifyRoutes(); return result.launch_response }, 'actual browser launch: ' + name)
      const receipt = page.getByTestId('mission-creation-receipt')
      await expect(receipt).toContainText(result.mission_id)
      await expect(receipt).toContainText(title)
      await expect(receipt).toContainText('Dispatch was confirmed')
      await expect(receipt.getByRole('button', { name: 'Open saved mission', exact: true })).toBeEnabled()
      if (delayed) {
        assert.ok(result.controlled_snapshot_failures > 0)
        await expect(page.getByRole('alert').filter({ hasText: /was saved, but the mission list could not refresh/ })).toBeVisible()
        await expect(page.locator('#mission-title')).toHaveValue(editedTitle)
        result.inflight_draft_preserved = true
        await page.locator('#mission-title').fill(title)
        await page.getByRole('button', { name: 'Review and build', exact: true }).click()
        await expect(page.locator('.mission-submit')).toBeDisabled()
        await page.locator('form.mission-form').evaluate(form => form.requestSubmit())
        await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))))
        assert.equal(result.creates, 1)
        result.consumed_request_refused = true
        await page.getByRole('button', { name: 'Back to setup', exact: true }).click()
        await page.locator('#mission-title').fill(editedTitle)
        const failureScreenshot = 'native-mission-create-' + name + '-saved-refresh-failure.png'
        await page.screenshot({ path: join(qa, 'evidence', failureScreenshot), fullPage: true })
        result.failure_screenshot = failureScreenshot; save()
        blockSnapshots = false
        const refreshed = page.waitForResponse(response => response.url() === server + base + '/snapshot?actor_id=' + demo.alice_actor_id && response.request().method() === 'GET')
        await receipt.getByRole('button', { name: 'Refresh mission list', exact: true }).click()
        assert.equal((await refreshed).status(), 200)
        await expect(page.locator('#mission-title')).toHaveValue(editedTitle)
        result.refresh_recovered = true
      } else {
        await expect(page.locator('#mission-title')).toHaveCount(0)
      }
      await receipt.getByRole('button', { name: 'Open saved mission', exact: true }).click()
      const selectionKey = 'ecorp:work-selection:v1:' + JSON.stringify([server, demo.corp_id, demo.alice_actor_id])
      await expect.poll(() => page.evaluate(key => JSON.parse(sessionStorage.getItem(key))?.missionId, selectionKey)).toBe(result.mission_id)
      const completed = await wait(async () => {
        verifyRoutes()
        const s = (await snapshot()).snapshot
        const mission = s.missions.find(mission => mission.id === result.mission_id)
        assert.ok(mission, 'Saved mission remains present in authoritative state')
        assert.ok(!['failed', 'cancelled'].includes(mission.status), 'Native created mission failed: ' + mission.status)
        const tasks = s.tasks.filter(task => task.mission_id === result.mission_id)
        const runs = s.runs.filter(run => tasks.some(task => task.id === run.task_id))
        return mission.status === 'completed' && runs.length && runs.every(run => run.status === 'completed' && run.workspace_disposition === 'preserved') && { s, mission, tasks, runs }
      }, 'native created mission verified completion: ' + name)
      assert.equal(completed.tasks.length, 1)
      assert.equal(completed.runs.length, 1)
      const task = completed.tasks[0], run = completed.runs[0]
      assert.equal(task.attempt_count, 1)
      assert.equal(task.verification_status, 'passed')
      assert.equal(run.id, result.launch_response.run_id)
      assert.equal(run.workspace_base_commit, source.base_commit)
      const checks = completed.s.verification_evidence.filter(item => item.run_id === run.id)
      assert.ok(checks.length > 0 && checks.every(item => item.status === 'passed'))
      assert.equal(completed.s.verification_requests.filter(item => item.run_id === run.id).length, 0)
      const deliverables = completed.s.source_deliverables.filter(item => item.run_id === run.id)
      assert.equal(deliverables.length, 1)
      const deliverable = deliverables[0]
      assert.equal(deliverable.sha256, run.deliverable_sha256)
      assert.match(run.verification_sha256, /^[0-9a-f]{64}$/)
      const workspace = realpathSync(run.workspace_path), workspaceRelative = relative(join(qa, 'runner'), workspace)
      assert.ok(workspaceRelative && !workspaceRelative.startsWith('..') && !isAbsolute(workspaceRelative))
      assert.equal(hash(readFileSync(join(workspace, 'result.md'))), run.artifact_sha256)
      const card = page.locator('[data-mission-id="' + result.mission_id + '"]')
      await expect(card).toBeVisible()
      await expect(card).toHaveAttribute('data-run-id', run.id)
      const downloads = []
      for (const [kind, label, expected] of [
        ['provider', 'Download verified artifact', run.artifact_sha256],
        ['source', 'Download source deliverable', deliverable.sha256],
      ]) {
        const pending = page.waitForEvent('download')
        await card.getByRole('button', { name: label, exact: true }).click()
        const downloaded = await pending, downloadedPath = await downloaded.path()
        assert.ok(downloadedPath)
        const bytes = readFileSync(downloadedPath)
        assert.equal(hash(bytes), expected)
        const filename = 'native-mission-create-' + name + '-' + kind + (kind === 'provider' ? '.md' : '.json')
        writeFileSync(join(qa, 'evidence', filename), bytes, { flag: 'wx' })
        downloads.push({ kind, filename, sha256: expected, bytes: bytes.length })
        if (kind === 'source') {
          const manifest = JSON.parse(bytes)
          assert.equal(manifest.verification_sha256, run.verification_sha256)
          // Provider result.md is separate signed evidence; source export excludes it.
          // Pin both changes to the fixture contract and exact retained workspace bytes.
          assert.equal(manifest.schema_version, 1)
          assert.equal(manifest.form, 'archive')
          assert.equal(manifest.base_commit, source.base_commit)
          assert.equal(manifest.branch, run.workspace_branch)
          assert.equal(manifest.head_commit, null)
          assert.equal(manifest.source_verification.base_commit, source.base_commit)
          assert.equal(manifest.verified_tree, manifest.source_verification.tree)
          assert.match(manifest.source_verification.candidate_commit, /^[0-9a-f]{40}$/)
          assert.equal(hash(Buffer.from(manifest.patch_base64, 'base64')), manifest.patch_sha256)
          assert.deepEqual(manifest.changes.map(change => change.path), ['README.md', 'portable-untracked.txt'])
          const expectedContents = {
            'README.md': readFileSync(join(qa, 'source/README.md'), 'utf8').trimEnd() + '\n\nPortable deliverable fixture: tracked change.\n',
            'portable-untracked.txt': 'portable untracked source\n',
          }
          for (const change of manifest.changes) {
            const exported = Buffer.from(change.content_base64, 'base64')
            assert.deepEqual(exported, readFileSync(join(workspace, change.path)))
            assert.equal(exported.toString('utf8'), expectedContents[change.path])
            assert.equal(exported.length, change.bytes)
            assert.equal(hash(exported), change.sha256)
            assert.equal(change.status, change.path === 'README.md' ? 'M' : 'A')
          }
          result.source_manifest = { base_commit: manifest.base_commit,
            verified_tree: manifest.verified_tree, patch_sha256: manifest.patch_sha256,
            changes: manifest.changes.map(({ path, status, sha256, bytes }) => ({ path, status, sha256, bytes })),
            provider_artifact_excluded: true }
        }
      }
      result.evidence = { mission_id: result.mission_id, task_id: task.id, run_id: run.id,
        task_verification_policy: task.verification_policy, verification: checks,
        provider_artifact_id: run.artifact_id, source_artifact_id: deliverable.artifact_id,
        verification_sha256: run.verification_sha256, downloads, workspace: relative(qa, workspace) }
      const completedScreenshot = 'native-mission-create-' + name + '-completed.png'
      await page.screenshot({ path: join(qa, 'evidence', completedScreenshot), fullPage: true })
      result.completed_screenshot = completedScreenshot
      await page.getByRole('button', { name: 'New mission', exact: true }).click()
      await expect(page.locator('#mission-title')).toHaveValue(delayed ? editedTitle : '')
      assert.equal(result.creates, 1); assert.equal(result.launches, 1)
      assert.deepEqual(result.page_errors, []); assert.deepEqual(result.unexpected_requests, []); verifyRoutes()
      result.status = 'passed'; save()
      check('native_browser_created_' + name.replaceAll('-', '_') + '_verified_once', result.evidence)
    } catch (error) {
      result.status = 'failed'; result.failure = String(error.stack ?? error); save()
      if (page) {
        try {
          const filename = 'native-mission-create-' + name + '-failure.png'
          await page.screenshot({ path: join(qa, 'evidence', filename), fullPage: true })
          result.failure_screenshot = filename; save()
        } catch { /* Keep original failure. */ }
      }
      throw error
    } finally {
      blockSnapshots = false; releaseCreate()
      await context.close(); save()
    }
  }
  const after = (await snapshot()).snapshot
  const cases = report.native_mission_creation.cases
  assert.deepEqual(after.missions.filter(mission => !before.missions.some(prior => prior.id === mission.id)).map(mission => mission.id).sort(), cases.map(item => item.mission_id).sort())
  for (const key of ['missions', 'tasks', 'runs', 'verification_requests', 'verification_evidence', 'source_deliverables', 'mission_budget_revisions']) {
    assert.deepEqual(after[key].filter(item => before[key].some(prior => prior.id === item.id)), before[key], 'Creation must preserve prior native ' + key)
  }
  assert.deepEqual(after.pull_request_publications, before.pull_request_publications)
  assert.equal(execFileSync('git', ['-C', join(qa, 'source'), 'status', '--porcelain'], { encoding: 'utf8' }).trim(), beforeSource.status)
  assert.equal(execFileSync('git', ['-C', join(qa, 'source'), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), beforeSource.head)
  assert.equal(hash(readFileSync(join(qa, 'source/README.md'))), beforeSource.readme)
  check('native_creation_preserved_original_source_and_prior_graph', { missions: cases.map(item => item.mission_id), creates: 2, launches: 2, runs: 2, prior_records_unchanged: true, source_unchanged: true, publication_effects: 0 })
}
