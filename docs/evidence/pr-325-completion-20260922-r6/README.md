# PR #325 completion evidence

Date: September 22, 2026. Maintainer completion pass performed under the existing ECorp-only authorization.

Select the first resolved Node application path as a scalar before invoking the Windows policy handoff test. Hosted Windows PATH contained multiple Node executables and previously failed argument binding before any cases executed.

All nine contributor gates passed again. The exact corrected workflow step ran with two discoverable Node executables and passed all eight native handoff cases. Existing installed-Edge desktop/mobile verifier acceptance remains applicable because runtime bytes are unchanged.

The nine required commands passed on source head `e28fc2fd005a2c61b99e9075c533a0c7e9b4e7e3` with staged tree `cd874f4c45fec29328e1ee7cf92bea372160af52`, incorporating main `08b0b89b2dd16c1906c9dd3468c5ddecca24c4ce`. `validation.json` binds the commands, tool versions, statuses and log hashes. Local user and checkout paths in the published logs are normalized; original hashes are also retained. The evidence files added here are subsequent documentation of that tested tree, not a claim that a not-yet-existing commit was executed.

`validation.png` is a genuine Edge screenshot of `validation.html`, rendered from these saved results. It is a test-report capture, not an application screen. Full result lines, including opt-in ignored tests, remain in the logs. No original RED/GREEN development chronology is inferred from retrospective validation.

Reproduction: use an isolated checkout of the PR, install the repository-pinned Rust/Node/pnpm toolchain, run `pnpm install --frozen-lockfile`, and execute the nine commands listed in `validation.json`. Set `RUST_TEST_THREADS=1` for the recorded Windows test configuration. Build the repository's native `crony-mcp` binary and set `CRONY_MCP_TEST_BINARY` to that owned binary for native MCP unit coverage. These results do not substitute for fresh hosted checks, required independent reviews, or production identity/provider acceptance.

Maintainer self-review: inspected the final implementation and its current-main integration against the product, architecture, security and evaluation contracts. Only evidence documented here is claimed; existing historical reports retain their original scope and limitations.

Native Git received `core.longpaths=true` through process-only Git configuration for the recorded commands. Repository and global Git configuration were not changed.

Build provenance: Workspace package artifacts are removed under the task Cargo mutex before Rust validation. Third-party dependency cache is retained. Node tests use a freshly built copied native MCP binary. `validation.json` also binds the workspace-refresh and MCP-build logs, their original/published hashes, and the copied MCP binary hash.

## Follow-up correction and evidence continuity

The hosted Windows job 106938663474 (run 35784737853) failed before handoff cases because Get-Command returned two executable paths. The exact corrected YAML run block was extracted and executed with two Node candidates: all eight cases passed. The prior hosted log and failed initial local YAML extraction are retained; that extraction did not execute production cases and is not counted as a product regression. Full verifier-browser/native evidence remains in the preceding r5 packet; this workflow-only correction does not alter those tested runtime bytes. The original incomplete junction identity-guard failure also remains retained, without assigning an unproven cause.

source-binding.json and source-correction.patch prove the complete source delta from the prior native-tested tree. Only the stated correction and preceding evidence packet differ. No native rerun or original RED/GREEN chronology is claimed for this follow-up.

Trailing line whitespace and blank lines at EOF are removed from the published logs. This formatting normalization does not alter test-result text; original and published hashes are distinct. The local `.gitattributes` preserves published evidence bytes on checkout.
