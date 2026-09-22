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
* `findings` means the native scan completed with findings (exit 42); `scan_error`
  means it failed or stopped before completion (other nonzero native exits)
* `scan_complete` preserves that native completion distinction, including partial reports
* `finding_count`, `displayed` and `omitted` distinguish total findings from bounded output
* Each displayed finding contains its commit, start/end line and SHA-256 identifiers
  for its relative file, rule and complete finding

Use that commit to inspect the relevant historical source through an authorized
local checkout. `file_id` is `sha256:` followed by the SHA-256 of the exact UTF-8
relative path; `rule_id` uses the same operation on the native rule identifier.
Match candidate names locally against these identifiers. `finding_id` hashes the
UTF-8 JSON array `[Commit, File, RuleID, StartLine, EndLine]`. These safe identifiers
are not Gitleaks ignore fingerprints. A line number refers to the recorded commit.

Attribution is not remediation. Do not assume a finding is new, pre-existing,
false positive or safe to suppress based only on the count. Follow the
[security guidance](SECURITY.md), including credential rotation when appropriate.
Do not paste suspected credential values into issues, PRs or logs.

## Failure and disclosure boundaries

The pinned native Gitleaks release, selected-commit/full-ancestry scope, native
rules, existing fingerprint ignore file, full redaction and disabled inline
suppression remain unchanged. This diagnostic step does not add an allowlist,
rewrite history or make a failed scan pass.

Only explicitly selected metadata is printed. File paths and rule identifiers
are always hashed, because either can contain a credential and native redaction
may already have replaced the Secret/Match needed for a comparison. No raw path
or constructed raw-path fingerprint crosses the diagnostic boundary.
Secret, Match, source excerpts,
descriptions, author/email, commit messages, tags, links, nested fragments and
unknown fields are never copied into diagnostics. Native stdout/stderr and the
JSON report stay in an ephemeral runner directory and are removed by an exit
trap. They are not uploaded as artifacts. Redaction alone is not permission to
publish an arbitrary report.

JSON Unicode escapes also neutralize `::` and `#` workflow-command delimiters.

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
invalid report following native success fails with exit code 2. Exit 42 with an
empty report is inconsistent and also stays nonzero. No native error is reclassified
as completed findings just because the scanner wrote a valid partial JSON report.

Before scanning, native Git verifies that the checkout still equals the selected
commit, is not shallow and has every object reachable from HEAD. An unavailable
object emits a fixed `history_error` result and fails before scanning. This is
necessary because Gitleaks 8.30.1 can log a Git fragment error without propagating
it as a failing exit. The check reads the selected ancestry without running code
from that checkout. It does not repair or omit unavailable history.

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

The separate **native-fixtures** job checks out `github.workflow_sha`, so both
its tests and extracted inline reporter belong to the executing workflow revision.
It installs its own verified Gitleaks 8.30.1 executable and creates disposable Git
histories. Its runner, executable, refs and ignore inputs are isolated from the
production **secrets** job. The production job has no repository-executable test
prerequisite and still scans an older selected head that lacks these support files.

The native cases cover clean, current and historical findings; invalid configuration;
sensitive filenames; older heads; unexecuted head-controlled fixtures; unavailable
historical objects; and a real native timeout that retains already collected findings.
The timeout fixture uses a bounded, fixture-only Git text converter and verifies
its completion before cleanup. It does not replace or mock the native scanner.
The finding cases use a generated noncredential marker and a test-only rule
outside the fixture repository; they do not change production rules or ignores.
Raw reports and scanner output are removed after the checks.

For the same offline native acceptance locally, set `ECORP_GITLEAKS_BINARY` to an
already verified Gitleaks 8.30.1 executable and run
`node --test tools/secret_scan_native.test.mjs`. An explicitly selected missing or
wrong-version binary fails; without the variable, only these nine native cases
skip in the ordinary unit lane. The isolated CI job supplies it explicitly.
