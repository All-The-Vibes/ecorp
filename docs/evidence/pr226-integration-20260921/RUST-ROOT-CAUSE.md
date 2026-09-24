# Remaining runner failure: precise native path diagnosis

The short, source-external TEMP retry (`07-cargo-test-temp-retry`) ran the unchanged full command and failed: 374 passed, 1 failed, 1 ignored across the executable results reached. Server/store/doc-tests were not yet reached. The remaining failure was `source_checkpoint::tests::issue190_late_stop_cancels_held_ack_without_acceptance_or_post_verifier_seal`, at `source_checkpoint.rs:674` (closed event receiver before deliverable-upload).

## Native evidence, not a speculative concurrency workaround

- `12-held-ack-exact-workspace-binary` reproduces that same failure alone using the exact already-built workspace test executable. It fails with 0 passed / 1 failed / 212 filtered. This disproves the need to assume a parallel-only problem.
- `rust-exact-binary-git-trace.jsonl` identifies native `git bundle create` exiting 128: `failed to stat 'refs/ecorp/deliverables/ba2ccd3f50204da1b8040896d59a8321': Filename too long`.
- The source fixture successfully created its verification commit before bundle export failed. The test's closed-receiver unwrap hid this earlier native export error. Neither that test nor its exporter/storage code changed between the original PR head, target and integrated tree; exact blob comparisons are in `failure-source-attribution.json`.
- Installed Git 2.55.0.windows.5 documents `core.longpaths` as the native opt-in for built-in commands above 260 characters, disabled by default. The installed manual excerpt is retained in `native-git-longpaths-documentation.txt`. The current configured value was absent; no system/global/repository config was changed.
- `13-held-ack-native-longpaths` reruns the same exact workspace binary and unchanged assertion using process-scoped native `core.longpaths=true` (`GIT_CONFIG_COUNT=1`, `GIT_CONFIG_KEY_0=core.longpaths`, `GIT_CONFIG_VALUE_0=true`). It passes: 1 passed / 0 failed / 212 filtered. The same-length fresh temp root and full native Git trace are retained.
- `11-rust-held-ack-diagnostic` additionally reproduces the failure through package-only Cargo execution, but that narrower package feature build is not used as workspace acceptance.

This is an environment/configuration remedy for existing native Windows Git path behavior, not an introduced integration defect or product-source fix. No test body, assertion, timeout, test concurrency, dependency, SDK build mechanism, or skip selection changed. Focused diagnostic results are not the contributor gate. The complete, unchanged `cargo test --workspace` is now run again with only the supported process-scoped native path configuration and a source-external owned temporary root.
