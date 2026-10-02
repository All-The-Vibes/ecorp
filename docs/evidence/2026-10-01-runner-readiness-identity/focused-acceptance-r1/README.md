# Saved-connection focused acceptance — October 2, 2026

Seventeen real PostgreSQL store tests, 26 runner connection tests and 17 adapter
tests pass against unchanged product source. These 60 selected cases are not an
additional 60 tests on top of the earlier canonical totals: the 43 runner/adapter
cases overlap that suite, while the 17 SQLx cases were previously ignored.
The [acceptance mapping and review](review.md) binds these results to issue #198.

| Attempt | Observed result | Evidence |
| --- | --- | --- |
| Store R1, PostgreSQL 17.10 | 17 passed, 0 failed/ignored, 534 filtered; 32.92s | [receipt](issue198-store-r1.json), [log](issue198-store-r1.log), [process exit](issue198-store-r1-session-exit.json) |
| Connections R1 | 25 passed, 1 failed, 0 ignored, 260 filtered; 38.92s | [receipt](issue198-runner-r1.json), [log](issue198-connections-r1.log), [process exit](issue198-runner-r1-session-exit.json) |
| Connections R2 | 26 passed, 0 failed/ignored, 260 filtered; 71.48s | [receipt](issue198-runner-r2.json), [log](issue198-connections-r2.log), [process exit](issue198-runner-r2-session-exit.json) |
| Adapter R1 | 17 passed, 0 failed/ignored, 269 filtered; 10.08s | [receipt](issue198-runner-r1.json), [log](issue198-adapter-connection-r1.log) |

Each runner/adapter command also enumerated the evidence-paths binary with zero
selected cases and 25 filtered cases. That is not a passing selected test.
R1's overall driver exit is 1 and its connection Cargo exit is 101; its adapter
lane passed independently. R2 did not repeat the adapter lane.

R1 failed in native Git worktree preparation with exit 128 and
`fatal: '$GIT_DIR' too big`. R2 shortened only the external driver's owned TEMP/TMP
root and reran the connection lane. Product bytes, assertions, timeouts and Git
protections stayed unchanged. This establishes the tested short-root result;
arbitrary long Windows roots remain unproven. Both attempts and the failed native
fixture are preserved. No product defect is claimed repaired by this retry.

All attempts used `--locked` dependencies. Store R1 used a fresh, private,
loopback PostgreSQL fixture and actual migrations; it stopped successfully.
Runner and adapter fixtures use fake provider/GitHub protocols with real owned
processes, Git and worktrees. They do not prove live accounts or inference.
Real Copilot application acceptance remains in the separate
[native packet](../native-acceptance-r1/README.md).

Head `3e882d6748735099b68fef8f73e979ecb29ff4e7`, tree
`b77fdb292101317513bf531d52de8715ddbee0f2`, base
`878a1774774b0630c904cbaf4b05e1b346777817`; tested product tree
`d62abf4e59887f84f3848ccf5c839fe487e51c30`. The store and runner receipts carry
266-file and 272-file physical manifests respectively. All entries match the
7,147 unchanged product inputs from the earlier full canonical validation.
The evidence-only child commit binds this new packet; no new `pnpm check` run is
claimed. Earlier Node 3,108 total / 3,043 passed / 65 skipped / 0 failed and Rust
877 passed / 564 ignored / 0 failed remain unchanged. Native EVM passed separately.

Original process outputs, all discovered/selected cases and inert `.ps1.txt`
drivers are included. [Provenance](artifact-provenance.json) records original and
public hashes, home-path substitution and whitespace normalization. Original
receipt hashes are not silently changed to public-copy hashes. The R2 session
receipt records an observed exit after context compaction; it is not another run.

Required hosted checks remain unavailable while GitHub Actions is disabled.
No promotion, approval, merge, policy exception or issue completion is claimed.
Previous native, synthetic and canonical limitations remain in their packets.
