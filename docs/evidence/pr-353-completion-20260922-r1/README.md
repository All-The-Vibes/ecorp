# PR #353 completion evidence

Date: September 22, 2026. Maintainer completion pass performed under the existing ECorp-only authorization.

Integrate current main and preserve explicit startup ownership. Read-only preflight validates existing identities and immutable source before starting or replacing any process; recovery and restart preserve the authorized enrollment and configured checkout.

All nine contributor checks and actual Windows startup/recovery acceptance pass, including a real Edge browser-to-server-to-native-runner verifier-policy flow. These are deterministic native fixtures, not production identity or vendor inference acceptance.

The nine required commands passed on source head `ab97fa24df40876ecd9fda722820851df45a95c2` with staged tree `6a84c1fa66aa555bde3da285dce7de1235f38cb5`, incorporating main `5f65e536f80e206082a8a819f2675c9b16210fce`. `validation.json` binds the commands, tool versions, statuses and log hashes. Local user and checkout paths in the published logs are normalized; original hashes are also retained. The evidence files added here are subsequent documentation of that tested tree, not a claim that a not-yet-existing commit was executed.

`validation.png` is a genuine Edge screenshot of `validation.html`, rendered from these saved results. It is a test-report capture, not an application screen. Full result lines, including opt-in ignored tests, remain in the logs. No original RED/GREEN development chronology is inferred from retrospective validation.

Reproduction: use an isolated checkout of the PR, install the repository-pinned Rust/Node/pnpm toolchain, run `pnpm install --frozen-lockfile`, and execute the nine commands listed in `validation.json`. Set `RUST_TEST_THREADS=1` for the recorded Windows test configuration. Build the repository's native `crony-mcp` binary and set `CRONY_MCP_TEST_BINARY` to that owned binary for native MCP unit coverage. These results do not substitute for fresh hosted checks, required independent reviews, or production identity/provider acceptance.

Maintainer self-review: inspected the final implementation and its current-main integration against the product, architecture, security and evaluation contracts. Only evidence documented here is claimed; existing historical reports retain their original scope and limitations.

Native Git received `core.longpaths=true` through process-only Git configuration for the recorded commands. Repository and global Git configuration were not changed.

Build provenance: Workspace package artifacts are removed under the task Cargo mutex before Rust validation. Third-party dependency cache is retained. Node tests use a freshly built copied native MCP binary. `validation.json` also binds the workspace-refresh and MCP-build logs, their original/published hashes, and the copied MCP binary hash.

Retry provenance: Initial matching-source Rust checks passed. The private validation helper then requested a nonexistent Cargo package, crony-mcp. The correct package is crony-gateways with binary crony-mcp. The initial checks are retained byte-for-byte; the auxiliary binary is rebuilt from the unchanged source after refreshing workspace artifacts, then the four remaining checks run.

The first failed receipt and failed-command logs are preserved under `prior-attempts/`; normalization and separate original/published hashes are recorded in `validation.json`. Successful command logs were retained byte-for-byte before publication normalization.

Actual native startup acceptance checks valid and rejected read-only preflight without changing database rows, files, ACLs, source or credentials. Initial startup owns three ready processes; repeated start retains them; an invalid restart leaves all identities intact; missing-web recovery replaces only web. Explicit restart replaces the three owned processes while preserving the original enrollment. The actual Edge flow accepts a passing run and rejects a failing verifier policy. Source HEAD, index and worktree bytes stay unchanged; original refs remain, and the new isolated task refs match observed task/run IDs. Credential rotation is checked against the database and original actor/corp/runner enrollment.

The first private driver incorrectly demanded identical scoped credential bytes and no new task refs after real runner work. Its failure is preserved. The corrected driver checks the product's intentional credential rotation and isolated refs. The source tree and native binary hashes did not change; the successful original native build is explicitly reused, not represented as rerun.

The recorded-drivers directory preserves the exact driver structure used on this machine, with paths normalized and separately hashed. These records are not claimed to run unchanged on an arbitrary checkout. To reproduce, use a new isolated Windows fixture and the recorded tools, provision owned PostgreSQL, build the recorded source with cargo build --workspace, and run the corresponding driver after substituting its explicit local paths. Supply the original internal validation receipt format (staged_tree) from a fresh nine-gate run; the published validation.json uses tested_staged_tree for the same recorded value. The driver requires its source tree to match that fresh receipt before adding evidence. Use the existing tools/qa_factory_run_activity.ps1 or the recorded specialized stack driver, deterministic native providers and the installed Edge browser. No external accounts, provider calls or publication credentials are required. All owned services were stopped after acceptance; database, credentials, source, workspaces and logs remain preserved privately.

Trailing line whitespace and blank lines at EOF are removed from the published logs. This formatting normalization does not alter test-result text; original and published hashes are distinct. The local `.gitattributes` preserves published evidence bytes on checkout.
