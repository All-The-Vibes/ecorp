# ECorp Repo Steward

A runnable, **read-only** repository-steward package for `All-The-Vibes/ecorp` and
organization Project #5. Its GitHub-first path includes an evidence-backed
auditor, bounded Q&A, model-facing snapshot tools, an agent role, and a manual
GitHub Actions workflow. It makes no issue, PR, label, assignee, dependency,
Project, or ruleset writes. The optional Teams pilot is disabled and deferred;
it is not needed for local auditing or the GitHub workflow.

The deterministic auditor and Q&A work without a model. `STEWARD.md` and the five
tools in `lib/tools.mjs` are the integration boundary for an existing native
Codex/Copilot harness. No model session, autonomous watcher, ECorp agent identity,
or production deployment is created merely by installing this package.

## GitHub-only quick start

Requirements: Node.js 24+, and a native GitHub CLI installation for live reads.
The collector verifies the personal `Bakar404` identity and never switches accounts.
Use the exact repository and Project configured in `policy.json`; a same-named
replacement repository cannot substitute for the pinned repository node ID.

From this directory, the core needs only Node built-ins. Do not install the
optional Teams dependency just to use these commands:

```powershell
node --test steward.test.mjs actions.test.mjs

# Always preview before a new operation. This performs no network or file writes.
node steward.mjs audit --live --dry-run

# Offline, credential-free tests of the behavior.
node steward.mjs audit --fixture --format markdown
node steward.mjs ask --fixture --question 'What is blocking issue #236?'
node steward.mjs ask --fixture --question 'Show UX issues'
node steward.mjs ask --fixture --question 'Merge PR #237'

# Authorized on-demand GitHub reads only. No token values in arguments or output.
$auditStamp = Get-Date -Format 'yyyyMMddTHHmmssfff'
node steward.mjs collect --live --out "snapshot-$auditStamp.json"
node steward.mjs audit --snapshot "output/snapshot-$auditStamp.json" --format markdown --out "audit-$auditStamp.md"
node steward.mjs ask --snapshot "output/snapshot-$auditStamp.json" --question 'Explain PR #237'
```

Stop if collection exits nonzero; do not substitute an old snapshot and call it
fresh. The collector uses the existing approved native GitHub authentication.
Do not paste tokens into chat or place credentials in arguments or source files.
Neither a database nor an ECorp server/runner is required for this read-only path.
It is an on-demand CLI, not an always-running service or a new web UI.

`--out` creates a **new** file under this package's ignored `output/` directory and
refuses overwrite, traversal, or a redirected output directory. Pick a fresh name
for another run. Snapshot files can contain repository text; keep them private and
out of commits. Never use a credentials file as a snapshot.

Live collection performs two bounded matching passes over issues, PRs, Project
items and branch-rule metadata. It rejects incomplete pagination, count/identity
drift, unverified nested connections, source changes, a different account, and
exhausted GraphQL reserve. Two matching reads are not an atomic GitHub transaction.
A saved snapshot remains supplied data, not fresh authorization. Answers label
their timestamp and freshness. Hosted live audits refuse stale snapshots.

## Manual GitHub Actions pilot

The workflow source is `.github/workflows/repo-steward.yml`. Adding that file to a
local branch does not deploy or activate it: the approved contribution must first
pass the repository gates, review and merge into `main`. No branch-protection
bypass is part of this package.

The workflow has only `workflow_dispatch`, with no schedule or automatic issue,
PR or push trigger. Its modes are:

| Mode | GitHub data access | Output |
| --- | --- | --- |
| `preview` (default) | No live collection | Tests and a fixed-scope dry-run in the job log |
| `fixture` | No live collection | Tests and a clearly synthetic job summary |
| `live` | Approved Bakar404 reads of the pinned repo and Project | A limited public finding index, only with explicit release approval |

Exercise the entry point locally without hosted credentials:

```powershell
node actions.mjs --dry-run
node actions.mjs --fixture
```

