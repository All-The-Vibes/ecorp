// Synthetic geometry probe of the actual App and styles; no server or runner effects.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { officeFixture, exerciseOffice } from './issue264-office-interactions-r1.mjs'

const evidence = dirname(fileURLToPath(import.meta.url))
const product = '<USERPROFILE>/.codex/worktrees/issue264-modes/ecorp'
const output = join(evidence, 'issue264-viewport-probe-r4')
assert.ok(!existsSync(output), 'Preserve the prior attempt')
mkdirSync(output)
const report = { started_at: new Date().toISOString(), scope: 'Actual App and CSS with intercepted empty and populated synthetic development snapshots and production connection response. The populated roster covers all eight office states with no live server or runner effects. No native acceptance or authorization claims.', cases: [], assertions: [], failures: [], requests: [], errors: [], unexpected: [], screenshots: [], status: 'running' }
const hash = value => createHash('sha256').update(value).digest('hex')
report.source = Object.fromEntries(['src/App.tsx', 'src/Accessible.css', 'src/index.css', 'src/ConsoleTheme.css', 'src/OfficeFloor.css', 'src/OfficeFloor.tsx', 'public/presentation-preferences.js'].map(name => [name, hash(readFileSync(join(product, 'apps/web', name)))]))
const check = (condition, name, observed) => { const result = { name, passed: Boolean(condition), observed }; report.assertions.push(result); if (!result.passed) report.failures.push(result) }
const save = () => writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n')
save()
const require = createRequire(join(product, 'apps/web/package.json'))
const { createServer } = await import(pathToFileURL(require.resolve('vite')))
const runtime = '<USERPROFILE>/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'
const { chromium } = await import(pathToFileURL(join(runtime, 'index.mjs')))
const { expect } = await import(pathToFileURL(join(runtime, 'test.mjs')))
const server = 'http://127.0.0.1:43997'
let vite, browser
try {
  vite = await createServer({ root: join(product, 'apps/web'), envDir: output, cacheDir: join(output, 'vite-cache'), logLevel: 'warn',
    define: { 'import.meta.env.VITE_CRONY_SERVER_HTTP': JSON.stringify(server) }, server: { host: '127.0.0.1', port: 0, strictPort: true } })
  await vite.listen()
  const web = 'http://127.0.0.1:' + vite.httpServer.address().port
  report.owned_web = web
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  const demo = { corp_id: 'geometry-corp', room_id: 'geometry-room', alice_actor_id: 'geometry-alice', bob_actor_id: 'geometry-bob', eve_actor_id: 'geometry-eve', manager_agent_id: '', worker_agent_id: '', codex_agent_id: '' }
  const snapshot = { snapshot: Object.fromEntries(['agents', 'missions', 'mission_contract_revisions', 'mission_budget_revisions', 'tasks', 'runs', 'room_messages', 'leases', 'queued_messages', 'verification_evidence', 'verification_requests', 'source_deliverables', 'pull_request_publications', 'pull_request_publication_attempts', 'action_approvals', 'circuit_breaker_incidents', 'factory_work_items', 'factory_controllers', 'factory_verification_recoveries', 'events'].map(key => [key, []])), runners: [] }
  Object.assign(snapshot.snapshot, { corp: { id: demo.corp_id, name: 'Synthetic geometry Corp' }, rooms: [{ id: demo.room_id, corp_id: demo.corp_id, name: 'Geometry room', purpose: 'Viewport-only fixture' }], actors: [{ id: demo.alice_actor_id, name: 'Synthetic Alice', kind: 'human', corp_id: demo.corp_id, role: 'owner' }] })
  for (const width of [1440, 390]) {
    for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({ viewport: { width, height: 700 }, reducedMotion: 'reduce', serviceWorkers: 'block' })
      let production = false
      let returnedSnapshot = snapshot
      const holds = new Set()
      try {
        await context.addInitScript(({ theme, demo }) => {
          localStorage.setItem('ecorp.console.theme', theme)
          localStorage.setItem('ecorp.console.mode', 'operations')
          sessionStorage.setItem('ecorp_corp_id', demo.corp_id)
          sessionStorage.setItem('ecorp_actor_id', demo.alice_actor_id)
        }, { theme, demo })
        await context.route('**/*', async route => {
          const request = route.request(), url = new URL(request.url())
          if (url.origin === web && ['GET', 'HEAD'].includes(request.method())) return route.continue()
          if (url.origin !== server) { report.unexpected.push({ method: request.method(), origin: url.origin, path: url.pathname }); return route.abort() }
          report.requests.push({ method: request.method(), path: url.pathname, intercepted: true })
          const headers = { 'access-control-allow-origin': web, 'access-control-allow-headers': 'content-type, authorization', 'access-control-allow-methods': 'GET, POST, OPTIONS' }
          const json = value => route.fulfill({ status: 200, contentType: 'application/json', headers, body: JSON.stringify(value) })
          if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers })
          if (url.pathname === '/health') return json({ status: 'ok', mode: production ? 'production' : 'development' })
          if (url.pathname === '/api/demo/bootstrap' && request.method() === 'POST') return json(demo)
          if (url.pathname === `/api/corps/${demo.corp_id}/snapshot` && request.method() === 'GET') return json(returnedSnapshot)
          if (url.pathname === `/api/corps/${demo.corp_id}/delegated` && request.method() === 'GET') return json({ provider: 'entra', enabled: false, operations: [] })
          if (url.pathname === `/api/corps/${demo.corp_id}/rooms/${demo.room_id}/connections` && request.method() === 'GET') return json({ connections: [], operations: [], selected_connection_id: null })
          report.unexpected.push({ method: request.method(), origin: url.origin, path: url.pathname }); return route.abort()
        })
        await context.routeWebSocket('**/*', socket => {
          const url = new URL(socket.url())
          if (url.origin === web.replace('http:', 'ws:')) socket.connectToServer()
          else if (url.origin === server.replace('http:', 'ws:') && url.pathname === `/ws/corps/${demo.corp_id}`) socket.send(JSON.stringify({ type: 'ready', corp_id: demo.corp_id, replayed_through: 0 }))
          else { report.unexpected.push({ method: 'WEBSOCKET', origin: url.origin, path: url.pathname }); socket.close() }
        })
        const page = await context.newPage()
        page.on('pageerror', error => { report.errors.push(error.message); save() })
        await page.goto(web, { waitUntil: 'networkidle' })
        await expect(page.locator('.app-shell')).toBeVisible()
        const geometry = () => page.locator('.skip-link').evaluate(link => {
          const rect = link.getBoundingClientRect(), style = getComputedStyle(link)
          return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, bottom: rect.bottom, scrollY, viewportHeight: innerHeight, position: style.position, transform: style.transform, focused: document.activeElement === link, hash: location.hash }
        })
        for (const mode of ['operations', 'executive']) {
          await page.locator('#console-mode').selectOption(mode)
          await expect(page.locator('html')).toHaveAttribute('data-presentation', mode)
          await page.locator('#console-mode').blur()
          if (mode === 'operations') {
            const chrome = await page.evaluate(() => {
              const color = token => {
                const probe = document.createElement('span')
                probe.style.backgroundColor = `var(${token})`
                document.body.append(probe)
                const result = getComputedStyle(probe).backgroundColor
                probe.remove()
                return result
              }
              const surface = color('--theme-surface'), raised = color('--theme-raised')
              const rows = ['.pixel-office', '.pixel-office-roster', '.pixel-office-statusline', '.pixel-office-toolbar', '.pixel-office-bottom', '.pixel-office-empty'].map(selector => {
                const element = document.querySelector(selector)
                return { selector, background: element ? getComputedStyle(element).backgroundColor : null,
                  expected: ['.pixel-office-toolbar', '.pixel-office-bottom', '.pixel-office-empty'].includes(selector) ? raised : surface }
              })
              const artwork = document.querySelector('.pixel-office-backdrop')
              const canvas = document.querySelector('.pixel-office-canvas')
              return { rows, artwork: { src: artwork?.getAttribute('src'), filter: artwork ? getComputedStyle(artwork).filter : null,
                canvasFilter: canvas ? getComputedStyle(canvas).filter : null } }
            })
            for (const row of chrome.rows) check(row.background === row.expected, `${width}-${theme}-office-theme:${row.selector}`, row)
            check(chrome.artwork.src === '/assets/office/ecorp-studio-gemini.jpg' && chrome.artwork.filter === 'none' && chrome.artwork.canvasFilter === 'none', `${width}-${theme}-office-artwork-preserved`, chrome.artwork)
            report.cases.push({ width, theme, office_controls: chrome })
          }

          await page.evaluate(() => scrollTo(0, 0))
          const top = await geometry()
          await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight))
          const bottom = await geometry()
          const label = `${width}-${theme}-${mode}`
          await page.screenshot({ path: join(output, label + '-unfocused-viewport.png') })
          report.screenshots.push(label + '-unfocused-viewport.png')
          await page.locator('.skip-link').focus()
          const focused = await geometry()
          await page.screenshot({ path: join(output, label + '-focused-viewport.png') })
          report.screenshots.push(label + '-focused-viewport.png')
          await page.keyboard.press('Enter')
          const activated = await page.evaluate(() => ({ hash: location.hash, focusedId: document.activeElement?.id, scrollY }))
          const item = { width, theme, mode, top, bottom, focused, activated }
          report.cases.push(item); save()
          assert.ok(top.bottom <= 0 && bottom.bottom <= 0, 'Unfocused link must be outside the actual viewport')
          assert.ok(focused.y >= 0 && focused.bottom <= focused.viewportHeight, 'Focused skip link is visible in the actual viewport')
          assert.equal(activated.focusedId, mode === 'operations' ? 'floor' : 'executive')
        }
        returnedSnapshot = officeFixture(snapshot, demo)
        await page.locator('#console-mode').selectOption('operations')
        await page.goto(web, { waitUntil: 'networkidle' })
        await expect(page.locator('.app-shell')).toBeVisible()
        await exerciseOffice({ page, expect, width, theme, check, report, save,
          capture: async label => { await page.screenshot({ path: join(output, label + '.png') }); report.screenshots.push(label + '.png'); save() } })
        returnedSnapshot = snapshot
        production = true
        await page.goto(web, { waitUntil: 'networkidle' })
        await expect(page.locator('.production-connect')).toBeVisible()
        const canvas = await page.evaluate(() => ({ rootBackground: getComputedStyle(document.documentElement).backgroundColor,
          bodyBackground: getComputedStyle(document.body).backgroundColor, theme: document.documentElement.dataset.theme, bodyTop: document.body.getBoundingClientRect().y, shellTop: document.querySelector('.loading-shell').getBoundingClientRect().y }))
        report.cases.push({ width, theme, production_connection_canvas: canvas })
        check(canvas.rootBackground === canvas.bodyBackground, `${width}-${theme}-connection-canvas`, canvas)
        await page.screenshot({ path: join(output, `${width}-${theme}-connection-viewport.png`) })
        report.screenshots.push(`${width}-${theme}-connection-viewport.png`)
        save()
      } finally { for (const release of holds) release(); await context.close() }
    }
  }
  assert.deepEqual(report.errors, [])
  assert.deepEqual(report.unexpected, [])
  assert.deepEqual(report.failures, [], 'Theme canvas and office controls must follow the selected semantic palette')
  report.status = 'passed'
} catch (error) { report.status = 'failed'; report.failure = String(error.stack ?? error); throw error }
finally {
  if (browser) await browser.close()
  if (vite) await vite.close()
  report.stopped = true; report.finished_at = new Date().toISOString(); save()
  console.log(JSON.stringify({ status: report.status, cases: report.cases.length, assertions: report.assertions.length, failures: report.failures.length, errors: report.errors, unexpected: report.unexpected, report: join(output, 'report.json') }))
}
