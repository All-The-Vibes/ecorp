# Read-only CI maintenance handoffs

`tools/ci_maintenance.mjs` observes one exact completed attempt of the existing
**Repository checks** or **CI** workflow in `All-The-Vibes/ecorp`. It reads GitHub's workflow,
run, job/step and artifact metadata and produces a bounded reviewer handoff. It
does not read logs or download, extract or execute artifact contents. It cannot
create issues/comments, change source or labels, rerun workflows, merge or deploy.

The separate `ci-maintenance.yml` workflow consumes `workflow_run: completed`.
Both workflow names are explicitly selected. The observer reads the selected
native attempt first, resolves its exact workflow path against this two-entry
allowlist, then verifies its workflow ID, path and name with native metadata.
It never constructs a workflow endpoint from an arbitrary supplied path.
GitHub must first receive the reviewed workflow and tool on the default branch;
an unmerged workflow is not an activated hosted chain. It checks out the trusted
default-branch `github.sha`, never the triggering PR or its artifacts. Native
event identity and the actual observer checkout are checked again by the CLI.
The job has only `contents: read` and `actions: read`, uses the ephemeral native
`GITHUB_TOKEN`, and retains its own bounded output artifact for 14 days.

This repository-scoped path needs neither a personal Project credential nor a
fictional `github-actions` user identity. It does not call `/user` or the Projects
API. The separate manual Repo Steward pilot, account profile, approvals and
Project scope remain unchanged. No persistent schedule is installed.

## Observe a selected attempt locally

Use the installed GitHub CLI's existing authenticated read access. Provide the
exact run ID, attempt number and 40-character head SHA. The output directory must
be a new absolute path with an existing, unredirected parent:

```powershell
node tools/ci_maintenance.mjs observe --run-id <RUN_ID> --run-attempt <ATTEMPT> --head-sha <HEAD_SHA> --out <NEW_ABSOLUTE_DIRECTORY>
```

The command refuses an active run, another repository/workflow/head/attempt,
incomplete or inconsistent pagination, duplicate identities, redirected files
and output reuse. The fixed limits are 12 GET requests, 120 seconds overall,
20 seconds per request, two MiB of combined API metadata, 200 jobs, 100 steps per
job and 20 artifacts. The API errors themselves are withheld. A failed observation
retains a bounded failure record and is never retried automatically.

## Workflow-specific completeness

Repository checks retains its existing five required jobs and report artifacts.
CI requires `quality`, `integration`, all three `runner-platforms` matrix jobs
(`ubuntu-latest`, `windows-latest`, `macos-latest`), and `desktop-windows`.
The integration report is `integration-evidence`; the platform reports are
`runner-platform-ubuntu-latest`, `runner-platform-windows-latest` and
`runner-platform-macos-latest`. The quality and desktop jobs have no required
artifact, but their absence, skipped result or neutral result still needs review.

Additional diagnostic artifacts, including the newer Windows ACL readiness
receipt, are not required for historical producer heads that did not emit them.
Their presence cannot establish that an earlier failed test passed. This
observer does not select, download or inspect their contents.

On success, `receipt.json` binds the selected source, normalized metadata, request
digests and findings; `handoff.md` links directly to affected native jobs. The
summary contains no raw GitHub response, account metadata, secret values or logs.
Required job omissions, failure/cancellation and missing/expired expected-report
metadata are classified. A replacement success job cannot hide missing required
jobs. Required jobs marked skipped or neutral also require review, even if an
artifact from an earlier attempt is listed. The tool does not guess a code defect
or read coverage percentages. Failed
GETs still consume the shared request bound; there is no automatic retry.

GitHub's artifact listing is run-scoped and does not establish which attempt
produced an artifact. A listed artifact therefore does **not** prove that the
selected attempt passed tests or produced valid coverage. Missing evidence is
never treated as success. Reads are not an atomic GitHub transaction; a final
run-state check detects selected-run drift, without granting future authority.

## Compare an observation without duplicate review work

Supply a previous exact receipt and its SHA-256 with a new output directory:

```powershell
node tools/ci_maintenance.mjs observe --run-id <RUN_ID> --run-attempt <ATTEMPT> --head-sha <SAME_HEAD_SHA> --previous <PREVIOUS_RECEIPT> --previous-sha256 <SHA256> --out <NEW_ABSOLUTE_DIRECTORY>
```

The prior contract, repository, workflow, source/ref and event must match. Its
integrity and derived findings are rechecked; newer or contradictory prior
observations are refused. Identical semantic facts yield `no-op`. Changed facts
identify new/changed findings and findings no longer observed. The latter are not
claims of a verified source repair. A different source requires a fresh scope.
Hashes prove byte consistency, not authenticated historical approval.
Repository checks keeps its existing receipt contract and finding identities;
CI has a separate classifier contract and workflow-scoped finding identities.
A previous observation from one workflow cannot supply a no-op or resolved
finding for the other, even at the same source commit. Existing command flags
are unchanged; native run identity selects the allowed workflow.

The hosted job does not automatically restore prior artifacts or claim durable
cross-run deduplication. Its concurrency and artifact identity bind the exact
parent run/attempt; comparisons remain explicit until an independently validated
prior-artifact selection path is implemented. No untrusted artifact supplies code
or execution authority to this workflow.
