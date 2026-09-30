// Retrospective acceptance against an owned local stack, never historical evidence.
import assert from 'node:assert/strict'
import { join } from 'node:path'

export function createPresentationChecks({
  browser, page, context, expect, qa, server, web, demo, mid,
  report, save, check, capture, snapshot, card, selected, inspectNative,
}) {
  const themeKey = 'ecorp.console.theme', modeKey = 'ecorp.console.mode'
  const desktop = { width: 1440, height: 1050 }
  const mode = () => page.locator('#console-mode')
  const theme = () => page.locator('#console-theme')
  const executive = () => page.locator('.executive-dashboard')
  const writes = []
  let activeHook = null, missionTitle = ''
  report.presentation = {
    scope: 'Presentation checks on real owned native records. First-paint app blocking, preference peer and storage failure are explicitly controlled browser conditions.',
    writes, contrast: [], first_paint: [], office_palette: [],
    limitations: [
      'Computed contrast checks cover visible text with solid composited backgrounds and text-entry control boundaries; gradients, artwork, native widgets and group opacity require the saved visual inspection.',
      'A blocked-app first-paint capture verifies the browser canvas before React, while paint telemetry on the real app checks the theme before its first contentful paint. It cannot measure monitor hardware or operating-system chrome.',
      'Local development actor switches are fixture roles, not production authentication or human review.',
    ],
  }
  page.on('request', (request) => {
    if (activeHook && request.url().startsWith(server + '/') && !['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
      writes.push({ hook: activeHook, method: request.method(), path: new URL(request.url()).pathname })
    }
  })
  function permittedReadBootstrap(write) {
    return write.method === 'POST' && (write.path === '/api/demo/bootstrap' || write.path.endsWith('/ws-ticket'))
  }
  async function hook(name, action) {
    activeHook = name
    try {
      await action()
      assert.deepEqual(writes.filter((write) => write.hook === name && !permittedReadBootstrap(write)), [],
        'Presentation must not send operational writes')
      check('presentation_' + name + '_no_operational_writes', {
        operational_writes: 0, fixture_bootstrap_or_ticket_requests: writes.filter((write) => write.hook === name).length,
      })
    } finally { activeHook = null; save() }
  }
  async function chooseTheme(value) {
    await theme().selectOption(value)
    await expect(theme()).toHaveValue(value)
    await expect(page.locator('html')).toHaveAttribute('data-theme-preference', value)
    if (value !== 'system') await expect(page.locator('html')).toHaveAttribute('data-theme', value)
  }
  async function chooseMode(value, refresh = true) {
    await mode().selectOption(value)
    await expect(mode()).toHaveValue(value)
    await expect(page.locator('html')).toHaveAttribute('data-presentation', value)
    await expect(page.locator('.operations-workspaces')).toBeVisible({ visible: value === 'operations' })
    if (value === 'executive') {
      await expect(executive()).toBeVisible()
      if (refresh && await executive().getByText(/^Current work is unavailable\./).count()) {
        await executive().getByRole('button', { name: 'Refresh work', exact: true }).click()
        await expect(executive().getByText(/^Current work is unavailable\./)).toHaveCount(0)
      }
    } else await expect(executive()).toHaveCount(0)
  }
  async function missions() {
    if (await mode().inputValue() !== 'operations') await chooseMode('operations')
    await page.getByRole('link', { name: 'Missions', exact: true }).click()
    await expect(card()).toBeVisible()
  }
  async function select(run, actorId) {
    await missions()
    await page.locator('#mission-evidence-' + mid).selectOption(run.id)
    await selected(run, actorId)
  }
  const executiveMission = () => executive().locator('.executive-mission').filter({
    has: page.getByRole('heading', { name: missionTitle, exact: true }),
  })
  async function budgetText() {
    await expect(page.getByTestId('budget-overview')).toBeVisible()
    return {
      totals: await page.getByTestId('budget-overview-totals').innerText(),
      provenance: await page.getByTestId('budget-cost-provenance').innerText(),
    }
  }
  async function officePalette(label) {
    const result = await page.evaluate(() => {
      const color = (token) => {
        const probe = document.createElement('span')
        probe.style.backgroundColor = `var(${token})`
        document.body.append(probe)
        const resolved = getComputedStyle(probe).backgroundColor
        probe.remove()
        return resolved
      }
      const expected = {
        '.pixel-office': '--theme-surface',
        '.pixel-office-roster': '--theme-surface',
        '.pixel-office-statusline': '--theme-surface',
        '.pixel-office-toolbar': '--theme-raised',
        '.pixel-office-bottom': '--theme-raised',
      }
      return {
        theme: document.documentElement.dataset.theme,
        root: getComputedStyle(document.documentElement).backgroundColor,
        canvas: color('--theme-canvas'),
        rows: Object.entries(expected).map(([selector, token]) => {
          const element = document.querySelector(selector)
          return { selector, token, expected: color(token),
            observed: element ? getComputedStyle(element).backgroundColor : null }
        }),
      }
    })
    report.presentation.office_palette.push({ label, ...result }); save()
    assert.equal(result.root, result.canvas, 'Native page root must use the selected canvas token')
    for (const row of result.rows) assert.equal(row.observed, row.expected, 'Native office surface: ' + row.selector)
    check('presentation_' + label + '_semantic_palette', result)
  }
  async function contrast(label, scope = '.app-shell') {
    await page.evaluate(async () => {
      await document.fonts.ready
      await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())))
    })
    const result = await page.evaluate((selector) => {
      const root = document.querySelector(selector)
      if (!root) throw new Error('Contrast scope missing: ' + selector)
      const parse = (value) => {
        const parts = value.match(/[\d.]+/g)?.map(Number)
        return parts && /^rgba?\(/.test(value) ? [parts[0], parts[1], parts[2], parts[3] ?? 1] : null
      }
      const blend = (front, back) => front.slice(0, 3).map((n, i) => n * front[3] + back[i] * (1 - front[3]))
      const luminance = (rgb) => rgb.map((n) => n / 255).map((n) => n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4)
        .reduce((sum, n, i) => sum + n * [0.2126, 0.7152, 0.0722][i], 0)
      const ratio = (a, b) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05)
      const identify = (el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + '.' + [...el.classList].join('.')
      const background = (el) => {
        const layers = []
        for (let node = el; node; node = node.parentElement) {
          const style = getComputedStyle(node), color = parse(style.backgroundColor)
          if (style.backgroundImage !== 'none') return { skip: 'background-image', element: identify(node) }
          if (Number(style.opacity) < 1) return { skip: 'group-opacity', element: identify(node) }
          if (!color) return { skip: 'unparsed-color', element: identify(node) }
          layers.push(color)
          if (color[3] >= 1) break
        }
        let color = getComputedStyle(document.documentElement).colorScheme === 'dark' ? [18, 18, 18] : [255, 255, 255]
        for (const layer of layers.reverse()) color = blend(layer, color)
        return { color }
      }
      const readings = [], exceptions = [], boundaries = [], failures = []
      for (const el of [root, ...root.querySelectorAll('*')]) {
        const style = getComputedStyle(el), box = el.getBoundingClientRect()
        if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true, contentVisibilityAuto: true }) ||
          !box.width || !box.height || style.visibility !== 'visible' || el.closest('[hidden], [aria-hidden="true"], .sr-only') ||
          ['SCRIPT', 'STYLE', 'OPTION', 'SVG', 'PATH'].includes(el.tagName)) continue
        if (el.matches(':disabled') || el.closest('[inert]')) { exceptions.push({ element: identify(el), reason: 'inactive-control' }); continue }
        let text = [...el.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent).join('').trim()
        if (el.matches('input:not([type="radio"]):not([type="checkbox"]), textarea')) text = el.value || el.placeholder || ''
        if (el.tagName === 'SELECT') text = el.selectedOptions[0]?.textContent ?? ''
        const bg = background(el)
        if (text) {
          if (bg.skip) exceptions.push({ element: identify(el), reason: bg.skip, ancestor: bg.element, text: text.slice(0, 80) })
          else {
            const placeholder = el.matches('input,textarea') && !el.value && el.placeholder
            const fgStyle = placeholder ? getComputedStyle(el, '::placeholder') : style
            const color = parse(fgStyle.color)
            if (!color) exceptions.push({ element: identify(el), reason: 'unparsed-text-color' })
            else {
              color[3] *= Number(fgStyle.opacity)
              const size = parseFloat(style.fontSize), large = size >= 24 || (size >= 18.6667 && Number(style.fontWeight) >= 700)
              const reading = { element: identify(el), text: text.slice(0, 100), foreground: color, background: bg.color,
                ratio: ratio(blend(color, bg.color), bg.color), threshold: large ? 3 : 4.5 }
              readings.push(reading)
              if (reading.ratio < reading.threshold) failures.push({ kind: 'text', ...reading })
            }
          }
        }
        if (el.matches('select, textarea, input:not([type="radio"]):not([type="checkbox"]):not([type="hidden"])') && !bg.skip) {
          const outside = background(el.parentElement), border = parse(style.borderTopColor)
          if (!outside.skip && border && parseFloat(style.borderTopWidth) > 0 && style.borderTopStyle !== 'none') {
            const reading = { element: identify(el), border_ratio: ratio(blend(border, outside.color), outside.color),
              fill_ratio: ratio(bg.color, outside.color), threshold: 3 }
            boundaries.push(reading)
            if (Math.max(reading.border_ratio, reading.fill_ratio) < 3) failures.push({ kind: 'control-boundary', ...reading })
          } else exceptions.push({ element: identify(el), reason: 'native-or-unmeasured-control-boundary' })
        }
      }
      const rootStyle = getComputedStyle(document.documentElement), bodyStyle = getComputedStyle(document.body)
      return { theme: document.documentElement.dataset.theme,
        theme_preference: document.documentElement.dataset.themePreference,
        mode: document.documentElement.dataset.presentation,
        root: { color: rootStyle.color, background: rootStyle.backgroundColor },
        body: { color: bodyStyle.color, background: bodyStyle.backgroundColor },
        viewport: { width: innerWidth, height: innerHeight }, readings, boundaries, exceptions, failures }
    }, scope)
    report.presentation.contrast.push({ label, ...result }); save()
    report.presentation.contrast_status = report.presentation.contrast.some((sample) => sample.failures.length) ? 'failed' : 'passed'; save()
    return { measured_text: result.readings.length, measured_boundaries: result.boundaries.length, exceptions: result.exceptions.length }
  }
  async function disclosureContrast(label) {
    const details = card().locator('details.mission-dossier, details.task-graph-item, details.contract-revision-history, details.budget-history')
    const original = []
    try {
      assert.ok(await details.count() > 0, 'Expected actual mission disclosures')
      for (let index = 0; index < await details.count(); index++) {
        const detail = details.nth(index)
        const state = await detail.evaluate((el) => ({ open: el.open, class_name: el.className,
          summary: el.querySelector(':scope > summary')?.textContent?.trim() }))
        assert.ok(state.summary, 'Disclosure needs its actual summary control')
        original.push({ index, ...state })
        if (!state.open) await detail.locator(':scope > summary').click()
        await expect.poll(() => detail.evaluate((el) => el.open)).toBe(true)
      }
      await expect(card().locator('details.mission-briefing')).toBeVisible()
      await expect(card().locator('details.mission-task-dossier')).toBeVisible()
      assert.ok(await card().locator('details.task-graph-item').count() > 0)
      const measurements = await contrast(label + '-open-disclosures', '[data-mission-id="' + mid + '"]')
      await capture('presentation-' + label + '-open-disclosures')
      check('presentation_' + label + '_actual_open_disclosures', { states_before: original, ...measurements })
    } finally {
      for (const state of original.toReversed()) {
        const detail = details.nth(state.index)
        if (await detail.evaluate((el) => el.open) !== state.open) await detail.locator(':scope > summary').click()
        await expect.poll(() => detail.evaluate((el) => el.open)).toBe(state.open)
      }
      report.presentation.disclosure_restorations ??= []
      report.presentation.disclosure_restorations.push({ label, restored: original.length, states: original }); save()
    }
  }
  async function keyboardAndMobile(label) {
    await page.setViewportSize({ width: 390, height: 844 })
    await theme().focus()
    await page.keyboard.press('Tab')
    await expect(mode()).toBeFocused()
    const readFocus = () => mode().evaluate((el) => {
      const style = getComputedStyle(el), box = el.getBoundingClientRect()
      return { visible: el.matches(':focus-visible'), outline: style.outlineStyle, width: parseFloat(style.outlineWidth),
        color: style.outlineColor, offset: style.outlineOffset, left: box.left, right: box.right, top: box.top, bottom: box.bottom,
        viewport: innerWidth, document_width: document.documentElement.scrollWidth, scale: devicePixelRatio,
        reduced_motion: matchMedia('(prefers-reduced-motion: reduce)').matches }
    })
    // A viewport resize can settle between DOM measurement and screenshot capture.
    // Preserve every image and accept coordinates only when both observations agree.
    let focus, pixels, stable = false
    const observations = []
    for (let attempt = 1; attempt <= 3; attempt++) {
      await page.evaluate(async () => {
        await document.fonts.ready
        await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())))
      })
      const before = await readFocus()
      const filename = label + '-focus-pixels-' + attempt + '.png'
      pixels = await page.screenshot({ path: join(qa, 'evidence', filename) })
      const after = await readFocus()
      observations.push({ attempt, before, after, screenshot: filename })
      report.presentation.focus_capture_observations ??= []
      report.presentation.focus_capture_observations.push({ label, ...observations.at(-1) }); save()
      report.screenshots[label + '-focus-pixels-' + attempt] = filename; save()
      if (JSON.stringify(before) === JSON.stringify(after)) { focus = after; stable = true; break }
    }
    assert.equal(stable, true, 'Focus screenshot geometry must be stable before sampling')
    assert.equal(focus.scale, 1, 'This pixel sampler expects the owned context device scale of one')
    assert.equal(focus.visible, true); assert.equal(focus.outline, 'solid'); assert.ok(focus.width >= 3)
    assert.ok(focus.left >= 0 && focus.right <= 391 && focus.document_width <= 391)
    assert.equal(focus.reduced_motion, true)
    const focusContrast = await page.evaluate(async ({ data, bounds }) => {
      const image = new Image(); image.src = 'data:image/png;base64,' + data; await image.decode()
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height
      const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0)
      const x = Math.floor((bounds.left + bounds.right) / 2), offset = parseFloat(bounds.offset)
      const points = {
        ring: { x, y: Math.floor(bounds.top - offset - bounds.width / 2) },
        inside: { x, y: Math.floor(bounds.top - offset + 1) },
        outside: { x, y: Math.floor(bounds.top - offset - bounds.width - 1) },
      }
      const samples = Object.fromEntries(Object.entries(points).map(([key, point]) => {
        if (point.x < 0 || point.y < 0 || point.x >= image.width || point.y >= image.height) throw new Error('Focus sample is clipped')
        return [key, [...ctx.getImageData(point.x, point.y, 1, 1).data].slice(0, 3)]
      }))
      const luminance = (rgb) => rgb.map((n) => n / 255).map((n) => n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4)
        .reduce((sum, n, i) => sum + n * [0.2126, 0.7152, 0.0722][i], 0)
      const ratio = (a, b) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05)
      return { points, samples, inside_ratio: ratio(samples.ring, samples.inside), outside_ratio: ratio(samples.ring, samples.outside),
        threshold: 3, scope: 'Screenshot pixels at the top-center keyboard focus ring and its immediately adjacent inner/outer surfaces; this is not an all-controls accessibility certification.' }
    }, { data: pixels.toString('base64'), bounds: focus })
    focus.contrast = focusContrast
    report.presentation.focus ??= []; report.presentation.focus.push({ label, ...focus }); save()
    assert.ok(focusContrast.inside_ratio >= 3 && focusContrast.outside_ratio >= 3, 'Focused mode control must contrast with both adjacent surfaces')
    await capture(label + '-390px-keyboard')
    check(label + '_390px_focus_reduced_motion', focus)
    await page.setViewportSize(desktop)
  }
  async function preferencePeer() {
    const peer = await context.newPage()
    await peer.route(web + '/__issue264_preferences_peer', (route) => route.fulfill({
      status: 200, contentType: 'text/html', body: '<!doctype html><title>Owned preference test peer</title>',
    }))
    await peer.goto(web + '/__issue264_preferences_peer')
    return peer
  }
  const peerSet = (peer, key, value) => peer.evaluate(({ key, value }) => localStorage.setItem(key, value), { key, value })
  async function firstPaint() {
    await hook('first_paint', async () => {
      for (const spec of [
        { name: 'system-dark', system: 'dark', preference: null, resolved: 'dark' },
        { name: 'system-light', system: 'light', preference: null, resolved: 'light' },
        { name: 'explicit-light-on-dark', system: 'dark', preference: 'light', resolved: 'light' },
        { name: 'explicit-dark-on-light', system: 'light', preference: 'dark', resolved: 'dark' },
      ]) {
        const first = await browser.newContext({ viewport: { width: 800, height: 600 }, colorScheme: spec.system, reducedMotion: 'reduce' })
        try {
          await first.addInitScript(({ themeKey, modeKey, preference }) => {
            if (preference) localStorage.setItem(themeKey, preference)
            localStorage.setItem(modeKey, 'executive')
          }, { themeKey, modeKey, preference: spec.preference })
          await first.route('**/*', (route) => {
            const request = route.request()
            if (!request.url().startsWith(web + '/') && !request.url().startsWith('data:')) return route.abort()
            if (request.resourceType() === 'script' && !new URL(request.url()).pathname.endsWith('/presentation-preferences.js')) return route.abort()
            return route.continue()
          })
          const firstPage = await first.newPage()
          await firstPage.goto(web + '/', { waitUntil: 'domcontentloaded' })
          await expect(firstPage.locator('html')).toHaveAttribute('data-theme', spec.resolved)
          const state = await firstPage.evaluate(() => ({
            preferences: window.ecorpPresentation.getSnapshot(), root_children: document.getElementById('root').childElementCount,
            color_scheme: getComputedStyle(document.documentElement).colorScheme,
          }))
          assert.equal(state.root_children, 0); assert.equal(state.color_scheme, spec.resolved)
          assert.equal(state.preferences.mode, 'executive')
          const filename = 'presentation-first-paint-' + spec.name + '.png'
          const bytes = await firstPage.screenshot({ path: join(qa, 'evidence', filename) })
          const pixel = await firstPage.evaluate(async (data) => {
            const image = new Image(); image.src = 'data:image/png;base64,' + data; await image.decode()
            const canvas = document.createElement('canvas'); canvas.width = 1; canvas.height = 1
            const canvasContext = canvas.getContext('2d'); canvasContext.drawImage(image, 0, 0)
            return [...canvasContext.getImageData(0, 0, 1, 1).data]
          }, bytes.toString('base64'))
          assert.ok(spec.resolved === 'dark' ? Math.max(...pixel.slice(0, 3)) < 100 : Math.min(...pixel.slice(0, 3)) > 200,
            'Pre-React browser canvas must use the selected theme')
          report.screenshots['presentation-first-paint-' + spec.name] = filename
          report.presentation.first_paint.push({ ...spec, ...state, pixel, screenshot: filename }); save()
        } finally { await first.close() }
      }
      const unavailable = await browser.newContext({ viewport: desktop, colorScheme: 'dark', reducedMotion: 'reduce' })
      try {
        const extraWrites = []
        unavailable.on('request', (request) => {
          if (request.url().startsWith(server + '/') && !['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
            extraWrites.push({ method: request.method(), path: new URL(request.url()).pathname })
          }
        })
        await unavailable.route('**/*', (route) => [web + '/', server + '/', 'data:', 'blob:'].some((prefix) => route.request().url().startsWith(prefix)) ? route.continue() : route.abort())
        await unavailable.addInitScript(() => {
          Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('Owned storage failure', 'SecurityError') } })
          window.__presentationPaints = []
          new PerformanceObserver((list) => window.__presentationPaints.push(...list.getEntries().map((entry) => ({
            name: entry.name, startTime: entry.startTime, theme: document.documentElement.dataset.theme,
            preference: document.documentElement.dataset.themePreference,
          })))).observe({ type: 'paint', buffered: true })
        })
        const unavailablePage = await unavailable.newPage()
        await unavailablePage.goto(web + '/', { waitUntil: 'networkidle' })
        await expect(unavailablePage.locator('.live-live')).toBeVisible()
        await expect(unavailablePage.getByText('Preferences apply in this tab; browser storage is unavailable.', { exact: true })).toBeVisible()
        await unavailablePage.locator('#console-theme').selectOption('light')
        await unavailablePage.locator('#console-mode').selectOption('executive')
        await expect(unavailablePage.locator('html')).toHaveAttribute('data-theme', 'light')
        await expect(unavailablePage.locator('.executive-dashboard')).toBeVisible()
        const paints = await unavailablePage.evaluate(() => window.__presentationPaints)
        assert.ok(paints.some((paint) => paint.name === 'first-contentful-paint'))
        assert.ok(paints.every((paint) => paint.theme === 'dark' && paint.preference === 'system'))
        assert.deepEqual(extraWrites.filter((write) => !permittedReadBootstrap(write)), [])
        report.presentation.storage_failure = { paints, allowed_bootstrap_requests: extraWrites.length, operational_writes: 0 }
        const filename = 'presentation-storage-unavailable.png'
        await unavailablePage.screenshot({ path: join(qa, 'evidence', filename), fullPage: true })
        report.screenshots['presentation-storage-unavailable'] = filename; save()
      } finally { await unavailable.close() }
      check('presentation_first_paint_system_overrides_and_storage_failure')
    })
  }
  async function ready() {
    await hook('ready', async () => {
      const initial = (await snapshot()).snapshot
      missionTitle = initial.missions.find((mission) => mission.id === mid).title
      await page.emulateMedia({ colorScheme: 'dark' })
      await chooseTheme('system'); await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
      await page.emulateMedia({ colorScheme: 'light' }); await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
      await chooseTheme('dark'); await page.emulateMedia({ colorScheme: 'light' })
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
      await chooseMode('executive'); await chooseTheme('light')
      await page.reload({ waitUntil: 'networkidle' }); await expect(page.locator('.live-live')).toBeVisible()
      await expect(mode()).toHaveValue('executive'); await expect(theme()).toHaveValue('light')
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
      check('presentation_system_changes_override_and_independent_reload')
      await missions()
      if (await page.locator('#new-mission-button').isVisible()) await page.locator('#new-mission-button').click()
      const draft = { title: 'Owned presentation draft — never launch', description: 'Retain this exact unsent specification across presentation changes.' }
      await page.locator('#mission-title').fill(draft.title)
      await page.locator('summary').filter({ hasText: /^Additional details or a specification/ }).click()
      await page.locator('#mission-description').fill(draft.description)
      for (const value of ['dark', 'light']) {
        await chooseTheme(value); const budget = await budgetText()
        await chooseMode('executive'); assert.deepEqual(await budgetText(), budget)
        await expect(executiveMission()).toContainText(missionTitle)
        await expect(executiveMission()).toContainText('Task progress')
        await expect(executiveMission()).toContainText('Responsible team')
        await expect(executiveMission()).toContainText('No pull request recorded yet')
        await expect(executiveMission()).toContainText('Not published')
        assert.ok(!(await executive().innerText()).includes(mid), 'Executive defaults must not expose raw mission identifiers')
        await contrast('executive-ready-' + value); await capture('presentation-executive-ready-' + value)
        await keyboardAndMobile('presentation-executive-' + value)
        await chooseMode('operations')
        await expect(page.locator('#mission-title')).toHaveValue(draft.title)
        await expect(page.locator('#mission-description')).toHaveValue(draft.description)
      }
      check('presentation_drafts_and_shared_budget_survive_both_modes_and_themes', draft)
      const peer = await preferencePeer()
      try {
        await page.getByRole('button', { name: 'Connect a repository or coding agent', exact: true }).click()
        const dialog = page.getByRole('dialog', { name: 'Connect a project', exact: true })
        await expect(dialog).toBeVisible()
        await dialog.getByRole('radio', { name: 'GitHub repository', exact: true }).check()
        await dialog.locator('#connection-repository').fill('owned-fixture/never-connected')
        await dialog.locator('summary').filter({ hasText: 'Connection options' }).click()
        await dialog.locator('#connection-label').fill('Unsubmitted owned connection draft')
        for (const value of ['dark', 'light']) {
          await peerSet(peer, themeKey, value)
          await expect(page.locator('html')).toHaveAttribute('data-theme', value)
          await contrast('connection-dialog-' + value, '.connections-dialog')
          await capture('presentation-connections-' + value)
          await peerSet(peer, modeKey, 'executive')
          await expect(page.locator('dialog[open]')).toHaveCount(0)
          await expect(executive()).toBeVisible(); await expect(mode()).toBeEnabled()
          await peerSet(peer, modeKey, 'operations')
          await expect(dialog).toBeVisible()
          await expect(dialog.locator('#connection-repository')).toHaveValue('owned-fixture/never-connected')
          await expect(dialog.locator('#connection-label')).toHaveValue('Unsubmitted owned connection draft')
        }
        await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0)
        check('presentation_native_dialog_releases_modality_and_keeps_draft_across_tabs')
        for (const value of ['light', 'dark']) {
          await chooseTheme(value)
          for (const [label, id] of [['Control floor', 'floor'], ['Factory', 'factory'], ['Missions', 'missions'], ['Comms', 'room'], ['Audit', 'activity']]) {
            await page.getByRole('link', { name: label, exact: true }).click()
            await expect(page.locator('#' + id)).toBeVisible()
            await contrast('workspace-' + id + '-' + value)
            if (id === 'floor') await officePalette('native-office-' + value)
            if (id === 'factory') {
              const queueItem = page.locator('.factory-queue button').first()
              await expect(queueItem).toBeVisible()
              await queueItem.hover()
              await contrast('factory-queue-hover-' + value, '.factory-queue')
              await queueItem.focus()
              await contrast('factory-queue-focus-' + value, '.factory-queue')
            }
            await capture('presentation-' + id + '-' + value)
          }
          await keyboardAndMobile('presentation-operations-' + value)
        }
        await page.getByRole('link', { name: 'Control floor', exact: true }).click()
        // The crew class belongs to each button, not to its parent container.
        const crew = page.locator('.pixel-office-roster').getByRole('button', { name: /^Inspect / })
        await expect(crew.first()).toBeVisible()
        await crew.first().click(); await expect(page.locator('.world-inspector')).toBeVisible()
        assert.equal(await page.evaluate(() => document.body.style.overflow), 'hidden')
        await peerSet(peer, modeKey, 'executive')
        await expect(page.locator('.world-inspector')).toBeHidden()
        assert.notEqual(await page.evaluate(() => document.body.style.overflow), 'hidden')
        await peerSet(peer, modeKey, 'operations')
        await expect(page.locator('.world-inspector')).toBeVisible()
        await page.locator('.world-inspector').getByRole('button', { name: 'Close', exact: true }).click()
        const inversions = await page.locator('.app-shell img').evaluateAll((elements) => elements.flatMap((el) => {
          for (let node = el; node; node = node.parentElement) if (getComputedStyle(node).filter.includes('invert(')) return [el.getAttribute('src')]
          return []
        }))
        assert.deepEqual(inversions, [])
        check('presentation_office_inspector_releases_scroll_and_artwork_is_not_inverted')
      } finally { await peer.close() }
      // The open setup intentionally replaces the mission cards. Verify the draft
      // before closing it, then wait for the exact persisted card to return.
      await page.getByRole('link', { name: 'Missions', exact: true }).click()
      await expect(page.locator('#missions')).toBeVisible()
      await expect(page.locator('#mission-title')).toHaveValue(draft.title)
      await expect(page.locator('#mission-description')).toHaveValue(draft.description)
      await page.getByRole('button', { name: 'Close setup', exact: true }).click()
      await expect(card()).toBeVisible()
      assert.equal((await snapshot()).snapshot.runs.length, initial.runs.length)
      await chooseTheme('light'); await page.setViewportSize(desktop)
    })
  }
  async function pending(waiting) {
    await hook('pending', async () => {
      const originalRun = await page.locator('#mission-evidence-' + mid).inputValue()
      for (const value of ['light', 'dark']) {
        await chooseTheme(value); const budget = await budgetText(); await chooseMode('executive')
        assert.deepEqual(await budgetText(), budget)
        for (const run of waiting.runs) {
          const task = waiting.tasks.find((candidate) => candidate.id === run.task_id)
          const alert = executive().locator('.executive-attention li').filter({ hasText: task.title }).first()
          await expect(alert).toBeVisible(); await expect(alert).toContainText(/review|approval|decision/i)
          await alert.getByRole('button', { name: 'Inspect in Operations', exact: true }).click()
          await selected(run, demo.alice_actor_id)
          await expect(card().getByRole('button', { name: 'Accept evidence', exact: true })).toBeDisabled()
          await chooseMode('executive')
        }
        await contrast('executive-pending-' + value); await capture('presentation-executive-pending-' + value)
        await chooseMode('operations')
      }
      await chooseMode('executive')
      const disconnected = await page.evaluate(() => {
        const transport = window.__issue260Transport; transport.blocked = true
        const sockets = [...transport.sockets].filter((socket) => socket.readyState < WebSocket.CLOSING)
        sockets.forEach((socket) => socket.close(1000, 'Owned presentation reconnect'))
        return sockets.length
      })
      assert.ok(disconnected > 0); await expect(page.locator('.live-live')).toHaveCount(0)
      await expect(executive().getByText(/^Current work is unavailable\./)).toBeVisible()
      await capture('presentation-executive-disconnected')
      await chooseMode('operations'); await expect(page.locator('.live-live')).toHaveCount(0)
      await chooseMode('executive', false); await expect(executive().getByText(/^Current work is unavailable\./)).toBeVisible()
      await page.evaluate(() => { window.__issue260Transport.blocked = false })
      await expect(page.locator('.live-live')).toBeVisible({ timeout: 20000 })
      await expect(executive().getByText(/^Current work is unavailable\./)).toHaveCount(0)
      await chooseMode('operations'); await select(waiting.runs.find((run) => run.id === originalRun), demo.alice_actor_id)
      await chooseTheme('light'); await page.setViewportSize(desktop)
      check('presentation_pending_decisions_exact_drilldowns_and_reconnect_both_themes', { runs: waiting.runs.map((run) => run.id) })
    })
  }
  async function historical(run, actorId) {
    await hook('historical', async () => {
      for (const value of ['light', 'dark']) {
        await chooseTheme(value); await selected(run, actorId)
        await chooseMode('executive'); await expect(executiveMission()).toBeVisible()
        await chooseMode('operations'); await selected(run, actorId)
        const panel = card().getByTestId('inspect-provider')
        await expect(panel).toHaveAttribute('data-run-id', run.id)
        await expect(panel).toHaveAttribute('data-artifact-id', run.artifact_id)
        await expect(panel).toHaveAttribute('data-inspection-state', 'ready')
        await expect(card().getByTestId('inspect-source')).toHaveCount(0)
        await contrast('historical-provider-' + value, '[data-mission-id="' + mid + '"]')
        await capture('presentation-historical-provider-' + value)
        await disclosureContrast('historical-provider-' + value)
      }
      await chooseTheme('light'); await page.setViewportSize(desktop)
      check('presentation_historical_exact_provider_survives_themes_and_modes', { actor_id: actorId, run_id: run.id, artifact_id: run.artifact_id })
    })
  }
  async function completed(run, deliverable, actorId) {
    await hook('completed', async () => {
      for (const value of ['light', 'dark']) {
        await chooseTheme(value); await selected(run, actorId)
        const panel = card().getByTestId('inspect-source')
        await expect(panel).toHaveAttribute('data-artifact-id', deliverable.artifact_id)
        await expect(panel).toHaveAttribute('data-inspection-state', 'ready')
        const diff = () => panel.getByRole('region', { name: 'Source diff', exact: true })
        await expect(diff()).toBeVisible()
        const diffText = await diff().innerText()
        await contrast('source-manifest-code-diff-' + value, '[data-mission-id="' + mid + '"]')
        await capture('presentation-source-evidence-' + value)
        await disclosureContrast('source-manifest-code-diff-' + value)
        const budget = await budgetText(); await chooseMode('executive')
        assert.deepEqual(await budgetText(), budget)
        await expect(executiveMission()).toContainText('Recorded: Completed')
        // Preference changes preserve the loaded inspection and exact visible diff.
        await chooseMode('operations'); await selected(run, actorId)
        await expect(panel).toHaveAttribute('data-artifact-id', deliverable.artifact_id)
        await expect(panel).toHaveAttribute('data-inspection-state', 'ready')
        await expect(diff()).toBeVisible(); assert.equal(await diff().innerText(), diffText)
        check('presentation_' + value + '_pure_mode_toggle_preserves_source_diff', {
          actor_id: actorId, run_id: run.id, task_id: run.task_id, artifact_id: deliverable.artifact_id,
        })
        // Explicit navigation intentionally invalidates inspection; reread this artifact.
        for (const label of ['Inspect exact run', 'Inspect exact artifact']) {
          await chooseMode('executive')
          await executiveMission().getByRole('button', { name: label, exact: true }).click()
          await selected(run, actorId)
          await expect(card().getByTestId('inspect-provider')).toHaveAttribute('data-artifact-id', run.artifact_id)
          await expect(panel).toHaveAttribute('data-artifact-id', deliverable.artifact_id)
          await expect(panel).toHaveAttribute('data-inspection-state', 'idle')
          const proof = await inspectNative('source', run, deliverable, actorId)
          await expect(panel).toHaveAttribute('data-inspection-state', 'ready')
          await expect(diff()).toBeVisible(); assert.equal(await diff().innerText(), diffText)
          report.presentation.explicit_source_rereads ??= []
          report.presentation.explicit_source_rereads.push({ theme: value, drilldown: label, ...proof }); save()
        }
      }
      await chooseMode('executive')
      await executive().getByRole('button', { name: 'Browse authorized history in Operations', exact: true }).click()
      await expect(mode()).toHaveValue('operations'); await expect(page.locator('#activity')).toBeVisible()
      await select(run, actorId); await chooseTheme('light'); await page.setViewportSize(desktop)
      check('presentation_completed_exact_source_and_provider_drilldowns', { actor_id: actorId, run_id: run.id,
        provider_artifact_id: run.artifact_id, source_artifact_id: deliverable.artifact_id, source_sha256: deliverable.sha256 })
    })
  }
  async function denied(label, actorId) {
    await hook('denied_' + label, async () => {
      for (const value of ['light', 'dark']) {
        await chooseTheme(value); await chooseMode('executive')
        await expect(executiveMission()).toHaveCount(0)
        const text = await executive().innerText()
        assert.ok(!text.includes(missionTitle) && !text.includes(mid), 'Denied mission identity must not leak in Executive')
        await contrast('denied-' + label + '-' + value)
        await capture('presentation-denied-' + label + '-' + value)
        await chooseMode('operations'); await expect(card()).toHaveCount(0)
      }
      await chooseTheme('light')
      check('presentation_' + label + '_authorized_empty_both_modes_and_themes', { actor_id: actorId, denied_mission_id: mid })
    })
  }
  function assertContrast() {
    const failures = report.presentation.contrast.flatMap((sample) => sample.failures.map((failure) => ({ label: sample.label, ...failure })))
    assert.deepEqual(failures, [], 'Measured contrast failures; all readings and screenshots are retained')
    check('presentation_measured_contrast', { samples: report.presentation.contrast.length,
      text_readings: report.presentation.contrast.reduce((sum, sample) => sum + sample.readings.length, 0),
      boundary_readings: report.presentation.contrast.reduce((sum, sample) => sum + sample.boundaries.length, 0),
      exceptions: report.presentation.contrast.reduce((sum, sample) => sum + sample.exceptions.length, 0),
      scope: report.presentation.limitations[0] })
  }
  return { firstPaint, ready, pending, historical, completed, denied, contrast, keyboardAndMobile, assertContrast }
}
