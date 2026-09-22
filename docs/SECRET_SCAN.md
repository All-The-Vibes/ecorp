---
title: Secret scan diagnostics
description: Attribute secret-scan failures without publishing matched values or weakening the scan.
---

## Read the result

The **Secret scan / secrets** job checks the selected immutable commit and its
complete ancestry, not other refs. A finding can therefore belong to an older
commit rather than the current diff.

The final scan step prints a metadata-only JSON result:

* `scan_exit_code` is the native scanner exit status
* `status` is `clean` only when the scanner succeeds and its report is a valid empty array
* `finding_count`, `displayed` and `omitted` distinguish total findings from bounded output
* Each displayed finding contains its commit, relative file, start/end line, rule ID and fingerprint

Use that commit and file to inspect the relevant historical source through an
authorized local checkout. A line number refers to that commit, not necessarily
the current file. The fingerprint follows Gitleaks' commit/file/rule/start-line
format and is constructed from validated metadata, not copied from an arbitrary
report field.

Attribution is not remediation. Do not assume a finding is new, pre-existing,
false positive or safe to suppress based only on the count. Follow the
[security guidance](SECURITY.md), including credential rotation when appropriate.
Do not paste suspected credential values into issues, PRs or logs.

## Failure and disclosure boundaries

The pinned native Gitleaks release, selected-commit/full-ancestry scope, native
rules, existing fingerprint ignore file, full redaction and disabled inline
suppression remain unchanged. This diagnostic step does not add an allowlist,
rewrite history or make a failed scan pass.

Only explicitly selected metadata is printed. Secret, Match, source excerpts,
descriptions, author/email, commit messages, tags, links, nested fragments and
unknown fields are never copied into diagnostics. Native stdout/stderr and the
JSON report stay in an ephemeral runner directory and are removed by an exit
trap. They are not uploaded as artifacts. Redaction alone is not permission to
publish an arbitrary report.

JSON Unicode escapes neutralize `::` and `#` workflow-command delimiters in
metadata. Decoding the JSON preserves the original file and fingerprint identity.

Untrusted metadata is validated before output. Current bounds are:

* Four MiB per report and at most 1,000 findings
* Fifty displayed findings, with any omitted count explicit
* Full 40-character commit IDs
* Relative file paths of at most 1,024 characters, without traversal or control/format characters
* Rule IDs of at most 128 ASCII letters, digits, dots, underscores or hyphens
* Positive safe-integer line numbers with an ordered start/end range

Every record is validated, including records beyond the display limit. Missing,
empty, malformed, changing, oversized or unsupported reports produce
`diagnostics_failed` with a fixed error code, never raw input or parser exception
text. A native failure stays nonzero even if no finding metadata exists. An
invalid report following native success fails with exit code 2.

If diagnostics fail, inspect installation, history retrieval and the reported
error category. Reproduce with the same pinned scanner in a controlled local
environment if necessary; do not weaken the blocking CI scope or upload a raw
report to obtain more detail.

## Implementation and validation

The reporter stays inline in
[the workflow](../.github/workflows/security-scan.yml) because the selected scan
head can predate support scripts or runtime declarations. Its Node 24.19.0
runtime matches the current repository pin but is selected independently of
that scanned head.

Run the exact embedded reporter regression tests with:

```powershell
node --test tools/secret_scan.test.mjs
```

The ordinary repository Node suite discovers this test file. Tests exercise
the actual workflow program, metadata projection, failure propagation, malformed
input, output injection attempts, limits and scan-policy invariants. These tests
do not resolve existing findings or establish that a particular branch is clean.

The secret-scan job also runs `tools/secret_scan_native.test.mjs` with the verified
Gitleaks 8.30.1 executable before scanning the selected head. It creates disposable
Git histories and passes real native reports into the exact inline reporter.
Clean history, a current finding, a finding removed from HEAD but retained in
history, and an invalid scanner configuration must retain their native outcomes.
The finding cases use a generated noncredential marker and a test-only rule
outside the fixture repository; they do not change production rules or ignores.
Raw reports and scanner output are removed after the checks.

For the same offline native acceptance locally, set `ECORP_GITLEAKS_BINARY` to an
already verified Gitleaks 8.30.1 executable and run
`node --test tools/secret_scan_native.test.mjs`. An explicitly selected missing or
wrong-version binary fails; without the variable, only these four native cases
skip in the ordinary unit lane. The CI step supplies it explicitly.
