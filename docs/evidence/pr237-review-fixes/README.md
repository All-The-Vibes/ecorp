# PR237 round 2: portable local test evidence

Packaged September 21, 2026 for **EVID237-03**. This is a selected receipt packet,
not another audit or a finding-resolution decision. Source remains uncommitted
and is being changed by other workers. The base commit recorded in receipts is
lineage, **not proof of the tested working-tree bytes**.

**No full baseline green, native Factory/budget-recovery acceptance, Santa NICE,
approval, or merge readiness is claimed.** No full Factory/budget-recovery
scenario ran here. The four original historical native synthetic runtime reports
remain unavailable; this packet does not reconstruct or replace them.

## Read the packet

- `receipts/` contains selected original command records, test logs, stage hashes,
  and eight fixer reports. A report's own “fixed” status is its historical author
  statement, not this packet's disposition.
- [checksums.json](checksums.json) lists every packaged file except itself,
  with SHA-256 and byte count. Receipt entries also retain the original relative
  path, digest, size, filesystem timestamp, and any transformation.
- [source-consistency.json](source-consistency.json) compares recorded source
  digests with a dated packaging-time observation. That observation is **not a
  test run**. Differences require current-source revalidation for the affected
  receipt; RED/before-edit differences are expected.
- [command-records.json](command-records.json) preserves the three DB-test wrapper
  texts and expands the Node command's recorded ordered suite list. These are
  transcriptions, not newly executed commands.

Command timestamps and exit codes remain in their original JSON, including UTC
and `-05:00` offsets. File modification times in the manifest are not command
timestamps. Absolute paths inside raw receipts identify the original host;
all selected evidence is readable through this packet's relative paths.
References inside original reports to omitted artifacts remain historical
references, not promises that those files are included.

## Real RED/GREEN and focused evidence

Counts below are per invocation, overlap, and must not be added into a unique
test total. Open each report and its neighboring command/log files for the
original command, time, scope and hashes.

| Finding / receipt directory | Expected RED | Recorded GREEN and boundary |
| --- | --- | --- |
| PR237-B-001 / ATV237-02: [DB target](receipts/fix-db-target/report.json) | 6 pass, 58 fail of 64 Node entries: 57 negative subtests plus their parent fail at the blocked write boundary | 64 pass; affected suite 75 pass, 1 skip. Validation/spies, not a SQLx connection or native service lifecycle. |
| A237-02 / PR237-B-002 / ATV237-01: [process uncertainty](receipts/fix-process-uncertainty/report.json) | 13 pass, 24 fail across 37 native fault checks | 37 pass; process suite 6 pass; lifecycle Module 20 pass and Source 10 pass. Inert owned children and injected native lookup/getter faults, not OS ACL revocation or full recovery. RED-to-GREEN sentinel reset is disclosed in the report. |
| A237-01: [predispatch identity](receipts/fix-predispatch-identity/report.json) | Final RED: 9 pass, 2 fail of 11 entries | Final GREEN: 11 pass; affected suite 82 pass, 1 skip. Mocked native-output contract, not native identity-capture qualification. The first failed GREEN and its escaped read-only lookups remain included. |
| PR237-B-003: [attempt path](receipts/fix-attempt-path/report.json) | Confirmed RED: 1 pass, 8 failed entries, including parent; 7 failing subcases | 19 pass across process/config suites, including 8 path scenarios. Actual junctions with extracted admission/cleanup bodies and a stubbed lifecycle, not full driver execution. Initial extraction setup failure is separate from RED. |
| A237-03: [primary ACL](receipts/fix-cold-primary/report.json) | Ordering and corrected-filter contract runs each: 2 pass, 1 fail | Final contract 3 pass; corrected native primary invocation **1 pass**, storage suite 5 pass. The earlier exit-zero invocation ran **zero tests** and does not qualify. Native BEFORE/AFTER arrays contain the same 44 inputs. No hosted-cold performance or production-defect RED is claimed. |
| QA237-01: [review proof](receipts/fix-review-proof/report.json) | Final-test replay on pre-fix assertion bodies: 8 pass, 52 fail | 64 pass: 60 guard cases plus 4 config cases. Extracted actual assertions and controlled data, not native authorization or scenario acceptance. Replay changes the source-read path; test/source hashes remain distinct. |

