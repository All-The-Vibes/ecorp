# PR226: current target integration evidence

September 21, 2026. This follow-up is new local integration evidence, not a
replacement for the historical PR226 packet or original Factory acceptance.
Issue #225's original native/TDD history is not reconstructed or relabeled.

## Exact source and scope

- Original remote head: `91704759df0859934500f30ef2542fa4b1fcab1d`.
- Integrated target: `410eddfc8bfcfa874dae05555128d39a914f0456`.
- Local merge commit: `ebaf582fc2fdd90c3c5eac2abacba46967917595`.
- Validated source tree: `6f027117897a8ec87673e98036fd4ea22de077af`.
- Isolated branch: `codex/pr226-gauntlet-20260921`.
- The merge retains both exact parents and changes only the nine target-integration
  paths recorded in the final readback. No additional product fix was authored.

The fresh commands below execute that integrated source, while writing this new
evidence directory. `source-inputs.json` binds every one of its 834 tracked input
files by exact working-byte SHA-256. The final preservation receipt checks all
those inputs again. The evidence commit necessarily adds its own receipts after
execution; it does not claim to have known its own future commit hash. Its diff
from the tested merge must contain only this new directory.

All 94 existing PR226 historical-evidence files, including the old screenshots,
are separately bound in `historical-evidence-before.json` and checked afterward.
None is relabeled current or modified.

## Fresh actual executions and captures

The command receipts, native console transcripts, and unmodified PNG captures
are versioned here. The final `results.json` is derived from the actual terminal
logs, not from expected results or older validation. All ten invocations exited
zero. The nine required contributor commands are unchanged.

| Fresh test suite | Passed | Failed | Skipped / ignored |
| --- | ---: | ---: | ---: |
| Node unit | 1,204 | 0 | 44 skipped |
| Steward | 227 | 0 | 0 |
| Rust workspace | 566 | 0 | 343 ignored |
| Canary behavior and literal Git bytes | 10 | 0 | 0 |

The migration checker verified 41 immutable migrations. Web lint reported zero
warnings/errors across 57 files; the TypeScript/Vite build passed.

| Command | Console transcript | Genuine terminal capture |
| --- | --- | --- |
| `node tools/check_migrations.mjs` | [log](logs/01-migrations.console.txt) | [PNG](captures/01-migrations.png) |
| `pnpm check:docs` | [log](logs/02-docs.console.txt) | [PNG](captures/02-docs.png) |
| `pnpm test:unit` | [log](logs/03-unit.console.txt) | [PNG](captures/03-unit.png) |
| `pnpm test:steward` | [log](logs/04-steward.console.txt) | [PNG](captures/04-steward.png) |
| `cargo fmt --check` | [log](logs/05-fmt.console.txt) | [PNG](captures/05-fmt.png) |
| `cargo clippy --workspace --all-targets -- -D warnings` | [log](logs/06-clippy.console.txt) | [PNG](captures/06-clippy.png) |
| `cargo test --workspace` | [log](logs/07-cargo-test.console.txt) | [PNG](captures/07-cargo-test.png) |
| `pnpm build:web` | [log](logs/08-web-build.console.txt) | [PNG](captures/08-web-build.png) |
| `pnpm lint:web` | [log](logs/09-web-lint.console.txt) | [PNG](captures/09-web-lint.png) |
| `node --test scenarios/factory-live-canary/status.test.mjs scenarios/factory-live-canary/git-bytes.test.mjs` | [log](logs/10-canary.console.txt) | [PNG](captures/10-canary.png) |

The additional [native Rust store-result capture](captures/07-cargo-store-result.png)
shows that invocation's real scrollback: 61 passed and 337 ignored, with the
SQLx ownership reasons visible. The ordinary Rust capture shows the final
doc-test tail and process exit; aggregate totals come from the complete log.

These are captures of **fresh native commands executing in Windows Terminal**,
not screenshots of a rendered report, copied transcript, HTML page or simulated
test output. `capture-gates-v1.ps1` runs each literal command and streams its
actual output through PowerShell `Tee-Object`, retaining the real exit code.
The command finishes before waiting for an own-window capture acknowledgement;
that wait does not extend any test timeout. Native console glyph-encoding
artifacts are retained unchanged rather than cosmetically rewriting the logs.
The silent formatting check has a literal zero-byte console transcript; see
[the packaging note](PACKAGING-NOTES.md) for why it was materialized separately.

