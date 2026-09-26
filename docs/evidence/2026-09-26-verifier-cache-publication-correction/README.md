# Verifier cache evidence publication correction

Date: September 26, 2026. Issue #140; implementation PR #294.

PR #294 review overview `5288797394` and author confirmation comment `5796271405`
identified caret-escaped local account paths on line 48 of three published
stack-start logs. Ordinary Windows path matching had missed those escaped forms.
The six account roots now use `<USERPROFILE>`; all other log bytes are unchanged.

The [manifest](manifest.json) records the previous and corrected published hashes
of all affected files. Each packet's `source-binding.json` now names the corrected
log hash. The September 23 integration binding also names the corrected r3 source
binding. All 105 existing artifact and retained-integration hash references were
checked against the corrected publication before writing it.

Original raw copies are retained privately in ignored completion evidence. The
`original_sha256` execution hashes, result text, dates, drivers, tests, screenshots,
and original validation receipts are unchanged. Dated additions to the four
packet READMEs qualify their earlier publication and immutability statements.
The `prior_packets_unchanged` field in the historical r3 binding describes that
original replay; it does not claim these September 26 publication edits occurred
before the replay. This correction is not a new runtime execution.

The publication was prepared from main
`08ed24829e033a39a8913d52be6a136eac1cc2aa`. It changes no application code,
dependencies, test configuration, historical replay driver, or cleanup policy.
The issue's current-main runtime acceptance was exercised separately on
September 26 and is recorded in the issue completion evidence; it must not be
confused with the original September 22 and 23 runs.
