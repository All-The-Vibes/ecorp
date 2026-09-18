# Adopt advisory feedback into a saved native task

`tools/operation_feedback.mjs` prepares a reviewable proposal that appends selected
advisory guidance to one saved Direct task's references. Applying that exact
proposal uses ECorp's existing actor-authorized, versioned contract-revision API.
The task stays saved until its separate native launch action.

The input corpus comes from the [local feedback lifecycle](../scenarios/repo-steward/README.md#local-recurring-audits-and-feedback).
Its exact bytes must also exist in an accepted native source run's artifact. A
local corpus or an unrelated successful run leaves a candidate with explicit
reasons. This tool reuses the native MCP reader, artifact download boundary,
operation receipt and contract-revision transaction; it adds no memory service,
execution loop or publication mechanism.

## Prepare

Configure the trusted native gateway, server origin, Corp, actor and scoped
credentials as described in [operation observations](OPERATION_OBSERVATIONS.md).
Keep credentials in trusted host configuration. The source and target must be
different Direct missions in the same Corp and room, with the same exact source
repository, ref and commit. The target must be saved and have no observed run.
The native revision endpoint remains authoritative for actual prior-run admission;
a bounded snapshot cannot prove absence of all historical runs.

Export a fresh `current-run` receipt for the selected completed source run. Choose
one current artifact containing either the exact JSON corpus bytes or the corpus
file in a native `typed_artifact_set`. For the latter, explicitly select its
repository-relative path with `--artifact-path`; the client validates the native
envelope and decoded bytes in memory and never extracts or executes its contents.

Use absolute input paths and a new output path inside a private existing directory:

```powershell
$corpusFile = (Resolve-Path 'C:\ecorp-operations\corpus.json').Path
$reviewFile = (Resolve-Path 'C:\ecorp-operations\review.md').Path
$receiptFile = (Resolve-Path 'C:\ecorp-operations\source-receipt.json').Path
$proposalFile = 'C:\ecorp-operations\proposal-001.json'
$corpusHash = (Get-FileHash -LiteralPath $corpusFile).Hash.ToLowerInvariant()
$reviewHash = (Get-FileHash -LiteralPath $reviewFile).Hash.ToLowerInvariant()
$receiptHash = (Get-FileHash -LiteralPath $receiptFile).Hash.ToLowerInvariant()
node tools/operation_feedback.mjs prepare `
  --corpus $corpusFile --corpus-sha256 $corpusHash `
  --review $reviewFile --review-sha256 $reviewHash `
  --receipt $receiptFile --receipt-sha256 $receiptHash `
  --artifact-id '<SELECTED_ARTIFACT_UUID>' --artifact-path corpus.json `
  --rule-ids '<SELECTED_FB_RULE_ID>' `
  --mission-id '<SAVED_TARGET_MISSION_UUID>' --task-id '<SAVED_TARGET_TASK_UUID>' `
  --out $proposalFile
```

Replace the explicit IDs. Omit `--artifact-path` when the selected artifact itself
is the corpus. Multiple selected rule IDs use a comma-separated list. Preparation
writes the JSON proposal and an adjacent `.md` review showing existing references,
the exact additions, source evidence and expiry. It performs native reads and no
revision or launch. `ready-for-review` describes available evidence, not approval.

Selection requires complete passed automated checks, persisted acceptance, exact
current run/artifact identities, actual downloaded bytes and valid selected rules.
Both the local review file and corpus are byte-bound. A local reviewer label or
digest does not authenticate a human or an independent reviewer. The proposal
preserves those limitations; native source descriptors are not silently upgraded
into authenticated organizational knowledge.

## Apply the reviewed proposal

Review the generated Markdown and exact JSON, then pass its selected byte hash:

```powershell
$proposalHash = (Get-FileHash -LiteralPath $proposalFile).Hash.ToLowerInvariant()
node tools/operation_feedback.mjs apply --proposal $proposalFile --sha256 $proposalHash `
  --corpus $corpusFile --review $reviewFile --receipt $receiptFile `
  --out 'C:\ecorp-operations\application-001.json'
```

The client rereads the source and target, reconstructs the reviewed request and
makes at most one POST with its original idempotency key and expected version.
Only references change. Source routing, permissions, write scope, budgets,
attempts, secrets, deliverable settings and the complete verifier policy remain
unchanged. Noncanonical objectives remain candidates when native normalization
would change them; the tool never hides that additional edit.

Application validates the native revision and rereads source and target afterward.
An exact replay uses the same key/body and must identify one revision. The command
never retries automatically, launches, publishes, merges or deploys.

| Exit | Meaning |
| ---: | --- |
| 0 | Preparation wrote a candidate or ready proposal; application confirmed `applied`. Inspect the JSON status. |
| 1 | Invalid input, local output or unexpected command failure. |
| 2 | Application refused before making a revision request. |
| 3 | A requested application has an uncertain outcome or its source changed afterward. Preserve the receipt and reconcile. |

Output files are reserved before network activity and never overwritten. Apply
exits 2 and 3 retain a structured result, including known revision IDs and the
exact request key when available. Exit 1 can leave only a bounded stderr error
and an empty reserved file when input validation fails; an unavailable output
path cannot retain a receipt.

## Bounds and races

The first version allows eight selected rules, 64 total references and 500 UTF-8
bytes per reference. A rule that fits the local corpus may be too long after its
provenance prefix; it stays candidate rather than being truncated. Proposals
expire after at most five minutes. Reads and the single write share a bounded
operation deadline. Only current accepted native evidence is eligible.

Source observation and target revision are separate transactions. The native
endpoint atomically protects the target; this client cannot make a source
precheck atomic with that write. Source drift after success is reported as
`applied-but-source-changed`. Any error after the POST is potentially ambiguous,
including HTTP 400: a database commit may already have occurred. Preserve the
exact proposal/key and inspect native revision history before doing anything
else. Reconcile using the same request when it remains eligible. An expired
proposal does not authorize a new key or another application.

These tools support governed operator adoption of advisory context. They do not
prove independent learning, production identity or decision quality. A later
native task can consume the persisted references through its existing prompt and
verification path; that execution and any behavioral improvement need their own
evidence. Focused tests are `tools/operation_feedback.test.mjs`; the owned-stack
driver is `tools/e2e_operation_feedback.mjs` and requires explicit setup/input/output
paths. Test fixtures and real-provider observations remain separate.

## Bind one adoption to native independent review

The optional native-review mode binds an existing independent verification decision to one
exact corpus, selected rules and target reference-only change. Its contract is
[native feedback review v1](specs/native-feedback-review-v1.md). It adds client admission;
the general native contract-revision API still has its existing actor authorization.

The source task must have been configured with an `independent_review` gate and
`exclude_requester: true` before it ran. While it is waiting for review, export a fresh
pending `current-run` receipt through `operation_receipt.mjs`. Use the same corpus, local
review, receipt, artifact, rule and saved-target arguments as `prepare`, but select
`prepare-review` and a new output file:

```powershell
node tools/operation_feedback.mjs prepare-review `
  --corpus $corpusFile --corpus-sha256 $corpusHash `
  --review $reviewFile --review-sha256 $reviewHash `
  --receipt $receiptFile --receipt-sha256 $receiptHash `
  --artifact-id '<SELECTED_ARTIFACT_UUID>' --artifact-path corpus.json `
  --rule-ids '<SELECTED_FB_RULE_ID>' `
  --mission-id '<SAVED_TARGET_MISSION_UUID>' --task-id '<SAVED_TARGET_TASK_UUID>' `
  --out 'C:\ecorp-operations\intent-001.json'
```

The example selects `corpus.json` from a typed artifact. Omit `--artifact-path` only
when the selected artifact is the raw corpus itself.
This command only reads native state and writes new local review files. The JSON intent
and adjacent Markdown show the selected guidance, target, expiry and exact reviewer note.
They distinguish the **canonical intent digest used in that note** from the **raw file
SHA-256 used to select the input file**. Neither digest is itself approval.

The actual authorized reviewer must inspect that change and decide the existing native
source verification request with the exact generated note. The existing native CLI/API
supports an explicit note; the browser's generic acceptance note does not bind this intent.
The reviewer must differ from the source producer, source requester and intended adopter.
This tool never submits a decision. A completed source cannot be reopened for a new note.

After approval, export a new accepted source receipt; retain the earlier pending receipt.
Run the existing `prepare` command with that accepted receipt and the original selection,
adding `--require-native-independent-review`, `--review-intent <ABSOLUTE_INTENT_FILE>` and
`--review-intent-sha256 <RAW_FILE_SHA256>`. It returns a v2 proposal only when fresh native
reads bind the exact decision, corpus, rules, verifier policy and target. Apply that
byte-pinned proposal using the ordinary `apply` arguments plus
`--review-intent <SAME_ABSOLUTE_INTENT_FILE>`.

Intents expire within 24 hours or the first selected-rule expiry, whichever comes first.
Mutation proposals retain the existing five-minute maximum. Changed source, policy, rules
or target versions require fresh review; an old decision cannot approve a new intent.
Same-proposal reconciliation retains its original key and expects exactly one revision.
Missing or contradictory review rows, including a request outside the bounded snapshot,
stay candidates/refusals. Post-effect uncertainty preserves the exact request and receipt.

The v2 assurance `native_independent_review_binding_verified` means the client observed
that persisted native gate and exact effect binding. `production_identity_verified`
remains false: the review row does not attest its historical authentication mode, and
development actors do not prove a physical human participated. The original v1 advisory
workflow and public operation-receipt schema remain unchanged. This mode does not activate
historical behavioral candidates, launch a task or establish improved task performance.

## Retain historical behavioral findings

`tools/import_operation_behavior.mjs` imports a selected historical append-check
failure as a **candidate** in the existing advisory corpus. It reads a hash-pinned
manifest and regular files beneath an explicit trusted evidence directory. The
manifest selects the native run, Corp, room, task, connection, original repository
and commit, resume event, and target path. The importer checks those identities
against the retained terminal snapshot and resume request, binds the contract and
persisted verifier, and recomputes a fixed byte comparison. A supplied checker
file is hashed as historical evidence; its code is never executed.

Native verification and the external byte check remain separate outcomes. A run
can have passed its persisted functional checks while an external transformation
check rejected its output. The importer preserves the exact resume instruction;
it does not infer an instruction violation from a checker mismatch. In particular,
an ambiguous append instruction and one that explicitly forbids a separator are
different observations. Instruction/checker alignment remains `not-reviewed`.

Reimporting the same native execution under a different path, timestamp or checker
does not produce another independent observation. Historical records preserve
their original source identities, even when those identities differ from the
current checkout. They are retained local data, with no authenticated review or
execution authority. The existing local review command **cannot activate** this
evidence kind; rejection remains available. Directly changing a corpus to mark
these records active also fails validation.

This path does not export a fresh `current-run` receipt or make historical data
eligible for native adoption. The reference-only bridge still requires a current
accepted artifact, matching repository and exact source commit, eligible active
guidance, and current native authority. A future authenticated promotion path and
a prospective later-run comparison are needed to establish learned improvement.

The CLI takes a hash-pinned request file containing `schema_version: 1`, an
existing `corpus: {path, sha256}`, one to eight `manifests: [{path, sha256}]`,
`guidance: {text, route}`, and `expires_at`. Input references use forward-slash
paths relative to the evidence root; the root and CLI input/output paths are
absolute. Each manifest pins the terminal snapshot, resume intent, before/after
attestations and target bytes, external failure record and historical checker.
The manifest's fixed check is `exact-append-v1`; no command or checker plugin is
accepted. The importer test fixture documents the exact manifest schema.

```powershell
$requestFile = 'C:\ecorp-operations\retained\request.json'
$requestHash = (Get-FileHash -LiteralPath $requestFile).Hash.ToLowerInvariant()
node tools/import_operation_behavior.mjs --input $requestFile --sha256 $requestHash `
  --evidence-root 'C:\ecorp-operations\retained' `
  --out 'C:\ecorp-operations\retained\corpus-candidate.json'
```

The output parent must already exist. A successful command writes a new candidate
corpus and prints its record/digest metadata; existing files are never overwritten.
Retain the request, selected manifests and original files for inspection.
