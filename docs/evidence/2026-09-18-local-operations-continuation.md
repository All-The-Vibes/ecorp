# Local operations continuation — September 18, 2026 UTC

The latest qualified CodeBlend result remains **92.0 structure / 68.25 operations**
from run `20260918-161135+0800` on `69598e0`. This continuation adds useful local
operating capabilities; it does not establish a new score or meet the 90-point
operations objective. At the end of this validation slice, changes were left
uncommitted above `15fa304` under the then-current 90-point publication condition.
The operator subsequently requested publishing all prepared changes and the
measured score, superseding that condition. See the
[team report](../reports/ecorp-codeblend-readiness-2026-09-18.html) for the shared
assessment and delivery summary.

## Changes

Local Repo Steward maintenance can use an explicit, hash-pinned account profile.
It retains the exact existing repository and Project, the hosted pilot default,
bounded two-pass reads, freshness checks, deduplication and terminal stop. It
checks the actual GitHub identity before and after collection and binds the
selected profile into receipts and checkpoints. Account/profile/source drift
refuses reuse. It changes no credentials, permissions or remote state and installs
no scheduler. See the [operator instructions](../../scenarios/repo-steward/README.md#local-recurring-audits-and-feedback).

The [behavior importer](../OPERATION_FEEDBACK.md#retain-historical-behavioral-findings)
turns selected retained native records into candidates in the existing advisory
corpus. Its fixed append comparison reads bounded, hash-pinned files; it never
executes the supplied historical checker. Original native scope, source, contract,
resume instruction and both verification outcomes remain bound. Reimports of one
execution cannot inflate repetition. Historical candidates cannot be activated by
a local review digest, including forged activation history or mixed evidence.
Native adoption's existing current-run, source and authority requirements remain.

## Validation

The final frozen-source lanes ran concurrently:

| Command | Result | Test duration |
|---|---:|---:|
| `pnpm test:unit` | **1,135 passed; 0 failed; 0 skipped** | 52.42 s |
| `pnpm test:steward` | **211 passed; 0 failed; 0 skipped** | 91.51 s |
| `node tools/check_documentation.mjs` | Passed | 0.13 s process |
| `node tools/check_migrations.mjs` | Passed | 0.16 s process |

The two test lanes include the new importer, account/profile restrictions,
unchanged pilot behavior and native-adoption refusal regressions. Compiled native
MCP opt-ins were enabled in the full unit lane. Node was pinned to 22.23.2; the
native gateway and all Rust/Cargo source inputs match the previously validated
build. This slice changes Node tools and documentation, with no new Rust, web UI,
database schema or provider behavior. It does not claim fresh Rust coverage or
browser-to-runner execution.

All 723 tracked/untracked source inputs were byte-pinned before and after those
lanes, with no drift. Source-manifest digest:
`976a3523d6b8d9fa976ed900745e10540f559efa6c27be9394272e6a18e38087`.
The external validation summary SHA-256 is
`7eb57586bd5fcad92eac23d9a486c8e56c794f9d4a049e011d4d74aa3ba97c4e`.
This evidence report was added afterward and receives a documentation/diff check.

## Actual retained-file acceptance

The CLI imported the original V1 and V4 files into a new candidate corpus. An
independent read-only audit verified both manifest hashes and all 16 referenced
file hashes. Neither historical run was resumed or reclassified:

| Historical case | Native result | External append check | Instruction distinction |
|---|---|---|---|
| V1 | Completed; 3/3 native checks; 14/14 functional cases | Rejected extra separator CRLF | Resume prompt did not explicitly forbid a leading separator. |
| V4 | Completed; 3/3 native checks; 22/22 functional cases | Rejected extra separator CRLF | Resume prompt explicitly forbade a leading separator or blank line. |

Both preserved the original byte prefix. This corrects the earlier gap analysis's
overstatement that both proved equivalent instruction violations. Instruction
alignment remains unreviewed in the imported records. V1's oracle binds a retained
workspace; V4 additionally records the exact target SHA-256. Local integrity checks
do not authenticate the historical service or reviewer.

Actual CLI activation returned `FEEDBACK_REVIEW_AUTHORITY` and created no output.
Explicit rejection succeeded into a separate retired corpus, preserving the
original candidate. The accepted import's SHA-256 is
`3594bbefc752fbf65c0b95e8c6861ffdbead68d7aa1ef4b3fbf5c180241c1145`;
the importer is pinned to
`639120f939742dbdcbe2fa197850bde665a5eeb1b8ae52cfa27a815ed09373a0`.

Retained development failures include one CLI option parser failure (`sha256`
contains digits) fixed before final validation, and an initial import acceptance
against an unfinished schema. The latter was preserved and repeated in a new
output directory after source freeze; original evidence was unchanged.

## Live read-only cadence

The actual installed GitHub CLI completed three bounded two-pass reads using the
explicit account profile and exact current `main` commit
`0b1ad59da398e3dbd6a696d0264bcb6ebd620219`:

| Capture (UTC) | Outcome | New / resolved advisory findings |
|---|---|---:|
| 08:46:07.002 | Recorded initial report and handoff | 157 / 0 |
| 08:47:44.827 | No-op; reused the existing report and handoff | 0 / 0 |
| 08:49:22.279 | No-op; reused the existing report and handoff | 0 / 0 |

Each capture has a distinct snapshot digest. Their semantic evidence digest is
unchanged, so fresh observations did not duplicate handoffs. Stop/status confirmed
a durable `stopped` state with three attempts at 08:49:23.060 UTC. The profile and
all eight implementation pins stayed unchanged. GitHub mutations, native missions
and provider invocations were all zero. The final result SHA-256 is
`b1c20aa2703a2086a1f3181b5b1de79c3c120979322693c24375a3241381f899`.

This proves a finite local live audit and no-op handling. No issue changes were
observed in the interval. It does not establish a persistent hosted schedule,
automatic delivery, native task acceptance or learned decision quality.

An independent read-only audit verified the retained import/lifecycle artifacts,
the three capture receipts, unchanged implementation/runtime pins, terminal stop
and absence of a retained writer lock. Its report SHA-256 is
`3d6d3b9733bb35939ffc3cf943e1f6e9a424424fbe7d8695a7ee9f9f2acc4270`.
It made no live requests and did not replay raw GitHub responses; its checks bind
the retained execution receipts and pinned collector implementation.

## Remaining operations gap

These changes prove bounded maintenance and honest evidence admission. They do not
prove authenticated rule promotion, improved later behavior, autonomous shipping
or sustained accepted agent contributions. No new expensive full assessment was
run while those known prerequisites remain absent.

Live ownership review found [#280](https://github.com/All-The-Vibes/ecorp/issues/280)
and [#95](https://github.com/All-The-Vibes/ecorp/issues/95) still In Progress, with
[#269](https://github.com/All-The-Vibes/ecorp/issues/269) dependent on them. The
reported #280 branches are unavailable in the connected checkouts and original
remote. Its exact source or reviewable bundle is needed for integration; this
continuation does not create another autonomy/review engine. The existing native
MCP implementation already has hosted tests, so no duplicate was added to satisfy
the scanner's incomplete server inventory.

Under the current D3 and D9 caps, 90.5 requires every other dimension at 4. A
candidate-only importer and a short read-only cadence do not establish that
operating model. No commit, PR, merge, deployment, account switch or persistent
automation was performed in this continuation.

## Subsequent publication preparation

The operator later requested publishing all prepared changes and the measured
score, with a standalone HTML report. All nine contributor gates passed for that
preparation. Fresh `cargo fmt --check`, Clippy with warnings denied, workspace
tests, web build/lint, migrations and documentation checks completed successfully.
Windows Rust tests passed **561**, with **343 ignored** and zero failures, in
86.34 seconds. The 1,135 web/tool and 211 Steward test receipts above were reused
only after verifying identical executable-source hashes. The report additions
receive a final documentation and diff check.

Validation used Node 22.23.2, pnpm 11.19.0 and Rust 1.98.1. The complete external
publication-validation summary SHA-256 is
`9b6b0d4c708ca64938fc89bcfc8d8fe1ae5fabde4f826e402b2da3636cfcbf76`.
No further provider inference or full benchmark is implied by these gates; the
last qualified score remains bound to `69598e0`.