### Ponytail deletion-only RED exceptions

These are **not additional RED/GREEN behavior-fix cycles**:

| Finding | Before / after evidence | Why no manufactured RED |
| --- | --- | --- |
| [PONY237-01: obsolete readiness](receipts/fix-obsolete-readiness/report.json) | 25 pass before; 23 pass after; preservation checks retained | Removed two obsolete mechanism tests with unused exports; retained behavior remains covered. |
| [PONY237-02: duplicate verification](receipts/fix-duplicate-verification/report.json) | 19 pass before and after; exact deletion-equivalence check passed after restoring incidental CRLF changes | Removed redundant assertions already enforced by the unchanged helper. Initial byte-equivalence failure is retained as a qualified excerpt, not behavioral RED. |

## Combined checks and failed workspace attempts

| Check | Recorded result | Receipt |
| --- | --- | --- |
| Nine serialized Node guard suites, September 21, 00:41:03–00:41:23 UTC | **191 pass, 0 fail, 1 skip**; owned-service opt-in off | [command/result](receipts/node-integration-results.json), [log](receipts/node-integration.log), [127 input hashes](receipts/node-integration-inputs.json) |
| Native primary ACL, September 21, 00:33:16–00:33:34 UTC | Exactly 1 pass, 0 fail; separate from zero-test attempt above | [command/result](receipts/rust-baseline-results.json), [log](receipts/baseline-primary-acl.log) |
| Migration checker; format; workspace all-target Clippy | 41 immutable migrations; format exit 0; Clippy exit 0 | [migration command/result](receipts/web-baseline-results.json), [migration log](receipts/baseline-migrations.log), [Rust commands/results](receipts/rust-baseline-results.json), [Clippy log](receipts/baseline-clippy.log) |
| Web build/lint with recorded proxy descriptor | Both exit 0; initial registry/TLS build failure remains a failure | [proxy results](receipts/proxy-web-results.json), [build](receipts/proxy-build-web.log), [lint](receipts/proxy-lint-web.log), [initial failure](receipts/baseline-web-build.log), [lock readback](receipts/proxy-lock-readback.json) |
| Original `cargo test --workspace`, 00:35:38–00:39:12 UTC | **Exit 101. Runner: 160 pass, 54 fail, 1 ignored.** 53 explicit Git path-limit failures; remaining failure not waived | [results](receipts/rust-baseline-results.json), [full log](receipts/baseline-workspace-tests.log), [classification](receipts/workspace-path-failure-summary.json) |
| Short-temp retry, 00:44:40–00:46:16 UTC | **Exit 101. Runner: 205 pass, 9 fail, 1 ignored.** 8 explicit Git path-limit failures plus checkpoint failure | [result](receipts/workspace-short-temp-result.json), [full log](receipts/workspace-short-temp.log), [classification](receipts/workspace-short-temp-failure-summary.json) |
| Compact-temp retry, 00:48:09–00:49:47 UTC | **Exit 101. Runner: 213 pass, 1 fail, 1 ignored.** Native setup operation timed out | [result](receipts/workspace-compact-temp-result.json), [full log](receipts/workspace-compact-temp.log) |
| Continuation focused isolation, 05:29:47–05:30:58 UTC | Exactly 1 pass in a separate filtered invocation; qualified against the retained Rust inputs by the continuation readback below | [command/result](receipts/continuation-01a0c269/native-isolation.json), [log](receipts/continuation-01a0c269/native-isolation.log) |
| Continuation serialized workspace, 05:30:58–05:37:56 UTC | **Exit 0: 555 pass, 343 ignored, 0 fail**, summed across 14 result blocks; serial Windows-host qualification only, never a replacement for the three parallel failures | [command/result](receipts/continuation-01a0c269/workspace-serial.json), [full log](receipts/continuation-01a0c269/workspace-serial.log), [source readback](receipts/continuation-01a0c269/rust-source-readback.json) |
| Genuine current screenshots | **Pending parent-supplied captures and binding; none packaged** | No generated or fabricated images |

