# Native advisory feedback acceptance — September 18, 2026 UTC

The new feedback CLI can append exact, reviewed advisory references to a saved
Direct task through ECorp's existing contract-revision transaction. It accepts a
corpus carried by either a verified raw artifact or a selected file in a native
typed artifact set. Applying a proposal preserves all other task fields and the
complete verifier policy. Launch remains a separate native action.

The owned Windows acceptance run passed **15/15 assertions** in **62.380 seconds**
from `2026-09-18T07:20:52.963Z` to `2026-09-18T07:21:55.343Z`. Three actual native
runner executions passed **9/9 persisted verifier checks**. The source was
`c592033c7917409e839bc5e832eae406786007da`; the CLI and driver were the additional
byte-pinned integration changes listed in the
[public evidence summary](assets/codeblend-readiness/native-feedback.json).
Native Rust binaries came from the verified integrated Rust source at `d4dad1ba`.

## Observed native behavior

| Case | Observed result |
| --- | --- |
| Raw corpus adoption | One reference-only native revision; exact replay created no second revision. A separately launched task received each reference once and passed all three checks. |
| Typed corpus adoption | Exact `corpus.json` bytes were validated in memory against the accepted native envelope, source, verifier and artifact. A separate target received the selected references and passed all three checks. |
| Stale receipt and wrong review bytes | Preparation remained candidate, with no revision or run. |
| Unauthorized actor | The actual server denied the nonmember actor and preserved the target. |
| Lost response after commit | An owned forwarding proxy replaced one successful native revision response with HTTP 400. Apply reported `outcome-unknown`; the original key/body reconciled to the single committed revision. The target stayed unlaunched. |

Read-only browser follow-up confirmed all three completed runs, their selected
run evidence and 3/3 checks each. The typed target displayed contract/specification
version 2, exactly one revision, the selected rule and artifact/file references,
the original filesystem-only tool allowance, 80,000-token budget and
`guidance-observation.json` write scope. The fault target displayed version 2,
one revision and zero runs.

## Retained failures and corrections

| Attempt | Result and prospective correction |
| --- | --- |
| 1 | Driver duplicated the description that native mission creation already adds to the objective. It failed before launch. The driver now sends the authored objective once and checks the actual native composition. |
| 2 | Native source verification passed, but the typed export omitted the corpus because the fixture also designated it as provider evidence. The native exporter intentionally excludes provider evidence paths. A new fixture writes separate identical source and evidence files. |
| 3 | Native source acceptance and all three target checks passed. Target deliverable export then failed on a 263-character Git path. A read-only reproduction confirmed the cause. Only the owned source clone's local `core.longpaths` setting was enabled and pinned before attempt 4. |

Earlier missions, worktrees, artifacts and receipts were preserved. Neither the
exporter nor the verifier was weakened to make the fixture pass. After browser
acceptance, the ownership-checking supervisor stopped this fixture's web, runner,
server and PostgreSQL processes. Their three listeners were absent; files and
database state remain retained.

## Repository validation

All required precommit commands passed on the byte-pinned implementation:

| Lane | Result |
| --- | --- |
| Web/tool tests, including native MCP opt-in cases | **1,110 passed, 0 failed, 0 skipped** |
| Repo Steward | **195 passed, 0 failed, 0 skipped** |
| Windows Rust workspace | **561 passed, 0 failed, 343 ignored** |
| Migrations, documentation, formatting, Clippy with warnings denied, web build and lint | All passed |

The first external validation launcher mishandled Windows PATH casing, causing
five process-spawn failures and preventing the Rust lane from finding Git. The
failed receipt is retained. Only affected lanes were rerun after correcting the
launcher; source manifests confirmed identical implementation bytes throughout.
The ignored Windows Rust cases are not counted as passed. The separate fresh
Linux SQLx/coverage evidence remains documented in the
[recurring-audit report](2026-09-18-recurring-audit.md).

## Evidence scope

This is real HTTP/MCP/CLI/native-runner transport with synthetic feedback/review
inputs and the deterministic `fake-process` provider under development identity.
It proves reference adoption and subsequent prompt consumption, not provider
decision quality, authenticated independent review, human approval, autonomous
learning, hosted cadence or production operation. Source observation and target
revision remain separate transactions; post-write uncertainty must be reconciled.

No GitHub changes, publication, merge or deployment were performed. This report
does not assign a benchmark score. The latest completed full assessment remains
[V3](2026-09-18-codeblend-v3.md): **92.0 structure / 68.25 operations** at its own
historical source revision. The 90/90 objective remains unmet pending a fresh
qualified assessment and further operational evidence.
