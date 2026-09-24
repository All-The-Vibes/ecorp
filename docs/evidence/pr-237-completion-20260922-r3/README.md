# PR #237 completion evidence

Date: September 22, 2026. Maintainer completion pass performed under the existing ECorp-only authorization.

Roll back post-spawn identity and receipt failures through the exact retained child capability, retain unconfirmed rollback evidence, isolate synthetic Git configuration, and canonicalize the trusted Node executable in native ownership tests.

Nine current contributor gates; 207 focused process/Git/recovery tests with native owned-process cases enabled and zero skips; retrospective admission and hostile-Git baseline/candidate results; complete-ancestry Gitleaks 8.30.1 scan of the final product-source commit. Existing four-scenario/native/browser acceptance retains its original historical scope.

The nine required commands passed on source head `c54d2c509cf4862bf8a2adc16fa4419f7970c920` with staged tree `dfbe00b6a12493cdb70132c8ce685d544ea9f7d3`, incorporating main `08b0b89b2dd16c1906c9dd3468c5ddecca24c4ce`. `validation.json` binds the commands, tool versions, statuses and log hashes. Local user and checkout paths in the published logs are normalized; original hashes are also retained. The evidence files added here are subsequent documentation of that tested tree, not a claim that a not-yet-existing commit was executed.

`validation.png` is a genuine Edge screenshot of `validation.html`, rendered from these saved results. It is a test-report capture, not an application screen. Full result lines, including opt-in ignored tests, remain in the logs. No original RED/GREEN development chronology is inferred from retrospective validation.

Reproduction: use an isolated checkout of the PR, install the repository-pinned Rust/Node/pnpm toolchain, run `pnpm install --frozen-lockfile`, and execute the nine commands listed in `validation.json`. Set `RUST_TEST_THREADS=1` for the recorded Windows test configuration. Build the repository's native `crony-mcp` binary and set `CRONY_MCP_TEST_BINARY` to that owned binary for native MCP unit coverage. These results do not substitute for fresh hosted checks, required independent reviews, or production identity/provider acceptance.

Maintainer self-review: inspected the final implementation and its current-main integration against the product, architecture, security and evaluation contracts. Only evidence documented here is claimed; existing historical reports retain their original scope and limitations.

Native Git received `core.longpaths=true` through process-only Git configuration for the recorded commands. Repository and global Git configuration were not changed.

Build provenance: Workspace package artifacts are removed under the task Cargo mutex before Rust validation. Third-party dependency cache is retained. Node tests use a freshly built copied native MCP binary. `validation.json` also binds the workspace-refresh and MCP-build logs, their original/published hashes, and the copied MCP binary hash.

## Bounded review corrections

- A successful recovery-driver spawn now either publishes its complete ownership record or rolls back through the existing `stopLaunchedChild` capability and confirms exit. Log descriptors close on every path. Identity absence/errors, executable mismatch and receipt-publication failure all use that same mechanism. An unrelated live peer remains untouched in each actual failure-injection test.
- `Start-LocalOwnedProcess` rolls back record-construction failure through its original returned native handle. An injected stop failure preserves that exact handle in the exception together with an explicitly unverified rollback state and diagnostic paths. It never authorizes a numeric PID fallback. The test separately stops its own retained child and verifies cleanup.
- Synthetic Git commands use an owned empty global configuration, hooks and template directories, disable system config/signing/fsmonitor, and set long paths only for the process. The hostile operator-configuration regression fails on the old implementation and passes on the candidate.
- Native ownership tests canonicalize their trusted `process.execPath` once. Strict process executable/creation identity assertions remain intact.

The actual admission baseline had zero passes and five behavioral failures; the corrected run passed all five. The hostile Git baseline failed its actual synthetic commit, and the corrected run passed. The final focused family passed 207 tests with zero failures/cancellations/skips and `ECORP_OWNED_PROCESS_TEST=1`. The nine ordinary gates passed separately; their ignored/optional cases are not described as executed native coverage.

Reproduce the focused family with the exact argument array in `focused/pr237-focused-r1.json` and native owned-process opt-in enabled on Windows. For retrospective reproduction, make separate isolated checkouts at the scanned product-source commit, apply the corresponding zero-context patch with `git apply --unidiff-zero`, and run `node --test --test-reporter=spec --test-concurrency=1 tools/factory_budget_start.test.mjs` or `node --test tools/factory_budget_git.test.mjs`. Run the same test on the unmodified candidate for GREEN. Source/test identities and original/published log hashes are retained; no original development chronology is claimed.

## Full-ancestry secret scan

`scan-result.png` is a genuine Edge capture of `scan-result.html`, rendered from the retained Gitleaks/reporter result of the immutable final product-source commit shown in `scan/current-source/receipt.json`. Its complete ancestry was checked, Gitleaks and reporter exited zero, and no findings were reported. The evidence packet is added afterward and the final publication commit is scanned again before any push; that later receipt is recorded separately because a committed image cannot contain its own future commit ID. The source-binding receipt and publication guard require all tested/scanned product bytes to remain unchanged.

The prior failed scan remains under `scan/prior-failed/` with its one hashed finding. The reviewed exact historical fingerprint and original development-fixture rationale are retained alongside it. There is no new suppression, broad rule exclusion or current fixture-key change. This is honest saved-result image coverage of the distinct scan lane, not a new live-terminal or application capture.

The earlier four native recovery scenarios and browser/server/runner verifier acceptance remain in the original packet. They were not rerun for these bounded launch-admission and test-portability corrections; new behavior is covered by the actual owned-child failure injections above. Production-provider, OIDC and operating-system isolation limits remain unchanged.

Trailing line whitespace and blank lines at EOF are removed from the published logs. This formatting normalization does not alter test-result text; original and published hashes are distinct. The local `.gitattributes` preserves published evidence bytes on checkout.
