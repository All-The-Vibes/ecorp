import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { readFixtureSourceIdentity } from './fixture_source_identity.mjs'
import { verifyOwnedTestProcess } from './owned_test_stack.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const SHA = /^[0-9a-f]{64}$/
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/
export const researchDemo = Object.freeze({
  corp_id: '00000000-0000-4000-8000-000000000001',
  room_id: '00000000-0000-4000-8000-000000000041',
  alice_actor_id: '00000000-0000-4000-8000-000000000011',
})
const forbiddenPorts = new Set(['8791', '8793', '8991', '5187', '5291', '15191',
  '15193', '15481', '15491', '18962'])
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
const keys = (value, expected) => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), 'QA object required')
  assert.ok(Object.keys(value).sort().join(',') === [...expected].sort().join(','), 'Unexpected QA fields')
}

export function researchCase(args) {
  if (!args.length) return null // Preserve the explicitly opted-in legacy API lane.
  const { values } = parseArgs({ args, options: {
    case: { type: 'string' }, 'require-owned-qa': { type: 'boolean' },
  }, strict: true, allowPositionals: false })
  assert.equal(args.length, 3, 'Exactly --case <name> --require-owned-qa is required')
  assert.equal(values['require-owned-qa'], true, 'Owned QA is mandatory for named cases')
  assert.ok(['browser-consumption', 'adversarial'].includes(values.case), 'Unknown research handoff case')
  return values.case
}

export function qaOrigin(value) {
  assert.ok(typeof value === 'string' && value.length < 256, 'Explicit QA origin required')
  let url
  try { url = new URL(value) } catch { throw new Error('Invalid QA origin') }
  assert.ok(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) &&
    Number(url.port) >= 10_000 && !forbiddenPorts.has(url.port) &&
    !url.username && !url.password && !url.search && !url.hash && url.pathname === '/',
  'Use a credential-free, owned loopback high-port origin')
  assert.ok(value === url.origin, 'Use the canonical origin without a trailing slash')
  return url.origin
}

export function validateResearchQa(value) {
  keys(value, ['schema_version', 'issue', 'state', 'test_owned', 'head', 'files_sha256',
    'source', 'server', 'runner', 'web', 'fixture'])
  assert.ok(value.schema_version === 1 && value.issue === 297 && value.test_owned === true &&
    value.state === 'candidate_ready', 'Requires operator-bound candidate_ready issue297 context')
  assert.ok(typeof value.head === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value.head),
    'Exact candidate Git HEAD required')
  assert.ok(typeof value.files_sha256 === 'string' && SHA.test(value.files_sha256), 'Candidate inventory digest required')
  keys(value.fixture, Object.keys(researchDemo))
  assert.ok(Object.entries(researchDemo).every(([key, id]) => value.fixture[key] === id),
    'Requires the already-seeded development fixture; never create another Corp')
  keys(value.source, ['repository', 'base_ref', 'base_commit'])
  assert.ok(/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(value.source.repository) &&
    typeof value.source.base_ref === 'string' && value.source.base_ref.length > 0 &&
    value.source.base_ref.length <= 256 && value.source.base_commit === value.head,
  'Exact source tuple required')
  for (const name of ['server', 'runner']) {
    const item = value[name]
    keys(item, [name === 'server' ? 'url' : 'id', 'binary', 'sha256', 'manifest'])
    assert.ok(typeof item.binary === 'string' && path.isAbsolute(item.binary), 'Absolute candidate binary required')
    assert.ok(typeof item.sha256 === 'string' && SHA.test(item.sha256), 'Candidate binary digest required')
    assert.ok(item.manifest?.test_owned === true, 'Owned process receipt required')
  }
  assert.ok(typeof value.runner.id === 'string' && UUID.test(value.runner.id), 'Exact runner ID required')
  keys(value.web, ['url', 'assets'])
  assert.ok(qaOrigin(value.server.url) !== qaOrigin(value.web.url), 'Web/API origins must differ')
  assert.ok(value.web.assets && !Array.isArray(value.web.assets) &&
    typeof value.web.assets === 'object', 'Pinned built web assets required')
  const assets = Object.entries(value.web.assets)
  assert.ok(assets.length >= 2 && assets.length <= 256 && SHA.test(value.web.assets['/'] ?? '') &&
    assets.some(([name]) => name.endsWith('.js')), 'Pin built index and scripts, not a development web server')
  for (const [name, sha] of assets) {
    assert.ok(name === '/' || name === '/favicon.svg' ||
      /^\/assets\/(?:[a-zA-Z0-9_-][a-zA-Z0-9_.-]*\/)*[a-zA-Z0-9_-][a-zA-Z0-9_.-]*\.(?:js|css|svg|png|jpg|jpeg|webp|ttf|woff2?)$/.test(name),
    'Built asset path required')
    assert.ok(typeof sha === 'string' && SHA.test(sha), 'Built asset digest required')
  }
  return value
}

