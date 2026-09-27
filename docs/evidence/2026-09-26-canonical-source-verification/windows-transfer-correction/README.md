# Native Windows pack transfer and signed object identities

Hosted Windows job 108627279188 on parent 712a30eb018fa2325f889bdc4fd539161e2c0f3a failed
while Git finalized a named pack from the D: source into a C: snapshot:
`Improper link` followed by `unable to rename temporary file`. The retained
hosted receipt and log establish this later failure's cause. Earlier failures
retain their original, less specific evidence.

The runner now asks native `pack-objects --stdout` for only candidate/base
history and streams it to an exclusively created snapshot scratch file.
Native `index-pack --stdin` installs it within the snapshot volume. The transfer
is disk-streamed with an explicit 8 GiB + 64 MiB cap; diagnostic stdout retains
its 16 MiB bound. Both commands use the existing process ownership and awaited
cleanup. File handles are released before the owned scratch is removed. No
new dependency, permission or process-lifecycle mechanism is introduced.

The server now requires a deliverable head to match the already-validated
40- or 64-character source object format before signing it. An actual
ArtifactStore upload regression checks all head lengths 39 through 65 for
both formats. It failed before the fix and passed afterward. The runner's
19 focused canonical cases passed, including a 17 MiB native pack, unchanged
source HEAD, scratch removal and rejection of oversized diagnostic output.
The independent-history test places source under the checkout target directory
and leaves snapshots in system temp, so hosted Windows exercises D: to C:.

Locked `pnpm check` executed parent 712a30eb018fa2325f889bdc4fd539161e2c0f3a, candidate tree
d3b0f0d56e4dd7e81518cf808d67bcaef02b5c3a, and passed all 11 current named gates.
Full Node discovery: 3091 total, 3026 passed,
0 failed, 65 skipped,
0 cancelled and 0 todo.
Rust: 858 passed, 0 failed,
558 ignored across 41 summaries.
The EVM result is separate. Skips and ignores do not establish acceptance.

Fresh native Windows graph/readiness/identity/budget and Factory publication
fixtures passed with owned databases, native CLI/server/runner binaries and
verified cleanup. Fresh Edge-to-server-to-native-runner acceptance rejected
physical-CRLF migration checksums, completed the canonical-LF mission, downloaded
its accepted bundle, and imported a clean commit passing 57 migration checks.
All 56 historical SQL hashes remained unchanged; an outsider download returned
404. Four original screenshots and the browser report preserve the observations.
Each fixture retains its actual source and binary identity, including the
browser rebuild after the CLI/server/runner fixture build.

source-equivalence.json preserves earlier #172 scheduler and #56/#221/#224
budget/correction acceptance identities and names the three current changed
files. It does not claim those older acceptance commands reran. Existing evidence
remains in ../integration-correction, ../process-cleanup and the separate
2026-09-27-budget-and-correction-acceptance packet.

This machine has only writable C: storage. Actual hosted Windows cross-volume
success and every final-head required CI, CodeQL, code-quality/security and
review gate remain independently required. The publication commit adds only
separately validated evidence after the tested candidate tree. Deterministic
providers, synthetic GitHub and loopback trust do not establish live inference,
deployment, production authentication, independent human review or OS isolation.
Environment-only delivery is reduced assurance. Signature/header equality is
recorded linkage, not an independent cryptographic verification. Historical
Cargo debt remains 12 advisories (2 high, 1 moderate, 9 low).

The initial unpublished packet failed the Git whitespace gate on captured
script CRLF endings and a final blank line. Only those publication copies
were normalized to LF with one terminal newline. The manifest records each
transform and both original and published hashes; the original drivers and
failed validation are preserved. The publication gates are unchanged.
