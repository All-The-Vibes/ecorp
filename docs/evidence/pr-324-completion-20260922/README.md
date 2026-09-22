# PR #324 completion evidence

Date: September 22, 2026. Maintainer completion pass performed under the existing ECorp-only authorization.

Integrated current main and inspected literal path handling, Git environment isolation, bounded output and fail-closed temporary-index cleanup. Retained the earlier Windows linker collision and passing retry on identical source under serialized Cargo-target ownership.

Deliverable verification tooling only. Full required local validation passes after current-main integration. The checker uses an external temporary Git index and leaves the source checkout, original index and refs untouched; native exported fixture coverage is in the unit lane.

The nine required commands passed on source head `25ec5f91d98eb11d54e4bf003467d72de5177b01` with staged tree `5fc727fc343a9b672ed25eb46f44e67361b0d6fe`, incorporating main `410eddfc8bfcfa874dae05555128d39a914f0456`. `validation.json` binds the commands, tool versions, statuses and log hashes. Local user and checkout paths in the published logs are normalized; original hashes are also retained. The evidence files added here are subsequent documentation of that tested tree, not a claim that a not-yet-existing commit was executed.

`validation.png` is a genuine Edge screenshot of `validation.html`, rendered from these saved results. It is a test-report capture, not an application screen. Full result lines, including opt-in ignored tests, remain in the logs. No original RED/GREEN development chronology is inferred from retrospective validation.

Reproduction: use an isolated checkout of the PR, install the repository-pinned Rust/Node/pnpm toolchain, run `pnpm install --frozen-lockfile`, and execute the nine commands listed in `validation.json`. Set `RUST_TEST_THREADS=1` for the recorded Windows test configuration. Build the repository's native `crony-mcp` binary and set `CRONY_MCP_TEST_BINARY` to that owned binary for native MCP unit coverage. These results do not substitute for fresh hosted checks, required independent reviews, or production identity/provider acceptance.

Maintainer self-review: inspected the final implementation and its current-main integration against the product, architecture, security and evaluation contracts. Only evidence documented here is claimed; existing historical reports retain their original scope and limitations.

Native Git received `core.longpaths=true` through process-only Git configuration for the recorded commands. Repository and global Git configuration were not changed.

Retry provenance: Initial test compilation failed with LNK1104 while another owned validation held the shared Windows test executable. Retry waits for the target-specific validation mutex and preserves all passed checks on the same unchanged staged tree.

The first failed receipt and failed-command logs are preserved under `prior-attempts/`; normalization and separate original/published hashes are recorded in `validation.json`. Successful command logs were retained byte-for-byte before publication normalization.

Trailing line whitespace and blank lines at EOF are removed from the published logs. This formatting normalization does not alter test-result text; original and published hashes are distinct. The local `.gitattributes` preserves published evidence bytes on checkout.
