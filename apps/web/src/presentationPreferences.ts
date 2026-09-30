import { useSyncExternalStore } from 'react'

export type ThemePreference = 'light' | 'dark' | 'system'
export type PresentationMode = 'executive' | 'operations'
export type PresentationPreferences = Readonly<{
  theme: ThemePreference
  resolvedTheme: 'light' | 'dark'
  mode: PresentationMode
  storageUnavailable: boolean
}>

declare global {
  interface Window {
    ecorpPresentation: {
      getSnapshot: () => PresentationPreferences
      subscribe: (notify: () => void) => () => void
      setTheme: (theme: ThemePreference) => void
      setMode: (mode: PresentationMode) => void
    }
  }
}

/** The same store initializes first paint and follows native media/storage events. */
export function usePresentationPreferences() {
  const store = window.ecorpPresentation
  const preferences = useSyncExternalStore(store.subscribe, store.getSnapshot)
  return { preferences, setTheme: store.setTheme, setMode: store.setMode }
}
