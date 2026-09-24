# PR #359 completion evidence

Date: September 22, 2026. Maintainer completion pass performed under the existing ECorp-only authorization.

Integrate current main with explicit, authorized, versioned agent pin/unpin operations. Idempotent replay binds the actor and exact operation, and automatic retirement respects saved plans, active assignments and live obligations.

All nine contributor checks, sixteen store and two server native SQLx regressions, and actual Edge plus CLI plus native-runner agent lifecycle acceptance pass. Five original captures show pin/unpin and preserved obligations. No external provider inference is claimed.

The nine required commands passed on source head `5bfb44015b1f97e21e768ea0054b26f16b83350d` with staged tree `f1d1dda252189e964cdf3037da9e682d39a695f6`, incorporating main `5f65e536f80e206082a8a819f2675c9b16210fce`. `validation.json` binds the commands, tool versions, statuses and log hashes. Local user and checkout paths in the published logs are normalized; original hashes are also retained. The evidence files added here are subsequent documentation of that tested tree, not a claim that a not-yet-existing commit was executed.

`validation.png` is a genuine Edge screenshot of `validation.html`, rendered from these saved results. It is a test-report capture, not an application screen. Full result lines, including opt-in ignored tests, remain in the logs. No original RED/GREEN development chronology is inferred from retrospective validation.

Reproduction: use an isolated checkout of the PR, install the repository-pinned Rust/Node/pnpm toolchain, run `pnpm install --frozen-lockfile`, and execute the nine commands listed in `validation.json`. Set `RUST_TEST_THREADS=1` for the recorded Windows test configuration. Build the repository's native `crony-mcp` binary and set `CRONY_MCP_TEST_BINARY` to that owned binary for native MCP unit coverage. These results do not substitute for fresh hosted checks, required independent reviews, or production identity/provider acceptance.

Maintainer self-review: inspected the final implementation and its current-main integration against the product, architecture, security and evaluation contracts. Only evidence documented here is claimed; existing historical reports retain their original scope and limitations.

Native Git received `core.longpaths=true` through process-only Git configuration for the recorded commands. Repository and global Git configuration were not changed.

Build provenance: Workspace package artifacts are removed under the task Cargo mutex before Rust validation. Third-party dependency cache is retained. Node tests use a freshly built copied native MCP binary. `validation.json` also binds the workspace-refresh and MCP-build logs, their original/published hashes, and the copied MCP binary hash.

The native store suite executes sixteen issue48 SQLx regressions, and the server suite executes two. Actual Edge acceptance has three phases and five unchanged captures. Alice pins; Bob unpins while eight retained ledgers, lease and message obligations remain intact. The CLI performs pin and exact replay. Native provider completion/termination, identity reuse, CLI unpin, saved-plan retention, replay after a newer state, second completion and eventual retirement all execute against the same owned PostgreSQL/server/runner stack. The retained snapshots also verify visibility, isolation and artifacts. Review checked operation UUID/version binding, current authority on replay, room membership locks and retirement serialization.

The recorded-drivers directory preserves the exact driver structure used on this machine, with paths normalized and separately hashed. These records are not claimed to run unchanged on an arbitrary checkout. To reproduce, use a new isolated Windows fixture and the recorded tools, provision owned PostgreSQL, build the recorded source with cargo build --workspace, and run the corresponding driver after substituting its explicit local paths. Supply the original internal validation receipt format (staged_tree) from a fresh nine-gate run; the published validation.json uses tested_staged_tree for the same recorded value. The driver requires its source tree to match that fresh receipt before adding evidence. Use the existing tools/qa_factory_run_activity.ps1 or the recorded specialized stack driver, deterministic native providers and the installed Edge browser. No external accounts, provider calls or publication credentials are required. All owned services were stopped after acceptance; database, credentials, source, workspaces and logs remain preserved privately.

Trailing line whitespace and blank lines at EOF are removed from the published logs. This formatting normalization does not alter test-result text; original and published hashes are distinct. The local `.gitattributes` preserves published evidence bytes on checkout.