async function fileDigest(file, limit) {
  const stat = await lstat(file)
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= limit, 'Bounded regular candidate file required')
  const hash = createHash('sha256')
  let size = 0
  for await (const bytes of createReadStream(file)) {
    size += bytes.length
    assert.ok(size <= limit, 'Candidate file grew beyond its bound')
    hash.update(bytes)
  }
  assert.equal(size, stat.size, 'Candidate file changed during read')
  return hash.digest('hex')
}

export async function candidateSourcePins() {
  const git = (...args) => execFileSync('git', args, {
    cwd: root, encoding: 'utf8', timeout: 10_000, maxBuffer: 2 * 1024 * 1024,
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  })
  const names = [...new Set(git('ls-files', '--cached', '--others', '--exclude-standard', '-z')
    .split('\0').filter(Boolean))].sort()
  assert.ok(names.length > 0 && names.length <= 10_000, 'Bounded complete candidate source inventory required')
  const files = []
  for (const name of names) files.push([name, await fileDigest(path.join(root, name), 16 * 1024 * 1024)])
  return { head: git('rev-parse', 'HEAD').trim(), files_sha256: digest(JSON.stringify(files)) }
}

export async function loadResearchQa(environment = process.env) {
  const file = environment.ECORP_ISSUE297_QA_CONTEXT
  assert.ok(typeof file === 'string' && path.isAbsolute(file), 'Absolute ECORP_ISSUE297_QA_CONTEXT required')
  assert.ok((await lstat(file)).isFile() && (await lstat(file)).size <= 64 * 1024, 'Bounded QA JSON file required')
  let supplied
  try { supplied = JSON.parse(await readFile(file, 'utf8')) } catch { throw new Error('Invalid QA JSON') }
  const qa = validateResearchQa(supplied)
  assert.ok(environment.CRONY_SERVER_HTTP === qa.server.url, 'API environment differs from owned QA context')
  const check = async () => {
    assert.deepEqual(await candidateSourcePins(), { head: qa.head, files_sha256: qa.files_sha256 },
      'Candidate source changed; operator must requalify it')
    assert.equal(readFixtureSourceIdentity(root).repository, qa.source.repository, 'Candidate repository mismatch')
    for (const name of ['server', 'runner']) {
      const item = qa[name]
      const relative = path.relative(await realpath(root), await realpath(item.binary))
      assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'Binary must belong to candidate checkout')
      assert.equal(await fileDigest(item.binary, 512 * 1024 * 1024), item.sha256, 'Candidate binary changed')
      await verifyOwnedTestProcess({
        root, server: qa.server.url, binary: item.binary, manifest: item.manifest,
        requireListener: name === 'server',
      })
    }
  }
  await check()
  return { qa, check }
}

