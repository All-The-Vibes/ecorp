// A blocking, same-origin bootstrap runs before the application or its styles.
// Only presentation preferences cross this boundary; no identity or task data.
(() => {
  const keys = { theme: 'ecorp.console.theme', mode: 'ecorp.console.mode' }
  const themes = ['light', 'dark', 'system']
  const modes = ['executive', 'operations']
  const listeners = new Set()
  const media = window.matchMedia('(prefers-color-scheme: dark)')
  let storageUnavailable = false
  const read = (key, allowed, fallback) => {
    try {
      const value = window.localStorage.getItem(key)
      return allowed.includes(value) ? value : fallback
    } catch {
      storageUnavailable = true
      return fallback
    }
  }
  let theme = read(keys.theme, themes, 'system')
  let mode = read(keys.mode, modes, 'operations')
  let snapshot
  const apply = () => {
    const resolvedTheme = theme === 'system' ? (media.matches ? 'dark' : 'light') : theme
    if (snapshot && snapshot.theme === theme && snapshot.mode === mode &&
      snapshot.resolvedTheme === resolvedTheme && snapshot.storageUnavailable === storageUnavailable) return
    snapshot = Object.freeze({ theme, mode, resolvedTheme, storageUnavailable })
    const root = document.documentElement
    root.dataset.theme = resolvedTheme
    root.dataset.themePreference = theme
    root.dataset.presentation = mode
    root.style.colorScheme = resolvedTheme
    const browserColor = document.querySelector('meta[name="theme-color"]')
    if (browserColor) browserColor.content = resolvedTheme === 'dark' ? '#151a20' : '#e8e8e4'
    for (const notify of listeners) notify()
  }
  const save = (key, value) => {
    try { window.localStorage.setItem(key, value) } catch { storageUnavailable = true }
  }
  window.ecorpPresentation = Object.freeze({
    getSnapshot: () => snapshot,
    subscribe(notify) { listeners.add(notify); return () => listeners.delete(notify) },
    setTheme(value) {
      if (!themes.includes(value)) return
      theme = value
      save(keys.theme, value)
      apply()
    },
    setMode(value) {
      if (!modes.includes(value)) return
      mode = value
      save(keys.mode, value)
      apply()
    },
  })
  media.addEventListener('change', apply)
  window.addEventListener('storage', (event) => {
    // Session storage and other applications' keys are not presentation state.
    try { if (event.storageArea !== window.localStorage) return } catch { return }
    if (event.key === null || event.key === keys.theme) theme = read(keys.theme, themes, 'system')
    if (event.key === null || event.key === keys.mode) mode = read(keys.mode, modes, 'operations')
    apply()
  })
  apply()
})()