All workspace attempt times above are September 21, 2026 UTC. Failed-attempt
runner counts are not complete-workspace totals; those commands stopped before
completing the entire workspace. Ignored/skipped tests are not executed passes.

### September 21, 2026 continuation addendum

The completed serialized command was
`cargo test --workspace -- --test-threads=1`. Its 555 passes do not include the
separate focused isolation pass. The 343 ignored tests did not execute; the
serialized log reports zero filtered tests.

The parent's [explicit source readback](receipts/continuation-01a0c269/rust-source-readback.json),
verified at **05:41:33 UTC**, identifies both continuation commands and records
**105 unchanged before/after input pairs, zero changes**. Each `before` digest
was checked against the already packaged `rust-baseline-inputs.json`; each
`after` digest equals it. This binds the qualified Rust results to that enumerated
input set, not to HEAD or the concurrently changing MJS source. The before
capture is the retained baseline, not a newly invented per-command snapshot.

Only the serialized result/log and explicit readback were added. Existing
focused-isolation receipts and all original failure receipts remain byte-identical.
`source-consistency.json` preserves its original dated packaging observation;
this addendum supplies the continuation evidence that was missing at that cutoff.
**Current-source Node revalidation remains pending.** Historical native scenario
proof and genuine current screenshots remain incomplete; no finding is resolved
or approval/acceptance granted by this addendum.

## Source binding and remaining limits

The combined Node run captured 127 tool-file hashes before execution and recorded
`changedInputCount: 0` afterward. At packaging, the budget-recovery driver differs
from that captured input. **Current-source revalidation is pending**: neither the
191-pass run nor the earlier QA237-01 GREEN proves the newer source-binding edit.
The test-file hash still matched at this observation; that does not repair the
driver mismatch.

Earlier DB, process, attempt-path and obsolete-readiness stage snapshots also
differ where subsequent workers changed shared files. Each stays attached to its
own recorded bytes. The source-consistency JSON lists all exact hashes, including
expected before-edit differences; no stage snapshot is silently relabeled as a
per-command BEFORE/AFTER pair.

The Rust sequence has 105 captured inputs and a subsequent unchanged-count
readback; the web sequence has 97 inputs and its own unchanged-count readback.
Those enumerated inputs matched at packaging. These are bounded input sets, not
a claim that HEAD or every dependency was tested. Short/compact retries lack
fresh independent per-command hash pairs. The continuation addendum supplies
the later explicit readback against the retained Rust baseline, not separate
new before-captures for each command. Missing captures cannot be reconstructed
after the fact.

No application, tool, CI or historical evidence source was changed by this
packaging task. No test/service/DB/Factory scenario was launched, no dependency
installed, and no commit or push performed. Independent review and finding
disposition remain with the parent/reviewers.

## Transformations and integrity

One log is an **excerpt, not an exact original**:
`receipts/fix-duplicate-verification/equivalence.initial-line-ending-failure.log`.
It retains numbered original assertion/stack/error lines while omitting the
echoed full driver, including its embedded development database URL. The manifest
retains both original and packaged digests, original size and retained line
numbers. All other selected receipt files are byte-identical.

No agent transcripts, prompt files, auth/credential/DB files, source snapshots,
build outputs, whole state directories or workspaces are included.

From this packet directory, this read-only PowerShell check verifies the packaged
bytes. It does not rerun tests or validate current source:

```powershell
$manifest = Get-Content -LiteralPath ./checksums.json -Raw | ConvertFrom-Json
foreach ($entry in $manifest.entries) {
    $actual = (Get-FileHash -LiteralPath $entry.path -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $entry.sha256) { throw "Checksum mismatch: $($entry.path)" }
}
"Verified $($manifest.entries.Count) files."
```

Stop condition: portable receipt selection and integrity/source-consistency
checks complete; outstanding revalidation, screenshots, scenario evidence and
independent acceptance remain explicit, not marked resolved.
