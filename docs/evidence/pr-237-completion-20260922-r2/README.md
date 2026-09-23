# PR #237 completion evidence

Date: September 22, 2026. Maintainer completion pass performed under the existing ECorp-only authorization.

Add one exact historical Gitleaks fingerprint for an isolated fixture literal verified to match the already-published DEVELOPMENT_KEY_HEX constant. Current fixture generation remains random. No broad key, file, or path exclusion was added.

All nine contributor gates passed again. The only source delta since the retained four native recovery scenarios and actual browser/server/runner acceptance is the historical scan fingerprint; native runtime bytes are unchanged.

The nine required commands passed on source head `49fb491a0397d1b6ce87a91769350f2fe7a36ebe` with staged tree `7c182ce85eab47de6bde00aee7e647c8d6f6a779`, incorporating main `08b0b89b2dd16c1906c9dd3468c5ddecca24c4ce`. `validation.json` binds the commands, tool versions, statuses and log hashes. Local user and checkout paths in the published logs are normalized; original hashes are also retained. The evidence files added here are subsequent documentation of that tested tree, not a claim that a not-yet-existing commit was executed.

`validation.png` is a genuine Edge screenshot of `validation.html`, rendered from these saved results. It is a test-report capture, not an application screen. Full result lines, including opt-in ignored tests, remain in the logs. No original RED/GREEN development chronology is inferred from retrospective validation.

Reproduction: use an isolated checkout of the PR, install the repository-pinned Rust/Node/pnpm toolchain, run `pnpm install --frozen-lockfile`, and execute the nine commands listed in `validation.json`. Set `RUST_TEST_THREADS=1` for the recorded Windows test configuration. Build the repository's native `crony-mcp` binary and set `CRONY_MCP_TEST_BINARY` to that owned binary for native MCP unit coverage. These results do not substitute for fresh hosted checks, required independent reviews, or production identity/provider acceptance.

Maintainer self-review: inspected the final implementation and its current-main integration against the product, architecture, security and evaluation contracts. Only evidence documented here is claimed; existing historical reports retain their original scope and limitations.

Native Git received `core.longpaths=true` through process-only Git configuration for the recorded commands. Repository and global Git configuration were not changed.

Build provenance: Workspace package artifacts are removed under the task Cargo mutex before Rust validation. Third-party dependency cache is retained. Node tests use a freshly built copied native MCP binary. `validation.json` also binds the workspace-refresh and MCP-build logs, their original/published hashes, and the copied MCP binary hash.

## Follow-up correction and evidence continuity

The first final-head scan reported exactly one historical fixture fingerprint at commit 273114b1fe5aa850f8767e1c9062c5100d885a7f, tools/e2e_identity.mjs line 381. A value comparison established that this was the published development constant; the receipt records only the boolean comparison and byte length. The exception is restricted to that commit/file/rule/line. The original failed scan is preserved, and a fresh final-head/full-ancestry scan is required before publication. The earlier native packet retains all four current-source recovery/adapter scenarios, real application captures, and the actual browser/server/runner verifier-policy run.

source-binding.json and source-correction.patch prove the complete source delta from the prior native-tested tree. Only the stated correction and preceding evidence packet differ. No native rerun or original RED/GREEN chronology is claimed for this follow-up.

Trailing line whitespace and blank lines at EOF are removed from the published logs. This formatting normalization does not alter test-result text; original and published hashes are distinct. The local `.gitattributes` preserves published evidence bytes on checkout.
