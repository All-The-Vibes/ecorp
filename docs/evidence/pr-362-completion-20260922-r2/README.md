# PR #362 completion evidence

Date: September 22, 2026. Maintainer completion pass performed under the existing ECorp-only authorization.

Refuse optimized Python before assertion-based public-evidence verification, cover -O, -OO, PYTHONOPTIMIZE levels one and two plus intact/corrupted packets, and run these regressions in Ubuntu and Windows CI. Update only the verifier manifest entry with a preserved prior row.

All nine current-main checks pass after source-bound workspace and MCP rebuilds. Separate actual subprocess tests reproduce four optimization bypasses against the previous verifier and pass all six cases against the final correction. Previous native transport and startup acceptance remains separately bound to its original run.

The nine required commands passed on source head `0ec32db2b18e967590179a09d76620a502e367cd` with staged tree `5a15f6dee3f637a7744089ee152fb29383466f7e`, incorporating main `5f65e536f80e206082a8a819f2675c9b16210fce`. `validation.json` binds the commands, tool versions, statuses and log hashes. Local user and checkout paths in the published logs are normalized; original hashes are also retained. The evidence files added here are subsequent documentation of that tested tree, not a claim that a not-yet-existing commit was executed.

`validation.png` is a genuine Edge screenshot of `validation.html`, rendered from these saved results. It is a test-report capture, not an application screen. Full result lines, including opt-in ignored tests, remain in the logs. No original RED/GREEN development chronology is inferred from retrospective validation.

Reproduction: use an isolated checkout of the PR, install the repository-pinned Rust/Node/pnpm toolchain, run `pnpm install --frozen-lockfile`, and execute the nine commands listed in `validation.json`. Set `RUST_TEST_THREADS=1` for the recorded Windows test configuration. Build the repository's native `crony-mcp` binary and set `CRONY_MCP_TEST_BINARY` to that owned binary for native MCP unit coverage. These results do not substitute for fresh hosted checks, required independent reviews, or production identity/provider acceptance.

Maintainer self-review: inspected the final implementation and its current-main integration against the product, architecture, security and evaluation contracts. Only evidence documented here is claimed; existing historical reports retain their original scope and limitations.

Native Git received `core.longpaths=true` through process-only Git configuration for the recorded commands. Repository and global Git configuration were not changed.

Build provenance: Workspace package artifacts are removed under the task Cargo mutex before Rust validation. Third-party dependency cache is retained. Node tests use a freshly built copied native MCP binary. `validation.json` also binds the workspace-refresh and MCP-build logs, their original/published hashes, and the copied MCP binary hash.

Actual subprocess regression against complete owned copies of the evidence packets: four optimization cases fail on the original verifier, and all six cases pass on the final correction.

`verifier-logs.json` binds the retained original and published log hashes.

The current correction addresses review comment 4073786128. The assertion-based public verifier previously printed PASS when Python optimization removed its integrity assertions. It now refuses execution before verification whenever assertions are disabled. The six regression cases cover an intact packet, a corrupted packet, `-O`, `-OO`, and `PYTHONOPTIMIZE` levels 1 and 2. Both Ubuntu and Windows CI execute this module.

`controlled-verifier.json` binds the final verifier, manifest, test module and CI source hashes to the validated Git tree. Its new subprocess exercise copies the three complete evidence packets into a separate owned fixture; the original verifier causes four optimization tests to fail, while the final verifier passes all six. The fixture preserves both command logs and remains available privately. This is a retrospective regression demonstration, not original author chronology. Earlier intermediate-wording receipts and failed attempts remain privately retained; final claims bind the r4 execution.

Reproduce the final check with `python -X utf8 -m unittest discover -s tools -p test_public_evidence_verifier.py`. To repeat the controlled comparison, copy this exact test module under `tools/` and all three September 21 packets under `docs/evidence/` in a new owned directory. Replace only the combined packet's verifier and manifest with the separately retained originals, run the same command and observe four expected failures, then restore the exact current verifier/manifest and observe six passes. The normalized helper records the procedure; replace its path placeholders with owned local paths. No authentication or network access is used.

The updated historical manifest preserves its previous verifier entry under `supersedes_verifier` and records the correction. Historical captures, archives, other logs and their accepted scope are unchanged. The native proxy and Windows TLS/startup results remain in the prior completion packet with their own source binding; this follow-up did not rerun them. `controlled-verifier.png` and `validation.png` are genuine Edge captures of saved-results reports, not live terminals or new product-runtime acceptance.

Trailing line whitespace and blank lines at EOF are removed from the published logs. This formatting normalization does not alter test-result text; original and published hashes are distinct. The local `.gitattributes` preserves published evidence bytes on checkout.
