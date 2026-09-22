# PR #338 completion evidence

Date: September 22, 2026. Maintainer completion pass performed under the existing ECorp-only authorization.

Integrated current main without rewriting history, explicitly superseded earlier unbound cached build evidence while preserving it, and rebuilt workspace artifacts before recording all nine gates. Replayed the previous predicate against Rust 1.94.0: strict Clippy fails there, the equivalent is_none_or predicate passes, and the five receipt behavior tests pass before and after.

Fresh source-bound Rust 1.98.1 workspace run includes 403 store tests: 66 passed and 337 explicitly ignored, including all five new retained-provider receipt regressions. Separate Rust 1.94.0 strict-Clippy controlled replay and behavior results are retained. This behavior-preserving predicate change needs no application-runtime claim.

The nine required commands passed on source head `856b04a8ef5c7d18e354b586a740d54241c34648` with staged tree `4d624caff3f86cca899f7138aa5d90e77dc15ecc`, incorporating main `5f65e536f80e206082a8a819f2675c9b16210fce`. `validation.json` binds the commands, tool versions, statuses and log hashes. Local user and checkout paths in the published logs are normalized; original hashes are also retained. The evidence files added here are subsequent documentation of that tested tree, not a claim that a not-yet-existing commit was executed.

`validation.png` is a genuine Edge screenshot of `validation.html`, rendered from these saved results. It is a test-report capture, not an application screen. Full result lines, including opt-in ignored tests, remain in the logs. No original RED/GREEN development chronology is inferred from retrospective validation.

Reproduction: use an isolated checkout of the PR, install the repository-pinned Rust/Node/pnpm toolchain, run `pnpm install --frozen-lockfile`, and execute the nine commands listed in `validation.json`. Set `RUST_TEST_THREADS=1` for the recorded Windows test configuration. Build the repository's native `crony-mcp` binary and set `CRONY_MCP_TEST_BINARY` to that owned binary for native MCP unit coverage. These results do not substitute for fresh hosted checks, required independent reviews, or production identity/provider acceptance.

Maintainer self-review: inspected the final implementation and its current-main integration against the product, architecture, security and evaluation contracts. Only evidence documented here is claimed; existing historical reports retain their original scope and limitations.

Native Git received `core.longpaths=true` through process-only Git configuration for the recorded commands. Repository and global Git configuration were not changed.

Build provenance: Workspace package artifacts are removed under the task Cargo mutex before Rust validation. Third-party dependency cache is retained. Node tests use a freshly built copied native MCP binary. `validation.json` also binds the workspace-refresh and MCP-build logs, their original/published hashes, and the copied MCP binary hash.

Actual Rust 1.94.0 controlled replay: former predicate fails strict Clippy with nonminimal_bool; equivalent corrected predicate passes. The same five receipt behavior tests pass both predicates. No original development timing is asserted.

`msrv-logs.json` binds the retained original and published log hashes.

Review 5280216092 requested source-bound replacement evidence. The previous cached workspace result did not include the five new tests and is explicitly superseded, with its bytes retained. This new run rebuilt workspace artifacts and reports 403 store tests: 66 passed, 337 explicitly ignored. All five retained-provider receipt regressions executed.

The separate Rust 1.94.0 run is an actual retrospective diagnostic RED/GREEN. The former negated `is_some_and` predicate fails strict workspace/all-target Clippy with `nonminimal_bool` (exit 101); the equivalent `is_none_or` predicate passes (exit 0). All five receipt behavior tests pass under both versions. This establishes lint compatibility and unchanged behavior, without inventing an original development sequence.

`msrv-regression.json` preserves command arrays, exact executed source hashes, statuses and timestamps. `source-binding.json` records raw/published receipt and helper hashes. The MSRV staged tree differs from the nine-gate staged tree only by CRLF-to-LF normalization of the historical supersession receipt; the product and test files are identical. The helper's local paths are normalized and must be replaced with an owned checkout before use.

To reproduce, install Rust 1.94.0 and run `cargo +1.94.0 clippy --locked --workspace --all-targets -- -D warnings` and `cargo +1.94.0 test --locked -p crony-store retained_provider_receipt`. For the controlled baseline, save the exact current source bytes, replace only `binding.as_object().is_none_or(|object| object.len() != 2)` with `!binding.as_object().is_some_and(|object| object.len() == 2)`, execute the two commands, and restore the saved source in `finally` before running the passing pair. Use an owned Cargo target and `RUST_TEST_THREADS=1`.

`msrv-results.png` is an actual Edge capture of the saved-results report, not a live terminal or product-runtime capture. No user-visible behavior changes with this equivalent predicate, so no new application-runtime claim is made.

Trailing line whitespace and blank lines at EOF are removed from the published logs. This formatting normalization does not alter test-result text; original and published hashes are distinct. The local `.gitattributes` preserves published evidence bytes on checkout.