`node actions.mjs --live` intentionally refuses a desktop context. Use the local
`steward.mjs` commands above for desktop live reads. In GitHub, a completed audit
can contain error findings: a green execution means the audit succeeded, not
that the repository is healthy or that a PR is approved to merge.

Before supplying any hosted credential, an authorized administrator must configure
the native `repo-steward-readonly` GitHub environment, restrict deployments to
`main`, require reviewer approval, and review the workflow and its imported code.
Protect changes to that trusted code through the repository's native review and
branch rules. If those native controls cannot be enforced, leave hosted live mode
disabled. A named environment and script environment-variable checks alone do
not establish authorization or isolation; writable workflow code could remove
them. Environment creation/settings are separate from this local implementation.

After that review, separately approve and privately provision:

- Environment secret `ECORP_STEWARD_READ_TOKEN`: a dedicated, expiring,
  least-privilege credential that can read the required repository metadata and
  organization Project as `Bakar404`. Verify actual access and org approval;
  do not assume a token type supports every required API. Do not copy the broad
  desktop OAuth token into Actions. The standard repository `GITHUB_TOKEN`
  cannot supply this Project access. A GitHub App identity would require a
  separately reviewed identity-policy change; this pilot does not accept one.
- Environment variable `ECORP_STEWARD_ACTIONS_ENABLED=true` only after approval.
- Manual input `publish_summary=true` only when the operator approves releasing
  that audit's limited finding index into this public repository's job summary.

The live job has `contents: read` for its native token and passes the separate
read credential only to the collection step. Environment-only delivery remains
**reduced assurance**: `permissions` does not reduce a separately supplied
token's privileges, and masking is not a secret-isolation guarantee. No token is
forwarded to a model process. Both the initiating and rerun operator must be
`Bakar404`, and the collector independently verifies the authenticated account,
repository node ID and Project node ID.

The summary uses an explicit allowlist: fixed rule codes, stable finding IDs,
counts, timestamp, source SHA and canonical in-repo issue/PR references. It omits
titles, bodies, assignee names, free-form evidence, proposals and raw snapshots;
it caps the index at 50 findings and the summary at 64 KiB. Even those codes and
references can disclose board-derived information, so public release is opt-in.
No report artifact or raw snapshot is uploaded. Detailed reports stay local.

This workflow reuses GitHub's native dispatch, protected environments, job
timeouts, concurrency and step summaries. First-party checkout/setup-node actions
are pinned to immutable commits; Node is pinned to 24.19.0. No npm install,
dependency cache, custom scheduler, new agent identity, or Teams connection is
needed. Its only added behavior is validation and limited report formatting
around the existing collector and auditor.

Hosted workflow execution has not yet been validated. Publishing the branch,
creating a PR, configuring hosted credentials, and dispatching the workflow
remain distinct, explicitly approved operations. This pilot does not run itself
periodically or automatically fix findings.

References:

