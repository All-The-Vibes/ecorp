---
title: Installed verifier browser validation
description: Source-scoped browser policy, native Edge workflow and repository validation for issue 136.
---

## Source and scope

Issue [#136](https://github.com/All-The-Vibes/ecorp/issues/136), based on
`30ec3fab6acd566cc1fc1e574c8a6343d0ce0596`.

The change adds an operator-controlled, host-scoped browser-policy resolver and
language-neutral preflight CLI, then opts the existing arcade verifier into
native Playwright executable selection. The default Chrome channel remains
unchanged when the policy variable is unset. See
[configuration and deployment](../VERIFIER_BROWSER.md).

No runner verifier, cache suppression, server admission, protocol, dependency
manifest or lockfile was changed. In particular, this does not integrate or
replace Dan's [#294](https://github.com/All-The-Vibes/ecorp/pull/294).

## Reproduction and focused results

The legacy `chromium.launch({ channel: 'chrome', headless: true })` failed on the
validation host because Chrome was absent. Its suggestion to install Chrome
was not followed. An explicit, hash-pinned installed Edge selection succeeded.
The installed Playwright-managed Chromium executable was also absent; no
browser was downloaded to manufacture a passing managed-browser result.

Environment: Windows, Node 26.7.0, Playwright Core 1.63.0, installed Edge
153.0.4234.32. The missing Playwright library was installed separately in private
test tooling with lifecycle scripts disabled; application dependencies and
browser installations were unchanged.

| Check | Result | Scope |
|---|---|---|
| `node --test tools/verifier_browser.test.mjs` | 22 passed, 0 failed, 0 skipped | Policy, paths, hash, byte limit, CLI and output failures |
| Native arcade verifier, module selection | Desktop 1280x800 and mobile 390x844 passed | Real headless Edge and unchanged verifier workflow |
| CLI selection equality and repeated arcade verifier | Both viewports passed again | CLI JSON equals the module's native launch configuration |
| Wrong host, wrong hash, missing executable commands | All exit 1 before evidence-directory creation | No application workflow or fallback |
| Fixture source and screenshots | Unchanged HTML; screenshot byte counts and SHA-256 checked | Exact fixture output, not an accepted application |

The offline suite covers declared Chrome/Edge paths on Windows, Linux and
macOS, managed-Chromium native path selection, paths with spaces, unknown
fields, unsupported executables, relative/network paths, empty executables,
hard-linked policies, outside-workspace restrictions and missing files.
An exact 8192-byte policy passes; an 8193-byte policy fails.

The stdout-EIO regression first failed: `console.log` swallowed the injected
write exception and the CLI exited zero. The CLI now writes directly to stdout
outside its expected-error handler. The same regression passes with the exact
EIO marker and exit 1; invalid policy diagnostics are not substituted.

## Reproduction

Use the explicit opt-in environment described in
[the operator guide](../VERIFIER_BROWSER.md#validation-and-boundaries), then run:

```powershell
node tools\e2e_verifier_browser.mjs
```

The driver retains per-run JSON, stdout/stderr and actual PNG files in the
chosen output directory. It removes only its newly created fixture directory.
No application database, provider run, retained manual stack or Factory
controller participates.

## Repository gates

All six required commands were run. Four gates passed; two failed. This is
not a green full repository gate.

| Gate | Result |
|---|---|
| `node tools/check_migrations.mjs` | Passed, 41 immutable migrations |
| `cargo fmt --check` | Passed |
| `cargo clippy --workspace --all-targets -- -D warnings` | Failed on the unchanged `crony-store/src/retained_provider_receipt.rs:50` `nonminimal_bool` warning |
| `cargo test --workspace` | Failed in the runner stage: 209 passed, 4 failed, 1 ignored; later workspace stages did not run |
| `pnpm build:web` | Passed |
| `pnpm lint:web` | Passed |

Three runner failures require Windows symlink privilege (OS error 1314):
`dangling_symlinks_cannot_create_external_files`,
`typed_directory_tool_rejects_relative_and_absolute_symlink_paths`, and
`all_operations_reject_linked_paths_and_protect_roots`. The fourth,
`issue190_late_stop_cancels_held_ack_without_acceptance_or_post_verifier_seal`,
timed out during the workspace run. Its exact same test binary passed an
isolated single-test rerun (1 passed, 213 filtered); that does not erase the
failed workspace gate or qualify the unrun stages.

The failing Rust source and all tracked manifests/lockfiles are unchanged.
No privileges were changed, strict warning policy was not relaxed, and no
failures or ignored tests are counted as passes. The original failing logs
remain alongside the final focused/browser receipts.

## Acceptance limits

* Real native browser evidence is Windows Edge only. Chrome and managed
  Chromium were absent; Linux/macOS path guards are offline tests, not native
  browser acceptance on those hosts.
* The fixture is a minimal deterministic interaction surface, not a game,
  real-vendor result or ECorp browser-to-server-to-runner acceptance.
* Python consumers receive a documented native option mapping through the CLI.
  The retained #117 verifier was not edited or rerun. Its owner still controls
  adopting the helper and removing the historical in-memory override.
* Host-name and executable-hash checks are not operating-system isolation,
  executable signature validation or a whole-browser-installation attestation.
* Review, branch publication, issue closure and merge remain separate effects.
