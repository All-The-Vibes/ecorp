---
title: Select an installed verifier browser
description: Host-scoped browser selection using native Playwright and existing command verification.
---

## Native capability and scope

Playwright already supports `chromium.executablePath()` and
`chromium.launch({ executablePath })`. The missing behavior in #136 was explicit
host selection, preflight validation and evidence, not another browser or runner
execution engine.

[`tools/verifier_browser.mjs`](../tools/verifier_browser.mjs) reads an
operator-controlled policy outside the task workspace. It returns native
Playwright launch options and browser-selection evidence. It does not launch a
shell, install packages, download browsers, change the application, or fall back
to another executable. The existing persisted `command` verifier runs the
browser verifier and records its exit status/output as before. No new wire
fields, runner capability or cache behavior are introduced.

## Host policy

Store this JSON outside the source/task workspace with permissions restricted
to its operator. Replace the host, platform, executable and hash with values
verified on the intended runner. A path or digest is not permission to use a
different owner's host.

```json
{
  "version": 1,
  "host": "YOUR-RUNNER-HOSTNAME",
  "platform": "win32",
  "browser": "edge",
  "executable": "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "sha256": "REPLACE_WITH_64_LOWERCASE_HEX_DIGITS"
}
```

Use Node's `os.hostname()` for the exact host identity and `Get-FileHash` for
the executable hash on Windows. Explicitly review a replacement pin after a
browser update; a mismatch fails rather than silently choosing a new browser.

Supported selection:

| Browser | Windows example | Linux example | macOS example |
|---|---|---|---|
| Chrome | `C:\Program Files\Google\Chrome\Application\chrome.exe` | `/usr/bin/google-chrome` | `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` |
| Edge | `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe` | `/usr/bin/microsoft-edge` | `/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge` |
| Chromium | Explicit `chrome.exe`, `chromium.exe` or `headless_shell.exe` | Explicit `chrome`, `chromium`, `chromium-browser` or `headless_shell` | Explicit `Chromium`, `chrome-headless-shell` or `headless_shell` |

Use platform `linux` or `darwin` on those hosts. Native installation locations
are examples, not a filesystem/PATH scan or an automatic fallback order. For
Playwright-managed Chromium, select `chromium`, omit `executable`, and supply
the installed Chromium's native `executablePath()` to the resolver. Its hash is
still required. No installed managed browser means a failure, not a download.

Policies are limited to 8192 bytes. Only the listed fields are accepted. Paths
are literal, absolute and limited to 1024 characters. The policy must be a
regular, unlinked file. Both declared and resolved executable paths must be
outside the task workspace; the resolved executable must have a supported name,
be a readable regular file, be executable on Unix, and match the hash.
The resolver rejects directories, pipes and other special files before opening
them. Unix reads also use nonblocking, no-follow flags so a replaced path cannot
block on a pipe or follow a new symlink. The opened policy and executable must
still match the inspected file's identity and size; reads check for mutation.
Windows network-share paths are not supported. A known browser filename is not
a signature check; the authorized hash and operator-controlled installation
remain essential.

## Arcade verifier

Set `CRONY_VERIFIER_BROWSER_POLICY` in the trusted verifier environment to the
absolute policy path. Keep the existing installed `CRONY_PLAYWRIGHT_MODULE`.
The arcade verifier resolves the browser before creating evidence or running
the application workflow. Its JSON report adds browser host/platform, selection
mode, canonical executable, executable SHA-256, policy SHA-256 and browser
version. Screenshot and workflow assertions remain unchanged.

The persisted command remains an argument array, for example:

```json
{
  "type": "command",
  "program": "node",
  "args": ["C:\\trusted-verifiers\\verify_arcade_browser.mjs", "arcade"],
  "timeout_ms": 120000
}
```

Copy the helper beside the trusted verifier when deploying that script. Do not
read a provider-authored policy from the task worktree. Retain the report with
the verification artifacts; selection metadata alone is not passing workflow
evidence.

For compatibility, an **unset** policy variable retains the arcade verifier's
previous `channel: 'chrome'` behavior and records `legacy-chrome-channel`.
An explicitly set but empty or invalid policy fails; it never falls back to
the legacy path. This preserves existing policies while making new selection
an explicit opt-in.

## Credit Exception and Python verifiers

The same resolver provides a language-neutral preflight CLI:

```powershell
node C:\trusted-verifiers\verifier_browser.mjs --policy C:\operator\browser.json
```

For managed Chromium, additionally pass `--chromium-executable` followed by
the Python Playwright `chromium.executable_path` value as one argument.

The #117 verifier owner can replace the temporary in-memory launcher override
with a normal launcher implementation that:

1. Runs this preflight using a subprocess argument array, no shell, a bounded
   timeout and checked exit status, before starting the application workflow.
2. Parses its JSON result. Maps `launchOptions.executablePath` to Playwright
   Python's native `executable_path`, and retains `headless` and `timeout`.
3. Calls the existing `chromium.launch` with those native options, without
   monkey-patching Playwright or changing the application.
4. Includes the returned `evidence` and actual browser version in the existing
   verification report, then runs the unchanged desktop/mobile assertions.

This does not revise #117's frozen policy, tests, source, budget or acceptance
history automatically. That owner must authorize adoption and re-run the
retained workflow before removing its workaround.

## Validation and boundaries

Run the offline suite with:

```powershell
node --test tools\verifier_browser.test.mjs
```

Run the opt-in native browser workflow with:

```powershell
$env:CRONY_BROWSER_TEST_WORKTREE = 'C:\owned\isolated-issue136-worktree'
$env:CRONY_BROWSER_TEST_OUTPUT = 'C:\owned\evidence\issue136'
$env:CRONY_PLAYWRIGHT_MODULE = 'C:\installed\playwright-core'
$env:CRONY_VERIFIER_BROWSER_POLICY = 'C:\operator\browser.json'
node tools\e2e_verifier_browser.mjs
```

The fixture requires a separately owned Git worktree, creates a temporary
test application there, and retains browser reports/screenshots in the explicit
output directory. It uses no provider, application database, remote page or
browser download. Test HTML is a deterministic verifier fixture, not a delivered
game or ECorp browser-to-server-to-runner acceptance.

Host-name binding is an operator guard, not authenticated machine identity or
OS isolation. Hash evidence identifies the executable at preflight, not every
browser DLL/resource or a guarantee against privileged replacement races.
Playwright warns that non-bundled versions may be incompatible; launch errors
remain failures. Windows tests do not establish native Linux/macOS acceptance.
The special-file regression suite runs directory cases on all supported hosts.
The declared and managed browser FIFO cases require a native Unix host and are
explicitly skipped on Windows; a Windows pass does not qualify those cases.
