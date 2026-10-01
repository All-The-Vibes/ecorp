# Explicit native Windows validation scheduling

Partial progress on issue #213. Windows contributor commands now select Cargo's native serial
test harness explicitly, matching the existing Windows CI policy. Both pnpm test and pnpm check
run cargo test --workspace --locked -- --test-threads=1 even when the process inherits
RUST_TEST_THREADS=8. Command previews and generated documentation state that policy.
Linux and macOS retain native scheduling.

The six-file change preserves every canonical gate, full Node discovery, Rust workspace
membership, assertion, timeout and opt-in requirement. It adds no process controller or limiter
to production. Native test scheduling already provides the required contributor behavior.

## Current source and validation

Base 878a1774774b0630c904cbaf4b05e1b346777817; candidate tree 7a554383bb7aacd5f013efb1fabbedc2c129e4a1; branch codex/issue213-windows-validation. All 7,146 physical source files
were bound before and after the complete canonical run. This publication packet was added
afterward and is separately validated. The runner's production sources are unchanged.

All eleven canonical pnpm check gates passed: migrations, state-audit compatibility, EVM,
documentation, repository documentation, full Node discovery, Rust format, Clippy, workspace
tests, web build and web lint. Node: 3105 total / 3040 passed /
0 failed / 65 skipped / 0 cancelled /
0 todo. Rust: 877 passed / 0 failed /
564 ignored. The receipt records actual Rust argv with --test-threads=1;
the enclosing driver deliberately set RUST_TEST_THREADS=8. Locked dependency installations
are recorded in the driver logs. The preceding r1 wrapper stopped while waiting for the
failed issue89 acceptance prerequisite; it never invoked a canonical check. Its initial
source_unchanged=false field is not an observed source mismatch. The completed canonical
validation described here is r2; the stopped waiting receipt remains in history.

Focused policy regressions first observed 3 failing assertions against the old command policy.
After the change, all 35 focused tests passed, without skipped or failed cases. Coverage checks
both full and test groups, platform parity, the actual CLI preview, ambient thread settings,
generated docs, and the absence of preview source/receipt writes.

## Bounded diagnostic evidence

An earlier passive instrumented comparison used one current-main runner binary for both the
native-default and serial-1 lanes, short fresh owned roots outside ambient Git, and native
Windows Job Objects for cleanup. Each lane passed 281 tests, failed 0 and ignored 5, with no
filtered cases. Observed durations were 122.031 seconds and 786.265 seconds; the largest
observed concurrent Git span counts were 12 and 1. All owned processes stopped.

The preceding selected comparison passed 51 tests in each lane, with 235 filtered cases.
It used a different build from the full pair. Those filtered tests were not passes.
Export and workspace operations were timed without changing assertions, deadlines or
production ordering. Diagnostic source was restored before policy validation.

Neither experiment reproduced the historical failure. These passes do not prove contention,
repair a product defect, establish parallel reliability, or replace the original failed receipts.
The issue's September 9 serial failures, September 12 setup timeout, September 17 capability
limits, and September 18 long-root/ambient-Git confounds remain in historical-observations.json.

## Review and remaining work

Assistant review inspected the complete six-file diff, canonical plan selection and execution,
generated contract, CLI behavior, and existing Windows CI command. The native argument applies
only to Windows workspace gates; all other commands remain identical. No new execution or
permission machinery is introduced.

Published patches use UTF-8 JSON string envelopes: decode the patch field and check its
decoded_sha256 to recover the exact original bytes. Published source-file hash maps use
ordered path/sha256 objects with recorded reconstruction hashes. Log and helper copies remove
trailing spaces/tabs and redundant final blank lines after local-root redaction. Original
receipts remain unchanged in durable local evidence; counts and executed commands are preserved.

Issue #213 remains unresolved. The original scheduling/export failures need a demonstrated
cause or a separately justified disposition; this partial PR must not auto-close the issue.
Historical privilege/capability failures remain separate. No live provider, application database,
shared-service teardown or privilege change was used for the diagnostic work.

Required hosted CI, CodeQL, security and review gates still apply. Organization-disabled
GitHub Actions blocks merge. Existing Cargo advisory debt is not a clean audit. See summary.json
and source-equivalence.json for exact identities, observations and remaining limitations.