- [Using Actions to automate Projects](https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/automating-projects-using-actions)
- [GitHub deployment environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)
- [GitHub Actions job summaries](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-commands#adding-a-job-summary)

## Local recurring audits and feedback

`maintenance.mjs` provides one-cycle and finite recurring audits with private,
durable checkpoints. It reuses the existing auditor and collector. It has no
GitHub mutation or ECorp dispatch operation. The hosted manual pilot above keeps
its existing triggers, account and approval boundaries.

From this directory, supply a complete snapshot and its exact source revision:

```powershell
$snapshotFile = 'C:\ecorp-audits\snapshot.json'
$sourceCommit = (Get-Content -LiteralPath $snapshotFile -Raw | ConvertFrom-Json).scope.source_commit
$auditState = 'C:\ecorp-audits\run-001'
node maintenance.mjs once --state-dir $auditState --source-commit $sourceCommit --snapshot $snapshotFile
node maintenance.mjs watch --state-dir $auditState --source-commit $sourceCommit --snapshot $snapshotFile --cycles 3 --interval-ms 1000 --duration-ms 10000
node maintenance.mjs status --state-dir $auditState
node maintenance.mjs pause --state-dir $auditState --source-commit $sourceCommit --reason 'Inspect the findings'
node maintenance.mjs resume --state-dir $auditState --source-commit $sourceCommit --reason 'Continue this scope'
node maintenance.mjs stop --state-dir $auditState --source-commit $sourceCommit --reason 'Audit scope finished'
```

Use a new state directory for a new source or implementation version. `stop` is
terminal. Each cycle reloads the snapshot, rejects stale/incomplete input and
preserves failure receipts. Repeated unchanged data produces a no-op receipt;
changed or resolved findings produce a new private handoff. No-op attempts still
count against the 100-attempt directory limit. Handoffs are advisory, not tasks.
Command output includes the content-addressed receipt, checkpoint and new handoff
references so they can be inspected in the selected state directory.

`--live` replaces `--snapshot` only when using the existing approved collector
identity and scope. A live recurring interval must be at least 60 seconds. The
tool does not switch accounts. Supplied snapshot mode does not certify live
collection, even if the file was originally collected elsewhere.

For local reads under another already-authenticated account, explicitly pin a
private collector profile. The hosted pilot and its `Bakar404` default stay fixed.
Create an ordinary JSON file with these exact fields, replacing `your-login` with
the expected current GitHub login:

```json
{
  "schema_version": 1,
  "kind": "repo-steward-readonly-collector-profile",
  "collector_login": "your-login",
  "repository": "All-The-Vibes/ecorp",
  "repository_id": "R_kgDOUIQ-ng",
  "project_owner": "All-The-Vibes",
  "project_number": 5,
  "project_id": "PVT_kwDODYQm6s4BjN3y"
}
```

Pass the explicit file and SHA-256 to `once` or `watch` with `--live`, and to every
later status/control command for that state directory:

```powershell
$profile = 'C:\ecorp-audits\collector.json'
$profileHash = (Get-FileHash -LiteralPath $profile).Hash.ToLowerInvariant()
node maintenance.mjs watch --live --collector-profile $profile --collector-profile-sha256 $profileHash --state-dir $auditState --source-commit $sourceCommit --cycles 3 --interval-ms 60000 --duration-ms 900000
node maintenance.mjs status --collector-profile $profile --collector-profile-sha256 $profileHash --state-dir $auditState
```

Use the exact current default-branch commit for live collection. The profile
selects the expected read principal; it cannot change credentials, permissions,
repository, Project or query scope. The collector checks the active identity
before and after its two bounded reads. Receipts and checkpoints bind both that
identity and the profile hash. Different/missing profile bytes, source drift or
account drift refuse reuse. Profile options are rejected with supplied-snapshot
mode. This remains a finite foreground audit, with no installed schedule or
native task launch.

`feedback.mjs` creates and versions advisory guidance. It always writes a **new**
output file. Parent directories must already exist; previous corpus files remain
unchanged. The lifecycle commands are:

```powershell
node feedback.mjs init --snapshot $snapshotFile --out 'C:\ecorp-audits\corpus-0.json'
node feedback.mjs evidence --snapshot $snapshotFile --finding F-0123456789abcdef --out 'C:\ecorp-audits\evidence-1.json'
node feedback.mjs propose --corpus 'C:\ecorp-audits\corpus-0.json' --input 'C:\ecorp-audits\proposal.json' --out 'C:\ecorp-audits\corpus-1.json'
node feedback.mjs review --corpus 'C:\ecorp-audits\corpus-1.json' --input 'C:\ecorp-audits\decision.json' --review-file 'C:\ecorp-audits\review.md' --out 'C:\ecorp-audits\corpus-2.json'
node feedback.mjs retire --corpus 'C:\ecorp-audits\corpus-2.json' --input 'C:\ecorp-audits\retirement.json' --out 'C:\ecorp-audits\corpus-3.json'
```

Replace the example finding ID with an actual ID from the supplied audit. A
proposal contains `rule`, `guidance: {text, route}`, an `evidence` array of the
evidence command's records, `expiresAt`, and optional `supersedes`. Routes are
`inspect-evidence`, `clarify-requirements` and `manual-review`. Activation needs
two distinct source/finding evidence identities; changing only a capture timestamp
does not satisfy that condition. Rules expire within 30 days and the default
active cap is eight.

A review input contains `candidateId`, `expectedCandidateDigest`,
`decision` (`activate` or `reject`) and `reviewEvidence: {reason, operatorLabel?}`.
The CLI computes the review file's SHA-256 itself. A retirement input contains
`ruleId`, `expectedRuleDigest` and `reason`. The proposal and review commands print
the record ID and exact record digest; use those values and retain the candidate
version while reviewing it. Names and hashes do not authenticate the
reviewer or establish independent/human approval. These are local advisory data.

The [historical behavior importer](../../docs/OPERATION_FEEDBACK.md#retain-historical-behavioral-findings)
can also retain a native execution and its external byte-check rejection as a
separate evidence kind. These records stay candidates and cannot be activated by
the local review command. They preserve original run/source identities and both
outcomes; they do not establish learned behavior or fresh native acceptance.

Pass an active corpus to a later audit with `--corpus PATH`. It adds bounded
guidance while preserving every original finding and severity. Expired, rejected
or retired guidance is excluded. Receipts bind the corpus and applied rule hashes.
Advisory output is admitted only when it fits 512 annotations and one MiB of
compact JSON; larger results fail explicitly without dropping findings.

Run `pnpm test:steward` from the repository root, or `npm run test:core` here, for
the dependency-free audit, feedback and command tests. See the
[versioned contract](../../docs/specs/recurring-audit-v1.md) for bounds and evidence
scope. This local path does not install a scheduler or start a Factory controller.

## Audit rules

- Topic workstream candidates, without assigning people or applying labels.
- Explicit `## Dependencies` / `Blocked by #...` declarations versus native links.
- Cycles, unavailable/out-of-scope blockers, and inconsistent parent relationships.
- Open/closed issues versus Project status, without treating closure as proof of
  completed implementation.
- Closing links that contradict a PR's non-closing scope, including partial work.
- Stale PR-head descriptions, current-head checks and independent review evidence.
- Default-branch update restrictions and misleading empty status filters.

Findings have stable IDs, evidence revisions, severity, canonical citations and
non-executable proposals. Format hints are informational; missing assignees are
not violations. The agent never treats an unmerged PR closure as issue completion.

The ten workstreams are Multiplayer, UX/UI, Multi-system execution, Janitor,
Dynamic agent teams, DevOps/PR review/branch protection, Security, Agent
communication layer, Dark factory automation, and Backend scalability / pub-sub.
Suggestions are heuristic candidates for confirmation, not authoritative tags.

## Harness-first boundary

ECorp already provides source-pinned isolated workspaces, actor/Corp authority,
provider sessions, budgets, cancellation and verifier policies. GitHub already
provides issue/PR relationships, native dependency and parent links, Project
fields and closing-keyword behavior. Reuse them.

The missing behavior addressed here is a bounded cross-object consistency audit
and a question interface. Model-facing tools accept only a supplied snapshot and
have no GitHub client, shell, network operation, or mutation method. The trusted
collector's native GitHub keyring/environment is not forwarded to those tools.
Native runtime sandbox configuration is not a separate OS identity or proof of
complete host isolation.

## Optional Teams test-chat pilot - deferred

This section is retained for later work; it is not part of GitHub-first activation.
Only this optional transport and its regression tests require the SDK dependency:

```powershell
npm ci --ignore-scripts --no-audit --no-fund --workspaces=false
npm test --workspaces=false
```

The Teams host uses the official **`@microsoft/teams.apps` 2.0.16** (MIT), pinned
with a local package lock. It reuses the SDK's service-token validation, activity
routing and message delivery. A small implementation of the supported HTTP
adapter interface restricts the native Express adapter to loopback and confirms
the listener actually started. No custom JWT validator or authorization bypass is
implemented. See [Microsoft Teams SDK](https://github.com/microsoft/teams.ts).

When that separate pilot is resumed, preview its configuration without startup:

```powershell
node teams-host.mjs --dry-run
```

The live test host remains disabled until the operator explicitly provides:

- `ECORP_STEWARD_TEAMS_MODE`: `test-only`.
- `ECORP_STEWARD_TEAMS_TENANT_ID`: the approved tenant's UUID.
- `ECORP_STEWARD_TEAMS_TEST_CHAT_ID`: the exact test group-chat ID.
- `ECORP_STEWARD_TEAMS_CLIENT_ID`: the registered test app's client UUID.
- `ECORP_STEWARD_TEAMS_BOT_ID`: the bot's exact Teams recipient/mention identity.
- `ECORP_STEWARD_TEAMS_CLIENT_SECRET`: loaded **privately into the trusted host
  process environment**, never a prompt, command argument, log, or repository file.
- `ECORP_STEWARD_SNAPSHOT`: a fresh locally collected snapshot path.
- Optional `ECORP_STEWARD_TEAMS_PORT`: a dedicated test port; default 3978.

Credential delivery through the host environment is reduced assurance. The host
is trusted and credential-bearing; no model process is launched in it. Use a
separate restricted process/identity when adding model execution.

After the exact tenant/chat/app and private credential setup are approved:

```powershell
node teams-host.mjs --dry-run
# This starts an authenticated loopback service. Run only after the test-chat preview.
node teams-host.mjs --serve-test
```

Missing/invalid configuration stops before startup. Auth is explicitly enabled,
including when an ambient skip-auth environment setting exists. Other tenants,
chats, personal/channel conversations, apps and bot recipients are rejected or
ignored before snapshot access. Unmentioned/self messages are ignored. The host
responds only in the current authenticated test chat, caps replies, and deduplicates
activity IDs in memory. Failed or uncertain sends are not automatically retried.
It creates no public tunnel, login, app registration or Teams installation.

Actual Teams testing additionally requires a work/school tenant that permits
custom apps, a registered app with group-chat scope, its installation into the
selected test chat, and a separately approved HTTPS endpoint/tunnel to this host.
Use Microsoft's current CLI/SDK flow, but keep its generated credential files
outside the repository and every agent workspace. Do not copy a quickstart's
`skipAuth: true` setting into this pilot. Do not expose the live ECorp API through
the tunnel.

References:

- [Create a Teams SDK agent](https://learn.microsoft.com/en-us/microsoftteams/platform/agents-in-teams/quickstart-create-agent-teams-sdk)
- [Group-chat agents and mention behavior](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/channel-and-group-conversations)
- [Proactive messages require installation](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/send-proactive-messages)
- [Native GitHub issue/PR closing behavior](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/linking-a-pull-request-to-an-issue)

## Acceptance boundaries

Unit tests cover the deterministic tools and mocked authenticated activities.
The native SDK HTTP test starts a uniquely owned ephemeral **127.0.0.1** listener,
checks absent/invalid authorization and malformed JSON rejection, verifies no
steward snapshot access, and stops that exact server. This is not a successful
real-tenant login, Teams-delivery test, or production identity acceptance.

The first delivered version offers bounded Q&A, not unrestricted multi-turn LLM
conversation. The agent role/tool boundary supports a separately configured
existing model harness; unknown questions ask for clarification.

Before real-chat rollout, prove actual installation and signed request delivery,
test questions/refusals in the chosen group, verify account/recipient boundaries,
and decide how a trusted operator refreshes snapshots. Before production, add
durable restart-safe notification deduplication, health/refresh supervision,
explicit operator-approved rollout and rollback, and the required review evidence.
Current in-memory deduplication is not an exactly-once guarantee across restart.
There is no production-chat switch or unattended GitHub-write capability.

No commit, push, issue creation, PR creation, merge, board normalization, live
Factory startup/recovery, or production deployment is part of these commands.
