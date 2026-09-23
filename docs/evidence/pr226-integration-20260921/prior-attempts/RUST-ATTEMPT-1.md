# Rust gate attempt 1: environment failure; not a passing test

`07-cargo-test.json` records exit 101 on unchanged tree 6f027117897a8ec87673e98036fd4ea22de077af.
The command compiled successfully, then stopped in the runner executable. Completed executable results total 319 passed, 56 failed, 1 ignored. Server/store/doc-test execution was not reached and must not be counted.

- 52 failure blocks directly contain Git's `fatal: '$GIT_DIR' too big` under the worker's 83-character temporary-root prefix.
- Two native connection fixtures reject private state inside a source checkout. The product's `PrivateRoot::open` in `crates/crony-runner/src/connection_setup/storage.rs` deliberately rejects prospective state under a forbidden source root. Using this checkout's output directory as TEMP conflicts with that correct security invariant.
- One teardown test reports a timeout; one occupied-worktree assertion sees the wrong setup diagnostic. Those are not separately reclassified as passes; a full unchanged rerun must settle them.

Only the untracked validation harness changes: the next invocation gets a new short `p226-<random>` directory under the operating system's normal temporary directory, outside all source checkouts. This is this test worker's synthetic fixture storage, not another developer's checkout. It is recorded in the retry environment receipt. The earlier temporary tree and failure logs remain. No source change, test suppression, filter, serial-mode switch, Git setting change, dependency install or compilation-cache reset is used. The exact `cargo test --workspace` command is rerun with ordinary test concurrency.
