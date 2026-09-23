# PR #226 completion evidence

Date: September 23, 2026. Maintainer completion pass performed under the existing ECorp-only authorization.

Bind evidence traversal to retained native directory handles; reject Windows reparse attributes and linked ancestors; enumerate and open relative to the retained handles; bound and identity-check single-link file reads. Discover all PR226 completion packets and preserve a reproducible immutable historical failing baseline with explicit source, test and packet hashes.

All nine required gates, 16 native scanner cases and 11 JavaScript/native integration cases, including an actual Windows short-name alias. This evidence-tool correction does not claim new application, provider or native Factory acceptance; issue #225 remains separately tracked.

The nine required commands passed on source head `ef16021bc3d9552979fe397dc3d73700fdae3e6b` with staged tree `1cde7ce2f66bef18b29237ad5db37b2d1a84d304`, incorporating main `08b0b89b2dd16c1906c9dd3468c5ddecca24c4ce`. `validation.json` binds the commands, tool versions, statuses and log hashes. Local user and checkout paths in the published logs are normalized; original hashes are also retained. The evidence files added here are subsequent documentation of that tested tree, not a claim that a not-yet-existing commit was executed.

`validation.png` is a genuine Edge screenshot of `validation.html`, rendered from these saved results. It is a test-report capture, not an application screen. Full result lines, including opt-in ignored tests, remain in the logs. No original RED/GREEN development chronology is inferred from retrospective validation.

Reproduction: use an isolated checkout of the PR, install the repository-pinned Rust/Node/pnpm toolchain, run `pnpm install --frozen-lockfile`, and execute the nine commands listed in `validation.json`. Set `RUST_TEST_THREADS=1` for the recorded Windows test configuration. Build the repository's native `crony-mcp` binary and set `CRONY_MCP_TEST_BINARY` to that owned binary for native MCP unit coverage. These results do not substitute for fresh hosted checks, required independent reviews, or production identity/provider acceptance.

Maintainer self-review: inspected the final implementation and its current-main integration against the product, architecture, security and evaluation contracts. Only evidence documented here is claimed; existing historical reports retain their original scope and limitations.

Native Git received `core.longpaths=true` through process-only Git configuration for the recorded commands. Repository and global Git configuration were not changed.

Build provenance: Workspace package artifacts are removed under the task Cargo mutex before Rust validation. Third-party dependency cache is retained. Node tests use a freshly built copied native MCP binary. `validation.json` also binds the workspace-refresh and MCP-build logs, their original/published hashes, and the copied MCP binary hash.

The held-handle regressions exercise root, ancestor, directory and file replacement windows; replacement is either prevented by the retained native handle or refused before redirected content is read. A native non-junction Windows reparse tag is rejected, while ordinary real 8.3 spelling succeeds. Missing packets, a file occupying a packet namespace, hard links, growth and oversize sparse evidence fail closed. The default scan includes every matching PR226 completion packet, including this new packet.

The immutable replay verifies the explicit historical revision, original scanner hash, recovered test hash and three historical evidence tree hashes before creating its fixture. It reproduces the recorded 16-test result (eight pass, eight fail, no skips, exit 1). The synthetic personal-path test source remains under `tools/fixtures/pr226-evidence-baseline/`, outside the evidence scan. Earlier evidence and failed attempts are retained.

Trailing line whitespace and blank lines at EOF are removed from the published logs. This formatting normalization does not alter test-result text; original and published hashes are distinct. The local `.gitattributes` preserves published evidence bytes on checkout.
