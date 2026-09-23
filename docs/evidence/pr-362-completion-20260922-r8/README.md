# PR #362 completion evidence

Date: September 22, 2026. Maintainer completion pass performed under the existing ECorp-only authorization.

Bound public evidence packets before reading their payloads, require the exact nine canonical validation commands, and stream immutable staged-file inventories with fixed entry, path and aggregate byte ceilings. Retain historical evidence and its failed attempts.

All nine contributor gates and 60 verifier/driver regressions pass on the same staged source. The staged replay verifies 67 files, 87 archive members, 111 manifest rows and 14 capture logs.

The nine required commands passed on source head `6eb5ebe6c424d54cfb48c8c5326216090183e85f` with staged tree `220f0df7bc93be5e3740a6bc5fcaf7e5ece6e272`, incorporating main `08b0b89b2dd16c1906c9dd3468c5ddecca24c4ce`. `validation.json` binds the commands, tool versions, statuses and log hashes. Local user and checkout paths in the published logs are normalized; original hashes are also retained. The evidence files added here are subsequent documentation of that tested tree, not a claim that a not-yet-existing commit was executed.

`validation.png` is a genuine Edge screenshot of `validation.html`, rendered from these saved results. It is a test-report capture, not an application screen. Full result lines, including opt-in ignored tests, remain in the logs. No original RED/GREEN development chronology is inferred from retrospective validation.

Reproduction: use an isolated checkout of the PR, install the repository-pinned Rust/Node/pnpm toolchain, run `pnpm install --frozen-lockfile`, and execute the nine commands listed in `validation.json`. Set `RUST_TEST_THREADS=1` for the recorded Windows test configuration. Build the repository's native `crony-mcp` binary and set `CRONY_MCP_TEST_BINARY` to that owned binary for native MCP unit coverage. These results do not substitute for fresh hosted checks, required independent reviews, or production identity/provider acceptance.

Maintainer self-review: inspected the final implementation and its current-main integration against the product, architecture, security and evaluation contracts. Only evidence documented here is claimed; existing historical reports retain their original scope and limitations.

Native Git received `core.longpaths=true` through process-only Git configuration for the recorded commands. Repository and global Git configuration were not changed.

Build provenance: Workspace package artifacts are removed under the task Cargo mutex before Rust validation. Third-party dependency cache is retained. Node tests use a freshly built copied native MCP binary. `validation.json` also binds the workspace-refresh and MCP-build logs, their original/published hashes, and the copied MCP binary hash.

Public admission streams directory entries with a maximum of 128 files per packet, including the manifest. It checks actual file sizes and the combined 32 MiB ceiling across all three packets before payload reads. Later reads cannot exceed each admitted size. The existing descriptor, link, per-file and ZIP checks remain in effect.

The staged driver requires exactly the canonical names, programs and argument arrays for all nine gates, unique names, integer-zero exits and a literal true source-unchanged result. Nine duplicate or unrelated rows cannot satisfy the contract. Git inventory uses streamed NUL records with a 1,024-entry ceiling, 1,024 path bytes and 64 MiB aggregate content before fixture allocation. Ordinary file modes, safe paths and case-insensitive file/directory collision checks are required.

The nine targeted retrospective controls fail against the prior implementation and pass against the candidate. The complete verifier/driver suite passes 60 tests, and the exact staged-byte replay reruns those tests and verifies the retained packet inventories. The earlier hosted-failure evidence and all prior completion packets remain unchanged. The old maintained verifier manifest is separately retained before its declared verifier digest was updated.

Current reproduction uses `tools/verify_pr362_staged_evidence.py` with an explicit repository, a successful nine-gate validation receipt and a fresh output directory. The r8 packet supersedes older packets for current-source validation. Node 24.21.0 was used locally; the repository pin is 24.19.0. The new image is a genuine saved-test-report capture. No new application, native-provider or browser acceptance is claimed. Hosted checks on the new commit and protected independent approvals remain separate.

Trailing line whitespace and blank lines at EOF are removed from the published logs. This formatting normalization does not alter test-result text; original and published hashes are distinct. The local `.gitattributes` preserves published evidence bytes on checkout.