export function browserRequestGuard({ server, web, corpId, actorId, missionId, assets }) {
  let armed = false
  let launches = 0
  let bootstraps = 0
  const launchPath = `/api/corps/${corpId}/missions/${missionId}/launch`
  return {
    arm() { assert.equal(launches, 0); armed = true },
    get launches() { return launches },
    allow(raw, method, body) {
      const url = new URL(raw)
      if (url.username || url.password || url.hash) return false
      if (url.origin === web) {
        return method === 'GET' && !url.search && Object.hasOwn(assets, url.pathname)
      }
      if (url.origin !== server) return false
      if (method === 'GET') return url.pathname === '/health' ||
        (url.pathname.startsWith(`/api/corps/${corpId}/`) &&
          url.searchParams.get('actor_id') === actorId)
      if (method === 'OPTIONS') return url.pathname.startsWith(`/api/corps/${corpId}/`) ||
        (url.pathname === '/api/demo/bootstrap' && url.search === '?seed_crew=false')
      if (method !== 'POST') return false
      if (url.pathname === '/api/demo/bootstrap' && url.search === '?seed_crew=false' &&
        body === '{}' && bootstraps < 2) { bootstraps++; return true }
      if (url.pathname === launchPath && !url.search && armed && launches === 0 &&
        body === JSON.stringify({ requested_by: actorId })) {
        launches++; armed = false; return true
      }
      return false
    },
  }
}

async function closeBrowser(browser) {
  let timer
  try {
    await Promise.race([
      browser.close(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Owned browser cleanup exceeded ten seconds')), 10_000)
      }),
    ])
  } finally { clearTimeout(timer) }
}

