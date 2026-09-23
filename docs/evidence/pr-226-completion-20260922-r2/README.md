# PR #226 completion evidence

Date: September 22, 2026. Maintainer completion pass performed under the existing ECorp-only authorization.

Normalize the eight remaining drive-relative HOMEPATH values, preserve original/prior-published/new hashes, and use one tested path matcher for the historical self-review and the explicit evidence scan.

All nine repository checks pass. Four focused personal-path regressions and the scan of both historical packets pass. This is a retrospective evidence correction; issue #225 native Factory acceptance remains open.

The nine required commands passed on source head `6550abc9188128f4ab0a0ca1bd98a80472e8f3bd` with staged tree `158a48b0428534f9b00aecee3d2b0d590ef64895`, incorporating main `5f65e536f80e206082a8a819f2675c9b16210fce`. `validation.json` binds the commands, tool versions, statuses and log hashes. Local user and checkout paths in the published logs are normalized; original hashes are also retained. The evidence files added here are subsequent documentation of that tested tree, not a claim that a not-yet-existing commit was executed.

`validation.png` is a genuine Edge screenshot of `validation.html`, rendered from these saved results. It is a test-report capture, not an application screen. Full result lines, including opt-in ignored tests, remain in the logs. No original RED/GREEN development chronology is inferred from retrospective validation.

Reproduction: use an isolated checkout of the PR, install the repository-pinned Rust/Node/pnpm toolchain, run `pnpm install --frozen-lockfile`, and execute the nine commands listed in `validation.json`. Set `RUST_TEST_THREADS=1` for the recorded Windows test configuration. Build the repository's native `crony-mcp` binary and set `CRONY_MCP_TEST_BINARY` to that owned binary for native MCP unit coverage. These results do not substitute for fresh hosted checks, required independent reviews, or production identity/provider acceptance.

Maintainer self-review: inspected the final implementation and its current-main integration against the product, architecture, security and evaluation contracts. Only evidence documented here is claimed; existing historical reports retain their original scope and limitations.

Native Git received `core.longpaths=true` through process-only Git configuration for the recorded commands. Repository and global Git configuration were not changed.

Build provenance: Workspace package artifacts are removed under the task Cargo mutex before Rust validation. Third-party dependency cache is retained. Node tests use a freshly built copied native MCP binary. `validation.json` also binds the workspace-refresh and MCP-build logs, their original/published hashes, and the copied MCP binary hash.

The old matcher reproduced the drive-relative omission (three passes, one failure); the revised shared matcher passes all four cases, including optional drive prefixes, slash/backslash forms, JSON escaping, case variants and accepted placeholders. The CLI scan passes for both historical packets. Exactly eight HOMEPATH values changed. The manifest preserves the original, previous publication and new publication digests. Original bytes remain retained privately; original PNGs did not change.

The historical self-review now imports the same matcher, but its whole-source historical assertions were not rerun against a later main. The focused retrospective logs are the claimed evidence. No historical provider success or issue #225 native Factory acceptance is inferred from this correction.

Reproduce the focused checks using `node --test tools/check_evidence_personal_paths.test.mjs`, then `node tools/check_evidence_personal_paths.mjs docs/evidence/pr226-integration-20260921 docs/evidence/pr226-local-validation` from the reviewed checkout. The nine complete commands and exact tested tree are in validation.json.

Trailing line whitespace and blank lines at EOF are removed from the published logs. This formatting normalization does not alter test-result text; original and published hashes are distinct. The local `.gitattributes` preserves published evidence bytes on checkout.