`terminal-provenance.json` identifies the separate worker window and its Cua
launch. `capture-receipts.jsonl` binds each PNG to its exact HWND, owner PID,
capture time and SHA-256. Cua launched it with `start_minimized:false` through
its non-activating native route and captured that HWND with `get_window_state`.
No foreground delivery, desktop capture, other worker's window, or UI shell
shim was used. The first multiword-title launch failed before executing the
driver; its screenshot is retained as a **launch failure**, not a test result.

## Supported native configuration, not a source workaround

The original failures and narrowed diagnosis remain in
[RUST-ROOT-CAUSE.md](RUST-ROOT-CAUSE.md) and `prior-attempts/`.

1. Placing TEMP inside the checkout both exceeded native Git path limits and
   correctly violated the private-connection-state boundary. A fresh,
   worker-owned directory under the operating system's normal TEMP fixes that
   fixture-placement error without changing the security invariant.
2. The remaining held-ACK test also failed alone using the exact workspace test
   binary. Native Git tracing exposed `git bundle create` failing to stat its
   ref argument with `Filename too long`, before the upload event.
3. Installed Git for Windows documents the built-in `core.longpaths` option.
   The same binary and unchanged assertion passed with that option enabled.
   The complete workspace command then passed; its actual earlier and final
   receipts are retained separately.

The fresh run uses process-scoped `GIT_CONFIG_COUNT=1`,
`GIT_CONFIG_KEY_0=core.longpaths`, and `GIT_CONFIG_VALUE_0=true`. It writes no
system, global, repository or Windows policy setting. The affected test,
exporter and storage blobs are identical at original head, target and merged
source (`failure-source-attribution.json`).

No test was removed, newly skipped or filtered from the contributor commands.
No timeout or test-concurrency change, serial-suite substitution,
`COPILOT_SKIP_CLI_DOWNLOAD`, dependency integrity bypass or product-source fix
was used. The focused diagnostic runs are not substitutes for the full gate.

## Dependencies, confidentiality and remaining acceptance

The original native frozen/offline pnpm install reused 31 pinned packages and
downloaded zero. Its unchanged integration lockfile hashes and the initial
source-guard configuration diagnosis are retained. The old proxy descriptor
did not match this lock and was not copied or synthesized. Cargo uses the
existing registry cache offline, a worker-owned target directory, and the
published-hash-verified pinned SDK archive. No provider or production network
execution was performed.

`capture-environment-v1.json` records only allowlisted OS/tool paths and fixed
non-secret task configuration. Provider tokens, database routes, test opt-ins,
`NODE_OPTIONS` and `RUSTFLAGS` are excluded. This is environment hygiene, not
operating-system isolation. Environment audits disclose only names and checks,
never credential values.

Default skipped Node native-MCP tests and ignored Rust SQLx/native-probe tests
remain **unexecuted**, not passed. Exact counts and reasons are in `results.json`
and the logs. Windows execution does not establish other-platform behavior,
full browser/server/runner acceptance, original Factory/provider execution,
hosted CI, independent review, human approvals or publication.

RED is **not applicable** to this clean target integration. No historical or
new behavior-fix RED is fabricated. The parent must run a fresh independent
gauntlet against the final full PR. No push, PR review, merge, protection change
or manual-office operation is authorized by this packet.


## September 22, 2026 path normalization

The later maintainer pass replaced personal Windows user-root paths in 29 text
files in this integration packet with `<original-user>`. Historical transcripts
otherwise retain their original output; this normalization does not rerun or
upgrade the earlier acceptance. Prior hash receipts still identify the original
bytes. `path-normalization-20260922.json` records each original and published
SHA-256 separately, so those older hashes must not be compared to the normalized
copies. All PNG capture bytes and evidence outside this integration directory
remain unchanged. Original text bytes are retained in the private completion
archive. Statements above about unchanged logs describe their initial capture,
before this documented path normalization.
