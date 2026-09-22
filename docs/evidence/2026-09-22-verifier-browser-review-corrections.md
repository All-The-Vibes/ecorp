# Browser-verifier review corrections

This is scoped PR325 correction evidence, not full-PR acceptance or NICE.
The original branch head was `1317618cef002977f0c56a5f075844d38e29eb20`;
the enclosing commit contains the tested corrections.

## Corrections and regression proof

| Finding | Correction | Behavioral RED | GREEN / independent integration |
| --- | --- | --- | --- |
| F01 | Forward only `CRONY_VERIFIER_BROWSER_POLICY` through the existing runner environment allowlist. | Six explicit-policy cases failed; genuine absence still passed. | Eight native Windows cases passed, then independently passed again with the combined correction. |
| F02 | Retain failed fixtures, artifact bytes, child streams/statuses and discoverable diagnostics; remove only a verified successful fixture after retention. | Six retention cases failed; success control passed. | Seven real-process/filesystem fault cases passed, including copy, stream and summary collisions. |
| F03 | Reuse the same platform-path check for declared, managed and canonical browser paths. | Twenty-three path-contract failures. | Sixty resolver cases passed; combined Node run was 67 passed, zero failed/skipped. |

F01 exercises parser-extracted real startup declarations, the unchanged native
owned-process/environment module, a Node handoff shim and the actual verifier.
It deliberately stops at a launch observer: **not Rust runner or browser boot**.
F02 uses explicitly synthetic artifact bytes and child fault injection: those
`.png` fixture bytes are **not screenshots**. F03's excluded network/device
paths are safely mocked; local paths, hard links and junctions are real.
No real SMB share was contacted. Setup failures are retained separately from RED.

Reproduce the focused checks in an explicitly owned worktree:

```powershell
node --test --test-concurrency=2 --test-timeout=180000 tools/verifier_browser.test.mjs tools/e2e_verifier_browser_retention.test.mjs
pwsh -NoLogo -NoProfile -NonInteractive -File tools/local_stack_browser_policy_handoff.test.ps1 -NodePath (Get-Command node).Source -OutputDirectory (Join-Path $env:TEMP ("ecorp-browser-handoff-" + [guid]::NewGuid()))
```

## Actual browser fixture and genuine captures

On September 22, 2026, 12:18:32–12:18:42 UTC, the combined source also ran
`node tools/e2e_verifier_browser.mjs` with an explicit owned worktree/output,
installed Playwright module and a host-bound, SHA-256-pinned Edge policy outside
the worktree. Both module and CLI selection paths passed desktop and mobile
checks. Wrong hash, wrong host and missing executable each failed before evidence
writes. These are native Git/Edge/command-verifier results, **not ECorp full-stack**.

The following are new, actual module-path captures, not the historical images
or the synthetic fault-test artifacts. CLI-path captures were also retained.

| Capture | Measured viewport | SHA-256 |
| --- | --- | --- |
| [Desktop](assets/issue136-20260922/desktop.png) | 1280 × 800 | `affabab7182d6266091a7c4e1f1d9dd29ce7ae66efe87ea29fc7895d1a691b39` |
| [Mobile](assets/issue136-20260922/mobile.png) | 390 × 844, reduced motion | `33fe96484f16102f2e62d9f2fc1c10e9acca72adf9c6d8b96736b9202c4e3e60` |

Both cases retained keyboard focus, had no horizontal overflow, browser errors
or remote page requests, and ended in `ready`.

Configuration: Windows x64, Node 24.19.0, PowerShell 7.6.5, pnpm 11.19.0,
Rust 1.98.1 MSVC, Playwright 1.62.1 and Edge 153.0.4234.48.
Firmware is inapplicable; no provider SDK, production identity or real credential
was exercised. Child environments excluded ambient provider/GitHub credentials.

## Repository checks and remaining gates

All nine contributor commands were attempted. Migration check, formatting,
strict workspace/all-target Clippy, Rust workspace tests, web build and web lint
passed. Rust: **554 passed, zero failed, 343 ignored**. `pnpm check:docs`,
`pnpm test:unit` and `pnpm test:steward` were absent and actually exited 1.
These are unavailable gates, not passes or waivers.

The initial frozen/offline install failed native tarball-origin policy. An
existing approved exact-graph transport descriptor then passed native policy
without downloads or changes to committed versions/integrity. This older lock
already has SHA-1 entries; they were not newly weakened or described as SHA-512.
No `--trust-lockfile` or policy relaxation was used.

Whole-code checks ran before this evidence note/images were added. Every tested
input byte remained unchanged; no post-commit whole-workspace rerun is claimed.
F04's Unix special-file preflight issue remains **open**; no Linux FIFO test or
Docker restart occurred. These two browser captures do not satisfy screenshot
coverage for every test. Local SQLx/full-stack, required human/draft/current-head
CI/Copilot and full-template acceptance remain separate gates. No approval,
review dismissal, merge, live Factory/chain/Entra or retained-stack effect occurred.
