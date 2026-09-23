# PR226 current validation: public evidence derivatives

September 22, 2026. **Evidence packaging plus the explicitly new retrospective
single-regression pair below; no nine-gate run or heavy build repeated.**
Read [the saved-results report](results.html), its [genuine Edge screenshot](results.png),
and [manifest.json](manifest.json). Complete selected logs, receipts and executed-driver
derivatives are in [receipts.zip](receipts.zip). Nothing in the ZIP is to be executed
as part of reading this packet.

## Exact input and separate lanes

- R8 HEAD: `91a5b4e58a13eb0128f3f69beedcb9bd174fbb23`.
- R8 tested pending tree: `2cf0ea4851f09cbdb7cf3f08a6c3422abda416a8`.
- Pending MERGE_HEAD/main: `08b0b89b2dd16c1906c9dd3468c5ddecca24c4ce`.
- R7 correction chronology: actual missing-default-root RED (0/1), covered-leak
  RED (0/1), then six-case scanner GREEN (6/0); the existing R7 handoff records
  that order and exit 1/1/0. Logs lack independent per-RED source snapshots or
  timestamps: none are invented. The 16-case focused GREEN is separately retained.
- R7 original contributor pass remains **8/9**. Rust exit **101**, 366 passed,
  9 failed, 1 ignored in reached suites; later suites were not reached.
  The initial selected diagnostics retain exits 101/101/0; a later unchanged-binary
  short owned-TEMP probe passed 1 case. Only then did a real unfiltered full Rust
  rerun pass **566 / 0 / 343 ignored**, exit 0. These bind R7 HEAD
  `9d79db02c814497f93eed4b8d7c842cb2518d153`, candidate tree
  `c71eec9d7617d5879c596f646615167a6633a566`, target
  `de12261d045ddfccf790bcfd04a7fa254563d456`, not R8.
- R8 actually executed all **nine** required commands on the new-main merged
  source: Node **1,259**, Steward **227**, Rust **571 / 0 / 343 ignored**;
  focused **16/16**, zero skips. The native MCP build/binary is bound; 43 native
  cases executed within the Node total, not additional tests. Five new-main
  receipt tests appear in the full Rust log.
- AUTHOR-DELEGATE self-review actually completed: **387 assertions** over
  **276 contribution files / 5,943,365 bytes**. This is not independent approval.

## NEW retrospective effectiveness pair (not original R7 chronology)

On September 22, 2026, the existing current
`retained PR226 packets including r3 are scanned for personal user paths`
regression was executed in two new owned private fixtures. Both complete input
inventories and source/tool/driver/argv bindings were persisted before either
invocation. No new test, mock, default-root override or production edit was used.

- **OLD: exit 1, 0 passed / 1 failed.** Helper and all files in its two default
  packets plus r3 were exported from exact commit
  `9d79db02c814497f93eed4b8d7c842cb2518d153`. Helper blob:
  `48c8a593e23ca122e16f2ada5db0e73d4d036d5f`. The test failed at
  `default scan must include the r3 completion packet`, before the scan.
- **CURRENT: exit 0, 1 passed / 0 failed.** Helper index blob:
  `9b77198637139fff907cc0a20d245c4a071487e1`, in candidate tree
  `2cf0ea4851f09cbdb7cf3f08a6c3422abda416a8`. It passed the real default-root
  check and recursive scan of all three exact candidate-index packets,
  including normalized r3.
- Both fixtures used the **same unchanged current test**, index blob
  `61839dfbfc30adc8adabbafeee73c021264553c6`; this regression was introduced
  after the baseline. Each invocation selected one of six declared tests:
  **five excluded by name pattern; Node reported zero skipped**. This is not
  a six-case rerun.
- Current helper/test fixture copies are byte-exact working copies. Their
  separately recorded index bytes differ only by normal CRLF checkout
  conversion; native Git clean hashes match the index blobs. Docs are exact
  raw Git blobs. The new untracked `current-validation/` packet and parent
  README's unstaged link are excluded from fixture inputs, not silently
  attributed to the tested index.
- Node **24.19.0**, its binary hash, the actual driver/interpreter hashes,
  command argv, original/candidate blobs and every copied file hash are bound
  in `round8-packaging/retrospective-pair/{old,current}.before.json` inside
  the ZIP. Actual exit/log hashes and unchanged fixture/source/index/MERGE_HEAD
  receipts are separate. No original R7 per-RED identity or timestamp is recovered.

The first six-file packet, first genuine PNG and original packaging drivers are
privately preserved byte-for-byte. Their hashes are retained in
`first_packet_preservation` in the manifest. Existing ordered R7 proof is unchanged.

## Preserved failures and authority

The R8 global shared-ref audit and its attempted reconciliation remain failed.
Concurrent unrelated PR362 branch creation and Codex metadata-ref changes made
whole-repository preservation false. The separate 197-check final readback
preserved the exact PR226 source/index/merge state and selected local refs.
This is neither a product-test failure nor a claim of full global preservation.
Local tracking refs are not a fresh remote publication fence.

All 343 Rust ignored cases remain unexecuted (342 database cases and one
stopped-session probe). Issue #225 remains nonclosing: no live application,
browser/server/runner, provider, database, Factory/native acceptance, hosted CI,
Santa/NICE/SAFE, human or independent approval is supplied.

## Derivatives and provenance

Every selected original is read-only and its original SHA-256/byte count is
mapped to its public SHA-256/byte count in the manifest. Only local personal-root
path prefixes are replaced by `LOCAL/actor` (current local actor) or
`LOCAL/prior-source-actor` (historical source-path actor) with their original
separator encoding. All suffixes and non-path bytes are exact; no newline/whitespace
normalization was needed. Existing hashes, source IDs, exits, counts and failure
text outside those path spans are unchanged. Thus old hashes inside normalized
receipts still describe **original private bytes**, not public derivatives.
Executed-script derivatives are archival text, not newly executed drivers.

The ZIP uses an explicit selection, not a scratch-directory copy. It excludes
raw patches, baseline binaries, Cargo caches, dependencies, old/private images
and unrelated worktrees. Byte-identical source snapshots are deduplicated:
`snapshot_aliases` maps each original referenced filename to its canonical ZIP
member, retaining original hashes. The archived original artifact manifest
describes a larger private collection; it is not the ZIP inventory.

`results.png` is one unedited Microsoft Edge capture of local static `results.html`
with only that exact local file URL allowed and all other browser-context requests
blocked; no live application or tests are pictured.
The installed Playwright capture script was reused, not a new capture framework.
The manifest binds the actual HTML, PNG, browser version, driver and capture time.
The older correction screenshot and redacted failed capture remain untouched.

## Evidence-only descendant and handoff

Before packaging, all 1,148 tracked working inputs, index bytes, HEAD, MERGE_HEAD,
merge/config controls and selected refs matched the R8 frozen state.
After packaging the only exclusions from input-equivalence comparison are this
six-file `current-validation/` directory and the parent r3 README, whose entire
original bytes are retained as a prefix with one additive link. The other
1,147 tracked files, historical receipts/images, real index and merge controls
must remain exact. The output is an evidence-only descendant of the tested tree,
not a newly tested tree/commit; no not-yet-existing SHA is credited with execution.
The final hypothetical Git output-tree ID is in the private handoff because
embedding that ID inside its own tree would be self-referential.

The parent owns final independent scoped reviews, live remote re-fencing and
normal publication. This packet confers no approval. No staging, commit, push,
source/test changes, heavy builds or shared-stack changes were made. Only the
explicitly authorized existing-regression retrospective pair was newly executed.
