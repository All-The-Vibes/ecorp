import type { PresentationMode, PresentationPreferences as Preferences, ThemePreference } from './presentationPreferences'

export function PresentationControls({ preferences, onTheme, onMode }: {
  preferences: Preferences
  onTheme: (value: ThemePreference) => void
  onMode: (value: PresentationMode) => void
}) {
  return <fieldset className="presentation-preferences">
    <legend className="sr-only">Presentation preferences</legend>
    <label htmlFor="console-theme">Theme
      <select id="console-theme" value={preferences.theme} onChange={(event) => onTheme(event.target.value as ThemePreference)}>
        <option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option>
      </select>
    </label>
    <label htmlFor="console-mode">View
      <select id="console-mode" value={preferences.mode} onChange={(event) => onMode(event.target.value as PresentationMode)}>
        <option value="operations">Operations</option><option value="executive">Executive</option>
      </select>
    </label>
    {preferences.storageUnavailable ? <small role="status">Preferences apply in this tab; browser storage is unavailable.</small> : null}
  </fieldset>
}
