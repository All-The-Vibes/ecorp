// Extra browser-only transport fixtures. These are not native signed artifacts or authorization evidence.
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const media = 'application/vnd.ecorp.deliverable+json'
const file = (path, body, mediaType = 'text/plain') => {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body)
  return { path, status: 'A', mode: '100644', bytes: bytes.length, sha256: sha(bytes), media_type: mediaType, content_base64: bytes.toString('base64') }
}

export async function exerciseBrowserVariants({ browser, expect, qa, server, web, demo, mid, snapshot, report, save, check }) {
  const native = structuredClone(snapshot)
  const targetRun = native.snapshot.runs.find((run) => run.id === report.native_source.run_id)
  const otherRun = native.snapshot.runs.find((run) => run.id === report.native_roots[1].id)
  const targetSource = native.snapshot.source_deliverables.find((source) => source.run_id === targetRun.id)
  assert.ok(targetSource && otherRun)
  const prefix = `/api/corps/${demo.corp_id}`
  const artifactPath = prefix + '/artifacts/' + targetSource.artifact_id
  const selectionKey = 'ecorp:work-selection:v1:' + JSON.stringify([server, demo.corp_id, demo.alice_actor_id])
  const variants = report.browser_only = {
    scope: 'Synthetic snapshot, artifact bytes and WebSocket readiness in a separate browser context. No signing key, native signature, persisted source, reviewer decision or database record is changed. This only establishes UI behavior.',
    intercepted_bootstrap_posts: 0, native_mutations: 0, blocked_requests: [], artifact_requests: [], snapshot_responses: [], cases: {}, screenshots: {},
  }
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, reducedMotion: 'reduce' })
  await context.addInitScript(({ key, choice }) => { sessionStorage.setItem(key, JSON.stringify(choice)) },
    { key: selectionKey, choice: { missionId: mid, taskId: targetRun.task_id, runId: targetRun.id } })
  const state = { name: '', snapshot: null, bytes: null, status: 200, hold: null }
  const cors = { 'access-control-allow-origin': web, 'access-control-allow-headers': 'content-type, authorization', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'cache-control': 'no-store' }
  await context.route('**/*', async (route) => {
    const req = route.request(), url = new URL(req.url())
    if (![server, web].includes(url.origin)) {
      variants.blocked_requests.push({ method: req.method(), origin: url.origin, path: url.pathname }); save()
      return route.abort()
    }
    if (url.origin === server && req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
    if (url.origin === server && req.method() === 'POST' && url.pathname === '/api/demo/bootstrap') {
      variants.intercepted_bootstrap_posts++; save()
      return route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify(demo) })
    }
    if (!['GET', 'HEAD'].includes(req.method())) {
      variants.blocked_requests.push({ method: req.method(), origin: url.origin, path: url.pathname }); save()
      return route.abort()
    }
    if (url.origin === server && url.pathname === prefix + '/snapshot') {
      variants.snapshot_responses.push({ case: state.name, selected_run: targetRun.id,
        source_sha256: state.snapshot.snapshot.source_deliverables.find((item) => item.id === targetSource.id).sha256 }); save()
      return route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify(state.snapshot) })
    }
    if (url.origin === server && url.pathname === artifactPath) {
      const response = { name: state.name, status: state.status, bytes: Buffer.from(state.bytes), hold: state.hold }
      variants.artifact_requests.push({ case: response.name, actor_id: url.searchParams.get('actor_id'), path: artifactPath, status: response.status }); save()
      if (response.hold) await response.hold.promise
      try {
        await route.fulfill({ status: response.status, headers: { ...cors, 'content-length': String(response.bytes.length) }, contentType: media, body: response.bytes })
      } catch (error) {
        if (!response.hold) throw error
        response.hold.closed_after_cancel = true
      } finally { response.hold?.settle() }
      return
    }
    return route.continue()
  })
  await context.routeWebSocket('**/*', (socket) => {
    const url = new URL(socket.url())
    if (url.origin === server.replace(/^http/, 'ws') && url.pathname === `/ws/corps/${demo.corp_id}`) {
      socket.send(JSON.stringify({ type: 'ready', replayed_through: 0 }))
    } else if (url.origin === web.replace(/^http/, 'ws')) socket.connectToServer()
    else { variants.blocked_requests.push({ method: 'WEBSOCKET', origin: url.origin, path: url.pathname }); save(); socket.close() }
  })
  const page = await context.newPage(), errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  const panel = () => page.locator(`[data-mission-id="${mid}"]`).getByTestId('inspect-source')
  const search = () => panel().getByRole('searchbox', { name: 'Search changed files', exact: true })
  const list = () => panel().getByRole('list', { name: 'Changed files', exact: true })
  const open = () => panel().getByRole('button', { name: /^(Inspect|Reload) source changes$/ }).click()
  const record = (name, value) => { variants.cases[name] = value; save(); console.log('PASS browser-only ' + name) }
  const screenshot = async (name) => {
    const filename = 'browser-only-' + name + '-' + randomUUID().slice(0, 8) + '.png'
    await page.screenshot({ path: join(qa, 'evidence', filename), fullPage: true }); variants.screenshots[name] = filename; save()
  }
  const patch = Buffer.from('diff --git a/inert.html b/inert.html\n+<script>globalThis.__issue260Executed = true</script>\n')
  const changes = Array.from({ length: 241 }, (_, index) => file(`files/${String(index).padStart(4, '0')}.txt`, `Browser-only file ${index}\n`))
  changes.push(
    file('inert.html', '<h1>Untrusted</h1><script>globalThis.__issue260Executed = true</script><img src="https://preview-test.invalid/image" onerror="globalThis.__issue260Executed = true">', 'text/html'),
    file('redaction.txt', 'Public first line\npassword = demo-only-not-a-credential\nPublic last line\n'),
    file('binary.txt', Buffer.from([0, 255, 42])),
    file('unsupported.zip', 'Not a real archive', 'application/zip'),
    file('oversized.txt', Buffer.alloc(128 * 1024 + 1, 65)),
    file('.env.example', 'DEMO_ONLY=not-a-real-secret\n'),
    { ...file('not-included.txt', 'not included'), content_base64: null },
    { path: 'deleted.txt', status: 'D', mode: null, sha256: null, bytes: null, media_type: null, content_base64: null },
  )
  const original = {
    schema_version: 1, form: targetSource.form, base_commit: targetSource.base_commit,
    head_commit: targetSource.head_commit, branch: targetSource.branch, verification_sha256: targetSource.verification_sha256,
    patch_sha256: sha(patch), patch_base64: patch.toString('base64'), changes,
  }
  async function loadCase(name, { manifest = original, expiresIn = null, declaredBytes = null, mismatch = false } = {}) {
    assert.equal(state.hold, null)
    state.name = name; state.status = 200; state.bytes = Buffer.from(JSON.stringify(manifest))
    state.snapshot = structuredClone(native)
    const run = state.snapshot.snapshot.runs.find((item) => item.id === targetRun.id)
    const source = state.snapshot.snapshot.source_deliverables.find((item) => item.id === targetSource.id)
    source.sha256 = sha(state.bytes); source.bytes = declaredBytes ?? state.bytes.length
    source.provenance_signature = 'synthetic-browser-only-not-a-native-signature'
    source.media_type = media
    if (expiresIn !== null) source.retention_until = new Date(Date.now() + expiresIn).toISOString()
    run.deliverable_sha256 = source.sha256
    if (mismatch) { state.bytes = Buffer.from(state.bytes); state.bytes[state.bytes.length - 2] ^= 1 }
    const previousSnapshots = variants.snapshot_responses.length
    // A unique query forces a new document. Same-URL fragment navigation can retain the prior snapshot.
    await page.goto(web + '/?issue260_case=' + encodeURIComponent(name) + '#missions', { waitUntil: 'networkidle' })
    await expect(page.locator('.live-live')).toBeVisible()
    await page.getByRole('link', { name: 'Missions', exact: true }).click()
    await expect(panel()).toHaveAttribute('data-run-id', targetRun.id)
    await expect(panel()).toHaveAttribute('data-artifact-sha256', source.sha256)
    assert.ok(variants.snapshot_responses.length > previousSnapshots, 'each case must load its own snapshot')
    assert.equal(variants.snapshot_responses.at(-1).case, name)
  }
  async function choose(path) {
    await search().fill(path); await expect(list().locator('li')).toHaveCount(1)
    await list().getByRole('button').click()
  }
  function hold() {
    let release, settle
    const promise = new Promise((done) => { release = done }), settled = new Promise((done) => { settle = done })
    state.hold = { promise, release, settle, settled }; return state.hold
  }
  try {
    await loadCase('large-and-inert'); await open(); await expect(panel()).toHaveAttribute('data-inspection-state', 'ready')
    await expect(list().locator('li')).toHaveCount(40)
    await expect(panel()).toContainText('249 changed files')
    await panel().getByRole('button', { name: 'Next files', exact: true }).click()
    await expect(panel()).toContainText('Page 2 of 7'); await expect(list().locator('li')).toHaveCount(40)
    await choose('files/0240.txt'); await expect(panel().getByRole('region', { name: 'files/0240.txt', exact: true })).toHaveText('Browser-only file 240\n')
    await choose('inert.html')
    await expect(panel().getByRole('region', { name: 'inert.html', exact: true })).toContainText('<script>globalThis.__issue260Executed = true</script>')
    assert.equal(await panel().locator('script,img,iframe,object,embed').count(), 0)
    assert.equal(await page.evaluate(() => globalThis.__issue260Executed), undefined)
    await panel().getByRole('button', { name: 'Inspect source diff', exact: true }).click()
    await expect(panel().getByRole('region', { name: 'Source diff', exact: true })).toContainText('<script>')
    await screenshot('manifest-desktop')
    record('large_manifest_search_pagination_inert_html_and_diff', { files: 249, maximum_rendered: 40, pages: 7, executed: false })

    await choose('redaction.txt')
    await expect(panel()).toContainText('1 line masked as possible credentials.')
    await expect(panel().getByRole('region', { name: 'redaction.txt', exact: true })).not.toContainText('demo-only-not-a-credential')
    await expect(panel()).toContainText('Display masking is not a full secret scan')
    for (const [path, message] of [
      ['binary.txt', 'Binary or non-UTF-8 content has no text preview.'],
      ['unsupported.zip', 'This file type has no supported text preview.'],
      ['oversized.txt', 'Text preview exceeds 128 KiB.'],
      ['.env.example', 'Preview withheld for a potentially sensitive path.'],
      ['not-included.txt', 'This report records the file but does not include its contents.'],
      ['deleted.txt', 'This file was deleted.'],
    ]) { await choose(path); await expect(panel()).toContainText(message) }
    await choose('inert.html'); await page.setViewportSize({ width: 390, height: 844 })
    await expect(panel().getByRole('region', { name: 'inert.html', exact: true })).toBeVisible()
    const bounds = await panel().evaluate((element) => ({ width: element.clientWidth, scroll: element.scrollWidth, left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right }))
    assert.ok(bounds.left >= 0 && bounds.right <= 391 && bounds.scroll <= bounds.width + 1)
    await screenshot('manifest-390px'); await page.setViewportSize({ width: 1440, height: 1050 })
    record('redaction_file_states_and_mobile', { redacted_lines: 1, states: ['binary', 'unsupported', 'oversize', 'sensitive-path', 'not-included', 'deleted'], bounds })

    for (const [name, options, message] of [
      ['artifact-hash-mismatch', { mismatch: true }, 'Evidence does not match the selected run'],
      ['unsupported-version', { manifest: { ...original, schema_version: 2 } }, 'This evidence format or version is not supported'],
      ['source-identity-mismatch', { manifest: { ...original, base_commit: 'f'.repeat(40) } }, 'Evidence does not match the selected run'],
      ['artifact-too-large', { declaredBytes: 16 * 1024 * 1024 + 1 }, 'Evidence exceeds the 16 MiB inspection limit'],
    ]) {
      await loadCase(name, options); await open(); await expect(panel()).toHaveAttribute('data-inspection-state', 'error')
      await expect(panel().getByRole('alert')).toContainText(message)
      await expect(page.locator(`[data-mission-id="${mid}"]`).getByRole('button', { name: 'Download source deliverable', exact: true })).toBeEnabled()
      record(name, { preview_withheld: true, existing_download_available: true })
    }
    const invalidFile = structuredClone(original); invalidFile.changes[0].sha256 = 'f'.repeat(64)
    await loadCase('file-hash-mismatch', { manifest: invalidFile }); await open(); await expect(panel()).toHaveAttribute('data-inspection-state', 'ready')
    await choose('files/0000.txt'); await expect(panel().getByRole('alert')).toContainText('Evidence does not match the selected run')
    record('file-hash-mismatch', { preview_withheld: true })

    await loadCase('http-error-recovery'); state.status = 503
    await open(); await expect(panel()).toHaveAttribute('data-inspection-state', 'error'); await expect(panel().getByRole('alert')).toContainText('Evidence could not be read')
    state.status = 200; await open(); await expect(panel()).toHaveAttribute('data-inspection-state', 'ready')
    record('http-error-recovery', { failed_status: 503, recovered_status: 200 })

    await loadCase('expired', { expiresIn: -1000 })
    await expect(panel()).toHaveAttribute('data-inspection-state', 'error'); await expect(panel().getByRole('alert')).toContainText('Evidence retention has expired')
    await expect(panel().getByRole('button', { name: 'Inspect source changes', exact: true })).toBeDisabled()
    assert.equal(variants.artifact_requests.filter((request) => request.case === 'expired').length, 0)
    record('expired', { network_read_prevented: true })

    await loadCase('expiry-during-view', { expiresIn: 8000 }); await open(); await expect(panel()).toHaveAttribute('data-inspection-state', 'ready')
    await expect(panel()).toHaveAttribute('data-inspection-state', 'error', { timeout: 15000 })
    await expect(panel().getByRole('alert')).toContainText('Evidence retention has expired')
    await expect(list()).toHaveCount(0)
    record('expiry-during-view', { previously_loaded_document_withheld: true })

    await loadCase('cancel-loading'); const cancelled = hold(); await open()
    await expect.poll(() => variants.artifact_requests.filter((request) => request.case === 'cancel-loading').length).toBe(1)
    await expect(panel()).toHaveAttribute('data-inspection-state', 'loading')
    await panel().getByRole('button', { name: 'Cancel inspection', exact: true }).click(); await expect(panel()).toHaveAttribute('data-inspection-state', 'idle')
    cancelled.release(); await cancelled.settled; state.hold = null
    await expect(panel()).toHaveAttribute('data-inspection-state', 'idle')
    record('cancel-loading', { cancelled_response_does_not_replace_idle_state: true })

    await loadCase('selected-run-late-response'); const late = hold(); await open()
    await expect.poll(() => variants.artifact_requests.filter((request) => request.case === 'selected-run-late-response').length).toBe(1)
    await expect(panel()).toHaveAttribute('data-inspection-state', 'loading')
    await page.locator(`#mission-evidence-${mid}`).selectOption(otherRun.id)
    await expect(page.locator('[data-mission-id="' + mid + '"]')).toHaveAttribute('data-run-id', otherRun.id)
    await expect(panel()).toHaveCount(0)
    late.release(); await late.settled; state.hold = null
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))))
    await expect(panel()).toHaveCount(0); await expect(list()).toHaveCount(0)
    record('selected-run-late-response', { original_run: targetRun.id, selected_run: otherRun.id, original_document_withheld: true })
    assert.deepEqual(errors, []); assert.deepEqual(variants.blocked_requests, [])
    check('browser_only_edge_states', { cases: Object.keys(variants.cases), native_mutations: 0, synthetic_only: true })
  } finally { state.hold?.release(); await context.close() }
}
