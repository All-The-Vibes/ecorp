# PR #273 completion evidence

Date: September 22, 2026. Maintainer completion pass performed under the existing ECorp-only authorization.

Integrate current main and explicitly mark the missing historical original gate receipt unavailable, with its previously reported digest unverified. Preserve the original publication summary, checksum inventory and all frozen benchmark results.

Historical ProgramBench gron publication; current-main contributor checks do not rerun or repair the frozen benchmark.

The nine required commands passed on source head `c731ac85ab3a52c0f95fa5cb52a1243e152a5abd` with staged tree `40cf52b81b048424b2bef82942f953d2b44953d4`, incorporating main `08b0b89b2dd16c1906c9dd3468c5ddecca24c4ce`. `validation.json` binds the commands, tool versions, statuses and log hashes. Local user and checkout paths in the published logs are normalized; original hashes are also retained. The evidence files added here are subsequent documentation of that tested tree, not a claim that a not-yet-existing commit was executed.

`validation.png` is a genuine Edge screenshot of `validation.html`, rendered from these saved results. It is a test-report capture, not an application screen. Full result lines, including opt-in ignored tests, remain in the logs. No original RED/GREEN development chronology is inferred from retrospective validation.

Reproduction: use an isolated checkout of the PR, install the repository-pinned Rust/Node/pnpm toolchain, run `pnpm install --frozen-lockfile`, and execute the nine commands listed in `validation.json`. Set `RUST_TEST_THREADS=1` for the recorded Windows test configuration. Build the repository's native `crony-mcp` binary and set `CRONY_MCP_TEST_BINARY` to that owned binary for native MCP unit coverage. These results do not substitute for fresh hosted checks, required independent reviews, or production identity/provider acceptance.

Maintainer self-review: inspected the final implementation and its current-main integration against the product, architecture, security and evaluation contracts. Only evidence documented here is claimed; existing historical reports retain their original scope and limitations.

Native Git received `core.longpaths=true` through process-only Git configuration for the recorded commands. Repository and global Git configuration were not changed.

Build provenance: Workspace package artifacts are removed under the task Cargo mutex before Rust validation. Third-party dependency cache is retained. Node tests use a freshly built copied native MCP binary. `validation.json` also binds the workspace-refresh and MCP-build logs, their original/published hashes, and the copied MCP binary hash.

Publish the retained ProgramBench gron results and recommendations with an explicit account of their limits. The frozen report still records 200 passing and 24 failing official cases, covering 1 of 200 benchmark tasks; this correction does not rerun or repair the benchmark.

The original gate receipt referenced only by digest could not be recovered. Its publication summary now states that the original is unavailable and that the reported digest is unverified. Exact earlier summary and checksum bytes are retained under provenance/, and all 22 current checksum entries were independently rechecked.

All nine contributor gates pass on tree 40cf52b81b048424b2bef82942f953d2b44953d4, targeting current main 08b0b89b2dd16c1906c9dd3468c5ddecca24c4ce. Fresh logs, source identity, hashes, saved-report capture and historical qualification are in docs/evidence/pr-273-completion-20260922-r3/. Historical benchmark/browser artifacts retain their original scope.

Maintainer author-side self-review checked the complete correction against the product, architecture, security and evaluation contracts. Local Node 24.21.0 differs from the repository 24.19.0 pin. Opt-in ignored tests are not represented as executed integration coverage.

The supplementary completion-binding.json identifies retained artifacts, actual executed helper/native scope and original/published hashes.
