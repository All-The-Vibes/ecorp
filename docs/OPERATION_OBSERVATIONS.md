# Inspect and recheck an ECorp run

Use the native server's persisted state when deciding whether an agent outcome is ready to use.
The observation exporter correlates one authorized run with its task, mission, source, verification
and available artifacts. The consumer rereads native state and rejects changed or unaccepted results.
Both tools are read-only; they do not advance tasks, submit review decisions, publish changes or
create another authoritative history store.

## Configure native access

Follow [MCP operations](MCP_OPERATIONS.md) to build the trusted gateway and select its absolute
`CRONY_MCP_BINARY` path. Supply explicit `CRONY_SERVER_HTTP`, `CRONY_CORP_ID`, `CRONY_ACTOR_ID`
and, when required, a scoped expiring `CRONY_ACCESS_TOKEN` through trusted host configuration.
Credentials never belong in command arguments, reports or repository files. Environment delivery
remains reduced assurance.

The exporter reuses the native read-only MCP snapshot. It uses the same selected origin for exact
mission/publication context and artifact GETs. It builds paths from validated IDs, rejects redirects,
requires HTTPS outside canonical loopback, and bounds time, response bytes and artifact counts.
It does not use endpoints or credentials supplied by a receipt.

## Export one observation

Select the run explicitly and choose a new output path:

```powershell
$runId = '<RUN_UUID>' # Replace with the explicitly selected run.
$observationFile = 'output/run-observation.json' # Choose a new path for each export.
node tools/operation_receipt.mjs --run-id $runId --output $observationFile --timeout-ms 30000
```

The default `current-run` mode requires the latest unambiguous run for that particular task.
A newer run in another parallel task does not change this selection. To inspect the run actually
selected by a recorded native Factory publication, pass `--mode published-result`. That run may
be historical; its run/task/deliverable/artifact identities must match the exact publication context.
The exporter does not query current GitHub PR state, and a recorded publication is not a merge or
deployment claim.

The new file contains a fixed allowlist of IDs, versions, timestamps, statuses, source/digest
metadata and observed verification results. It omits prompts, free-form summaries, provider session
IDs, private filesystem paths, bearer values, raw policies and raw signature material. Treat even
this limited operational metadata as scoped information; publishing it requires an appropriate
release decision. Standard output contains only a compact observation identifier and fingerprint.
An existing output file is never overwritten.

## Recheck before consuming an outcome

Capture the file's byte hash using a trusted step in your own workflow, then supply that expected
hash and run ID explicitly:

```powershell
$receiptHash = (Get-FileHash -LiteralPath $observationFile -Algorithm SHA256).Hash
node tools/consume_operation_receipt.mjs --receipt $observationFile --sha256 $receiptHash --run-id $runId
```

The hash identifies the exact input bytes. It is not an issuer signature. The consumer still reads
current native state using host-selected routing, compares the stable scope/version/source/artifact/
verification fields, and requires the server's persisted `completed` and verification `passed`
statuses. Use the same explicit `--mode published-result` when consuming that type of observation;
the file cannot select a different mode on the caller's behalf.

Success emits a small JSON check result and exits zero. Invalid, denied, stale, mismatched or
unaccepted observations exit nonzero. Native error bodies and receipt contents are withheld from
errors. Repeating a check performs fresh reads each time and writes no task state or consumer ledger.
The caller must use ECorp's existing authority and idempotent operations for any later effect.

## Evidence limits

- Native snapshots provide missions, tasks and runs in a repeatable-read transaction. The exporter
  compares matching selected state before and after downloads/context reads; these separate reads
  do not reserve state or authorize future actions.
- Verification evidence is an oldest-first excerpt capped at 1,000 rows, events are the latest 200,
  and recovery records the latest 100. Missing history is unknown. Complete automated-check evidence
  requires a run-bound expected count and unique contiguous check indices with results; today's task
  policy is not substituted for a historical run's policy.
- A persisted accepted run can be observed even when the check-history excerpt is incomplete. The
  report keeps native acceptance and completeness separate. Consumers needing individual check
  evidence must inspect the completeness field.
- The exact Factory context avoids the snapshot's 500-row publication/deliverable windows. Direct
  run deliverables still have bounded snapshot coverage.
- The server's artifact download boundary checks retention, HMAC and bytes. The client checks the
  downloaded SHA-256, length and relevant headers against the native record. It cannot independently
  authenticate the server's HMAC and does not export that signature as portable proof.
- This tool is an existing-API observation and online consistency check. It adds no signed audit
  protocol, offline authority, checkpoint ledger or anchoring mechanism; those are separate work in
  #281/#287 and PR283/293.

The package aliases are `observe:run` and `check:observation`. The direct Node commands require no
JavaScript package installation; the native MCP binary and access configuration remain prerequisites.
Focused tests are `tools/operation_receipt.test.mjs` and `tools/consume_operation_receipt.test.mjs`.