export async function openResearchBrowser(qa, { corpId, actorId, missionId, title, output }) {
  const require = createRequire(import.meta.url)
  const { chromium } = require(process.env.CRONY_PLAYWRIGHT_MODULE || 'playwright')
  const allowedEnvironment = new Set(['path', 'pathext', 'systemroot', 'windir', 'comspec', 'temp', 'tmp',
    'userprofile', 'homedrive', 'homepath', 'home', 'appdata', 'localappdata', 'programdata', 'programfiles',
    'programfiles(x86)', 'programw6432', 'systemdrive', 'username', 'userdomain', 'computername',
    'psmodulepath', 'number_of_processors', 'processor_architecture', 'os'])
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowedEnvironment.has(key.toLowerCase())))
  const browser = await chromium.launch({ channel: process.env.CRONY_BROWSER_CHANNEL || 'chrome', headless: true, env: environment })
  const proof = { assertions: [], browser_version: browser.version(), browser_environment_keys: Object.keys(environment).sort(), closed: false }
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1050 }, reducedMotion: 'reduce', serviceWorkers: 'block',
    })
    const server = qa.server.url
    const web = qa.web.url
    const guard = browserRequestGuard({ server, web, corpId, actorId, missionId, assets: qa.web.assets })
    const errors = []
    const pending = new Set()
    const seenAssets = new Set()
    await context.route('**/*', async (route) => {
      const request = route.request()
      if (guard.allow(request.url(), request.method(), request.postData(), request.resourceType())) return route.continue()
      errors.push('Browser attempted an unauthorized request')
      return route.abort('blockedbyclient')
    })
    await context.routeWebSocket('**/*', (route) => {
      const url = new URL(route.url())
      if (url.origin.replace(/^ws:/, 'http:') === server &&
        url.pathname === `/ws/corps/${corpId}` && url.searchParams.get('actor_id') === actorId &&
        !url.username && !url.password) return void route.connectToServer()
      errors.push('Browser attempted an unauthorized socket')
      route.close({ code: 1008, reason: 'Owned QA socket required' })
    })
    const page = await context.newPage()
    page.setDefaultTimeout(15_000)
    page.on('pageerror', () => errors.push('Browser page error'))
    page.on('response', (response) => {
      const task = (async () => {
        assert.ok(response.status() < 400, 'Browser HTTP failure')
        const url = new URL(response.url())
        if (url.origin === web && Object.hasOwn(qa.web.assets, url.pathname)) {
          const bytes = await response.body()
          assert.ok(bytes.length <= 16 * 1024 * 1024, 'Web asset exceeds bound')
          assert.equal(digest(bytes), qa.web.assets[url.pathname], 'Served web bytes differ from operator pin')
          seenAssets.add(url.pathname)
        }
        if (url.origin === server && url.pathname === '/api/demo/bootstrap') {
          const body = await response.json()
          assert.ok(body.corp_id === corpId && body.alice_actor_id === actorId, 'App bootstrap identity mismatch')
        }
      })().catch(() => errors.push('Browser response or asset binding failed'))
      pending.add(task)
      void task.finally(() => pending.delete(task))
    })
    const check = async () => {
      await Promise.all([...pending])
      assert.deepEqual(errors, [], 'Browser admission/readback failed')
      assert.ok(seenAssets.has('/') && [...seenAssets].some((name) => name.endsWith('.js')), 'No pinned App script executed')
    }
    await page.goto(`${web}/#missions`, { waitUntil: 'networkidle', timeout: 20_000 })
    await page.locator('.live-indicator.live-live').waitFor()
    const quickSwitch = page.getByLabel('Work item', { exact: true })
    if (await quickSwitch.isVisible()) {
      await quickSwitch.selectOption(missionId)
    } else {
      await page.getByRole('navigation', { name: 'Mission records', exact: true })
        .getByRole('button').filter({ has: page.getByText(title, { exact: true }) }).click()
    }
    const card = page.locator(`[data-mission-id="${missionId}"]`)
    await card.getByRole('heading', { name: title, exact: true }).waitFor()
    await card.locator('.status-chip-ready').filter({ hasText: 'Awaiting dispatch' }).waitFor()
    await check()
    proof.assertions.push('pinned_app_displays_held_mission')
    return {
      proof,
      async launch() {
        await check()
        guard.arm()
        const response = page.waitForResponse((item) => item.url() ===
          `${server}/api/corps/${corpId}/missions/${missionId}/launch` && item.request().method() === 'POST')
        await card.getByTestId('work-result-card').getByRole('button', { name: 'Start mission', exact: true }).click()
        const result = await response
        const body = await result.json()
        assert.equal(guard.launches, 1)
        proof.assertions.push('one_actual_app_launch')
        return { status: result.status(), body }
      },
      async verify(synthesis) {
        // The App keeps the first inspected run selected as new runs arrive.
        // Select the verified synthesis explicitly before reading its artifact.
        assert.match(synthesis.run_id, UUID)
        assert.match(synthesis.task_id, UUID)
        await card.getByLabel('Evidence for', { exact: true }).selectOption(synthesis.run_id)
        await card.locator(`[aria-label="Run evidence"][data-evidence-run-id="${synthesis.run_id}"][data-evidence-task-id="${synthesis.task_id}"]`).waitFor()
        const evidence = card.locator(`[data-testid="provider-evidence"][data-artifact-id="${synthesis.artifact_id}"]`)
        await evidence.waitFor()
        const downloaded = page.waitForEvent('download')
        await evidence.getByRole('button', { name: 'Download verified artifact', exact: true }).click()
        const download = await downloaded
        assert.equal(await download.failure(), null, 'App artifact download failed')
        const stream = await download.createReadStream()
        assert.ok(stream)
        const hash = createHash('sha256')
        let bytes = 0
        for await (const chunk of stream) {
          bytes += chunk.length
          assert.ok(bytes <= 512 * 1024, 'Browser artifact exceeds bound')
          hash.update(chunk)
        }
        assert.equal(bytes, synthesis.artifact_bytes)
        assert.equal(hash.digest('hex'), synthesis.artifact_sha256)
        await page.screenshot({ path: path.join(output, 'browser-consumption.png'), fullPage: true })
        await check()
        proof.assertions.push('app_download_matches_verified_child_readback')
      },
      async close() { await closeBrowser(browser); proof.closed = true },
    }
  } catch (error) {
    await closeBrowser(browser)
    throw error
  }
}
