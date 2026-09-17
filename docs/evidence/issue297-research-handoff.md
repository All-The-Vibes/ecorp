---
title: Issue 297 draft validation evidence
description: Local candidate checks, review findings, and outstanding native acceptance gates
---

## Status

Draft for [issue #297](https://github.com/All-The-Vibes/ecorp/issues/297), not a
completion or human-approval record. The contributor authorized a local Copilot
implementation and a draft commit with the remaining validation gaps disclosed.
This does not claim execution through the issue's pinned Codex Factory lane.

* Date: 2026-09-16
* Base: `b2523964e7576cafc00e84a51e1044f55826dea7`
* Branch: `afateen/issue-297-research-handoff`
* Platform: Windows, Rust `1.94.0-x86_64-pc-windows-gnu`, Node `26.7.0`
* Native C tools: LLVM-MinGW `20260908`, with Rust's bundled GNU linker
* Package manager: pinned portable pnpm `11.19.0`

The [implementation overview](../RESEARCH_HANDOFFS.md) describes the candidate
contracts, delivery path, limits, compatibility and preservation behavior.

## Executed checks

| Command | Observed result |
| --- | --- |
| `node tools/check_migrations.mjs` | Passed: 41 immutable migrations |
| `cargo fmt --check` | Passed |
| `git diff --check` | Passed before the draft evidence addition |
| `cargo check --locked --offline --workspace --all-targets -j 2` | Passed for all seven workspace packages and their targets |
| `cargo test --locked --offline -p crony-protocol -p crony-domain -j 2` | Passed: 16 domain tests and 10 protocol tests; zero failures or ignored tests |
| `node --check scripts/fake-agent.mjs` | Passed |
| `node --check tools/e2e_research_handoff.mjs` | Passed |
| `cargo test --locked -p crony-server -p crony-runner issue297 -- --test-threads=1` | Compilation passed; runner test executable exited with `0xc0000005` before assertions |
| `cargo test --locked --offline -j 2 -p crony-server -p crony-runner issue297 -- --test-threads=1` | Same runner startup failure |
| `cargo test --locked --offline -j 2 -p crony-server issue297 -- --test-threads=1` | Compilation passed; server test executable exited with `0xc0000005` before assertions |
| `cargo test --locked --offline --workspace -j 2 -- --test-threads=1` | Compilation passed; first executable, `crony-cli`, exited with `0xc0000005` before assertions |
| `cargo clippy --locked --offline --workspace --all-targets -j 2 -- -D warnings` | Blocked by the existing `nonminimal_bool` diagnostic in `crates/crony-store/src/retained_provider_receipt.rs:50`; that file is unchanged |
| `pnpm build:web` | Dependency retrieval failed with npm registry TLS errors |
| `pnpm --config.fetch-retries=0 --config.offline=true lint:web` | Dependency retrieval still attempted by pnpm and failed; lint did not execute |

The user subsequently supplied a Windows Security notification confirming that
the npm URL is blocked by IT policy. No further npm retries, alternate registry,
certificate bypass or policy bypass is part of this contribution. Web validation
requires an IT-approved dependency source or an approved validation environment.
The native executable startup failures remain a separate unresolved observation.

### Bounded acceptance-readiness increment (2026-09-17)

The runner test
`dependency_files::tests::issue297_synthesis_reads_materialized_files_not_summaries_or_altered_bytes`
joins the actual materializer to the checked-in Node synthesis fixture. It checks
four unique note/probe files, exact UTF-8 byte counts and hashes after replay,
summary-only rejection even when the prompt includes the full file text, and
rejection of an altered fourth file without an artifact or completion event.
The subprocess has a ten-second deadline and a minimal inherited environment.
Fixtures stay under the runner package's `target` directory; failed fixtures are
preserved, while successful fixtures are removed.

The unchanged candidate `ca15684b84710dbc6450c20b9117f62f89d38887`
(tree `aeb2811c18a314d73ff6d976b8d83007e0696cf7`) was rebuilt offline
with the existing Rust 1.94 GNU toolchain and bundled LLD: all 23 materializer
tests passed. After adding this test, the same build command and focused family
passed all 24 tests, zero failures or ignored tests, in 10.74 seconds.
The checked-in fixture ran on Node 26.7.0.

```powershell
# Existing isolated GNU toolchain environment; no dependency installation.
. .\.qa-issue-297\environment.ps1
$lld = Join-Path $env:RUSTUP_HOME 'toolchains\1.94.0-x86_64-pc-windows-gnu\lib\rustlib\x86_64-pc-windows-gnu\bin\rust-lld.exe'
cargo rustc --locked --offline -p crony-runner --tests --message-format=json -- -C "linker=$lld" -C linker-flavor=ld.lld
# Run the crony-runner test executable reported by compiler-artifact above.
& $runnerTestExecutable dependency_files::tests --test-threads=1
cargo fmt --check
node --check scripts\fake-agent.mjs
git diff --check
```

Formatting, Node syntax and diff whitespace checks passed. Editor test discovery
found no Rust tests, so the actual rebuilt runner test executable was used.
No server/workspace suite, SQLx, Clippy or web gate was run in this bounded slice.

This is a source-bound process test, not the required `browser-consumption` or
`adversarial` interface. It does not authenticate signed artifacts, select parents,
exercise a database, launch services, grant approval, or establish full-stack
TF-01/02/03 acceptance. The native owned-QA context/source pins, actual browser
gates, authority/recovery SQLx cases and real owner/admin decision remain separate.

A local fixture self-test passed three checks:

1. Two specialists each generated a unique note and JSON probe; each probe's
   observed note hash matched.
2. A child given the full note/probe text in its prompt but no files failed with
   `ENOENT`, rather than producing a successful consumption receipt.
3. After an explicit test-fixture copy, the child read all four files and reported
   matching paths, byte counts and SHA-256 values.

That self-test is not native materialization, signed artifact, SQL, browser or
Factory evidence. Its output is retained locally, not represented as an
authorized server download.

### Guarded browser interface increment (2026-09-17)

The named interface now accepts:

```powershell
node tools/e2e_research_handoff.mjs --case browser-consumption --require-owned-qa
```

This interface was implemented but not run against a browser or services in this
slice. The no-argument API lane retains its existing behavior. The named lane
requires an already-seeded, empty owned development fixture. It checks the actual
candidate source inventory, server/runner bytes and live process receipts before
creating the held mission and again before dispatch. It does not start or stop
services, read a database connection string or create another Corp.

The browser opens the real built App, checks served assets against operator pins,
selects the held mission and clicks `Start mission` once. Its request guard only
forwards real requests: pinned static assets, scoped reads, at most two existing
demo handshakes and the exact armed launch. Unexpected scripts, sockets or writes
fail the case. There is no response fulfillment, page-state injection or storage
seeding. Existing native API assertions still check signed parent downloads,
verification, ordering, distinct worktrees and all four synthesis readbacks.
The App must then download the exact verified synthesis artifact; its bytes and
digest must match the native download. All three browser assertions and bounded
browser closure are required before recording browser coverage.

The `adversarial` case exits with an explicit not-implemented diagnostic before
any effects. It never substitutes the Rust or Node tests for full-stack negative
artifact/lineage acceptance. The browser case alone also does not prove the
summary-only full-stack negative control or all TF-02/03 boundaries.

#### Operator QA context contract

`ECORP_ISSUE297_QA_CONTEXT` must point to a bounded, operator-authored JSON file.
This version-one interface schema is new local code, not a claim of compatibility
with the private controller's retained context. The operator must bind or adapt
that context deliberately after qualification; no automatic conversion or
self-issued ownership receipt is provided.

| Field | Required value |
| --- | --- |
| `schema_version`, `issue`, `test_owned`, `state` | `1`, `297`, `true`, `"candidate_ready"` |
| `head` | Exact candidate Git HEAD |
| `files_sha256` | SHA-256 of the complete source inventory described below |
| `source` | Exact `repository`, `base_ref`, `base_commit`; commit equals `head` |
| `fixture` | Exact `corp_id`, `room_id`, `alice_actor_id` from exported `researchDemo`, already seeded by the operator |
| `server` | `url`, absolute `binary`, `sha256`, and existing owned-process `manifest` |
| `runner` | Exact advertised `id`, absolute `binary`, `sha256`, and existing owned-process `manifest` |
| `web` | `url` and `assets` mapping URL paths to SHA-256 values of qualified built bytes |

Unknown top-level fields, unready contexts and mismatched pins fail closed.
No database URLs or credentials belong in this schema.
Both process manifests use the existing `owned_test_stack.mjs` receipt shape.
For the runner, the receipt's `server` PID slot denotes the runner process; its
workspace and `server_url` bind the same owned candidate stack. Runner admission
checks process identity but does not claim the API listener. Server admission
also verifies listener ownership. Binary paths must resolve inside this checkout.

`files_sha256` hashes UTF-8 `JSON.stringify` of sorted `[Git path, SHA-256]`
pairs for every tracked and non-ignored untracked file. Each digest uses literal
working-file bytes; this is distinct from a normalized Git tree ID. The exported
read-only `candidateSourcePins()` computes `head` and `files_sha256` without
changing Git objects, refs or the index. The operator still owns proof that the
qualified binaries and built web assets came from those source bytes.

Build the App with `VITE_CRONY_SERVER_HTTP` set to the qualified API origin.
Pin `/`, built JavaScript/CSS, and every requested font/image/favicon path.
A Vite development server is deliberately unsupported. Use existing Playwright
through `CRONY_PLAYWRIGHT_MODULE` if needed, and an installed browser through
`CRONY_BROWSER_CHANNEL` (default `chrome`); this interface installs neither.
Retain `CRONY_RESEARCH_HANDOFF_TEST=1`, exact `CRONY_SERVER_HTTP`, and a fresh
`CRONY_RESEARCH_HANDOFF_OUTPUT` leaf outside the candidate checkout.
Failed checkpoints and prior evidence are preserved; only the browser opened
by this invocation is closed, with a ten-second cleanup bound.

#### Executed interface checks

```powershell
node --test tools/research_handoff_browser.test.mjs tools/owned_test_stack.test.mjs tools/fixture_source_identity.test.mjs
node --check tools/research_handoff_browser.mjs
node --check tools/e2e_research_handoff.mjs
git diff --check
```

The focused suite passed 64 tests, zero failures or skips: nine new interface
contract/source cases and 55 existing ownership/source cases. It includes actual
CLI rejection of missing QA context, unknown cases and unsupported adversarial
execution; malformed/unready contexts; an actual checkout-pin mismatch; strict
request scope; one-shot launch fencing; and source-bound App selectors.
No browser, services, application database, provider inference or Factory action
was executed. The earlier 23-test baseline and 24-test materializer increment
above remain historical evidence, not results rerun for this interface increment.

### Guarded adversarial interface increment

This continuation starts at parent-committed
`c97b5e04b4f791e3ccf40d2d6fb4ed923a11e795` on the same branch. The earlier
unsupported-adversarial result remains historical. The named entrypoint now
routes to [the guarded adversarial driver](../../tools/research_handoff_adversarial.mjs),
without falling through to the positive API or browser lane:

```powershell
node tools/e2e_research_handoff.mjs --case adversarial --require-owned-qa
```

No native services, browser, application database, inference, Factory action or
cloud operation was run for this increment. All runtime scenarios below remain
unexecuted. Offline contract and native verifier results are not ledger entries
for native full-stack acceptance.

#### Runtime admission and evidence contract

The driver reuses the version-one operator QA context and source/process
qualification above. Additionally, the operator must provision the same UUID
in `CRONY_ISSUE297_ADVERSARIAL_NONCE` for the dedicated runner and this client.
The checked-in fake adapter inherits that environment. The driver never changes
the runner environment or starts, stops or resets anything. The nonce is fixture
selection, not authentication or ownership proof.

Use a freshly pre-seeded owned fixture with no prior missions, tasks, runs,
source deliverables, verification history or Factory items. A browser-consumption
fixture that already executed is not fresh. Retain all source, binary and web
context pins; this lane does not open the browser or certify web assets. Candidate
source and the fake script must contain this increment before runtime execution.
Commit/source qualification remains the parent's or operator's responsibility.

Only four held mission creations and their exact one-shot launches are permitted.
Each uses the existing native source-bound parallel-specialists plan, fake-process
adapter, declared note/probe paths, one attempt and native bounded file/JSON
verifiers. The title selects a deterministic fault in
[the fake-only constructor](../../scripts/research-negative-fixture.mjs).
Both roots construct the fault in their own freshly generated declared files.
The constructor accepts the native prompt's repeated mission title, rejects
conflicting/malformed markers, and requires the nonce and exact research contract.
It introduces no production signer, filesystem fault hook or provider hook.

After construction the driver requires native failure, both original failed
preserved root runs, unchanged persisted authority, and no synthesis attempt/run.
For bad-file cases it requires every exact verifier index and status, native
readback matching fixture hashes, and an actual Node exit code of one.
Missing executables, timeout, cancellation, unrelated failed checks, lost
construction output, or incomplete snapshots cannot count as rejection.
Construction output alone is not cryptographic proof or native rejection.

The authorization control downloads an actual retained signed provider receipt
as the authorized actor before requiring native denial for a known nonmember.
It does not re-sign anything and does not count as cross-Corp or lineage testing.
No client response replacement is used.

After QA admission, HTTP observation has a 50-second budget, five-second request
bounds, 160-request cap, bounded bodies and no redirects. A fresh exclusive
output leaf outside the candidate checkout retains mutation IDs before checks,
per-case native snapshots, and an atomic coverage receipt. No uncertain mutation
is retried. Failures preserve original runs/workspaces; there is no automatic
cleanup/recovery of native resources.

The complete ledger always contains these 23 named cases. Zero, duplicate,
omitted or incomplete assertions fail. Only five have executors; even if all
five later observe native rejection, the overall receipt remains
`accepted: false`, `phase: incomplete`, and the command exits nonzero.

| Required case | Current executor and coverage boundary |
| --- | --- |
| `missing-file` | Implemented: remove the declared parent note, require native file rejection and no child |
| `altered-content` | Not implemented: signed-object digest tamper plus real dependency resolution |
| `undeclared-file` | Not implemented: typed manifest/declaration mismatch before dispatch |
| `cross-corp` | Not implemented: valid signature with wrong Corp and actual selector |
| `cross-task` | Not implemented: valid signature with wrong task and actual selector |
| `cross-run` | Not implemented: valid signature with wrong run and actual selector |
| `cross-recovery` | Not implemented: real retained lineage, no stale fallback or synthetic URI substitution |
| `cross-room` | Not implemented: persisted room/source authority mismatch |
| `traversal` | Not implemented: actual source/assignment path rejection |
| `destination-symlink` | Not implemented: pre-provider child destination link, host-qualified |
| `destination-reparse` | Not implemented: pre-provider Windows child junction/reparse fixture |
| `file-count-limit` | Not implemented: over-eight-file native transport rejection |
| `oversized-file` | Implemented: exactly 6145 parent note bytes, native 6144-byte policy rejection |
| `wire-file-byte-limit` | Not implemented: native per-file 12-KiB transport boundary |
| `aggregate-byte-limit` | Not implemented: native 64-KiB aggregate boundary including JSON framing |
| `prompt-byte-limit` | Not implemented: bounded dependency prompt overflow, no truncation |
| `envelope-byte-limit` | Not implemented: serialized command envelope overflow, no truncation |
| `exact-limit-control` | Not implemented: valid content exactly on each supported native limit |
| `parent-tree-isolation` | Not implemented: actual OS denial, not absence of driver reads |
| `invalid-probe` | Implemented: exact malformed JSON, native parser rejection and no child |
| `failed-parent` | Implemented: explicit fake failure before completion, native failure and no child |
| `cancelled-parent` | Not implemented: controlled native cancellation and no dependency release |
| `unauthorized-artifact` | Implemented: authorized signed download control followed by nonmember denial |

The missing-file and oversized-file executors test the parent verifier boundary;
they do not separately certify missing/tampered child materialization. The
native materializer unit suite below supplies narrower offline evidence only.

#### Test-only construction for remaining native boundaries

There is no identified missing external contract that prevents writing further
fixtures. These are remaining implementation mechanisms, not missing-QA excuses.

* The server's [artifact store tests](../../crates/crony-server/src/artifacts.rs)
  already use `object_store::memory::InMemory`, a synthetic signing key,
  `#[cfg(test)] ingest`, and real `read_verified`. A combined test-only server
  fixture can create validly signed objects under intentionally wrong Corp,
  task or run identities and first prove those bytes/signatures verify.
  It must then associate references with the selected parent through a
  disposable SQLx fixture and call the actual dependency selector/resolver,
  requiring rejection before dispatch. No signing key belongs in the QA
  context or a production fault endpoint.
* Existing [store lineage fixtures](../../crates/crony-store/src/lib.rs),
  `issue297_typed_handoffs_never_fall_back_to_provider_receipts` and
  `dependency_artifacts_bind_recovered_parent_and_reject_invalid_metadata`,
  exercise the real selector against test-built relational tables. Their
  digests/signatures are placeholders. The separate artifact signature tests
  and metadata-only SQLx fixtures are not combined signed-lineage evidence.
  The next bounded implementation is a `cfg(test)` combined server fixture
  using those relational rows and real signed in-memory bytes, including an
  authentic recovery chain. It requires a separately owned disposable SQLx
  database to execute, never the application database.
* The [runner materializer tests](../../crates/crony-runner/src/dependency_files.rs)
  already create owned Unix symlinks, Windows junctions, hard links and race
  fixtures. The runner calls materialization after workspace preparation but
  before constructing the adapter request. Fake-agent code therefore runs too
  late to construct a child destination link at that boundary. The combined
  test-only harness should construct the link in a freshly owned or valid
  retained child worktree before the actual assignment execution, with the
  correct checkpoint/fingerprint where required. Its target is an owned
  sibling sentinel beneath the fixture root, not another user's directory.
  Assert native failure and preservation, unchanged target, and no adapter
  session/output. Use separate Unix-link and Windows-reparse host receipts;
  absent privilege or platform is a setup failure, not skipped acceptance.
* Actual denial of access to parent trees needs the supported OS isolation
  boundary. A driver that never reads those trees does not prove isolation.
  Neither unit junction tests nor a private ownership manifest establishes it.

#### Executed adversarial increment checks

The focused offline suite passed 77 tests with zero failures or skips: 13
adversarial observer/constructor cases plus the 64 prior interface/source cases.
It executes the real fake-agent subprocess for all four constructed faults.
Synthetic native-shaped state is used only for observer contract tests.
A native-prompt repetition defect found during source tracing was reproduced,
retained in a private failure log, and fixed; conflicting markers still fail.

The source-bound runner test
`issue297_negative_fake_outputs_are_rejected_by_native_verifier` executes that
same checked-in fake process for an unchanged positive control and three bad-file
cases, then calls the real native verifier. The native verifier family passed
9/9, and the materializer family passed 24/24, including this Windows host's
junction cases. These 33 native unit tests are not server/store/browser evidence.

```powershell
node --test tools/research_handoff_adversarial.test.mjs tools/research_handoff_browser.test.mjs tools/owned_test_stack.test.mjs tools/fixture_source_identity.test.mjs
cargo rustc --locked --offline -p crony-runner --tests --message-format=json -- -C "linker=$lld" -C linker-flavor=ld.lld
& $exactBuiltRunner dependency_files::tests --test-threads=1
& $exactBuiltRunner verifier::tests --test-threads=1
```

The build uses the pre-existing isolated Rust/LLD toolchain, not an installation.
Syntax, formatter, whitespace and evidence metadata/anchor checks are recorded
with the exact final tree and literal source inventory in the private
`C:\Repos\ecorp\docs\temp\issue297-adversarial-interface-20260917` receipts.
Earlier receipts remain intact. No source ref or index update is part of this
increment.

## Resumed offline native fixtures

The September 17 resumed increment adds
[`research_handoff_native.mjs`](../../tools/research_handoff_native.mjs) and
an explicit [23-case executor catalog](../../tools/research_handoff_native_catalog.mjs).
This is a separate offline lane. It does not convert the earlier browser
contracts or five live-stack executors into runtime acceptance.

The driver requires a source fingerprint, exact binary hashes and successful
Cargo test-artifact receipts. It checks that each ignored entrypoint exists
before execution. It creates a fresh PostgreSQL cluster in the caller's new
evidence directory, selects an ephemeral loopback port, verifies the spawned
PID and data directory, and owns a nonce-named database. It never uses
`DATABASE_URL`, the retained journey stack, a fixture endpoint or a provider.
Shutdown targets only its verified child process. Failed worktrees, database
files, command output and earlier attempts remain available for diagnosis.

Native mappings are separated by boundary:

* Thirteen signed server/store cases use real in-memory artifact signing and
  verified reads, the persisted dependency selector, the native resolver,
  and room-scoped download selection. Wrong Corp/task/run artifacts are
  validly signed before lineage rejection. Recovery uses distinct provider
  and verifier runs. Positive controls, exact native errors, unchanged
  dependency receipts and idempotent restored replay are required.
* Seven assignment/materializer cases enter actual workspace preparation
  and checkpoint admission before materialization. Successful controls start
  the shipped fake-process adapter and read exact bytes with native file
  operations. Link failures must originate in materialization, prevent
  adapter entry, preserve the workspace and leave the target unchanged.
* Three file-output cases execute the checked-in deterministic fake process
  and native verifier. They cover a missing file, a 6,145-byte note and an
  invalid JSON probe. The unchanged and exact 6,144-byte controls pass the
  same four-check policy. These are verifier results, not scheduling evidence.

Numeric controls exercise equality and plus one, not approximate sizes:
8 wire files, 12,288 UTF-8 bytes per wire file, and 65,536 serialized wire
bytes; the signed decoder separately tests its exact envelope and parent
prompt limits and the resolver's combined 65,536-byte prompt limit.
The exact-limit case supplements, rather than replaces, each negative check.

All new Rust fixture entrypoints and helper APIs are compiled only under
`cfg(test)`. The runner module is conditionally declared; the server and
shared relational fixture are included inside test modules. Signing reuses
the existing test-only `ArtifactStore::ingest`. No runtime feature,
production fault switch, public route or weakened signature/authorization
check is introduced.

The offline driver always returns `accepted: false` and exits nonzero.
Missing executables, setup errors, timeouts, absent or duplicate receipts,
wrong nonces, zero tests, ignored tests, missing assertions and partial
ledgers cannot receive native coverage. Driver contract specimens remain
synthetic and are never reported as native observations.

Two observed host/product limitations remain explicit:

* Native Windows file-symlink creation returned error 1314, missing privilege.
  The plain-file control succeeded; no symlink rejection was claimed.
  Windows junction/reparse materialization is a separate executable case.
* The actual fake-process child read the owned sibling-parent sentinel with
  matching bytes. The parent checkpoint and sentinel were unchanged, but
  that is not read isolation. [Security](../SECURITY.md) explicitly documents
  same-user fake-process permissions. Qualifying this case needs a separately
  authorized OS identity/ACL or sandbox design, not fixture-only permission
  changes, a simulated denial or a new unreviewed production execution layer.

The new evidence bundle is
`C:\Repos\ecorp\temp\evidence\issue297-resumed-adversarial-20260917`.
Its machine-readable result records the final tree, every changed-file hash,
build protocols, exact commands, complete case ledger and retained failures.
Earlier checkpoint paths and receipts below remain historical, not fingerprints
of this resumed tree.

## Independent review

A separate read-only code-review agent examined the candidate's artifact,
compatibility, recovery and filesystem boundaries. It reported two defects:

* Dependency receipt recording rejected replay after a source-correction run
  started. Recording now validates the exact existing receipt under the native
  run/task/mission locks and does not rewrite history.
* An incompatible recovery could block unrelated durable commands. Capability
  rejection now differs from connection fencing; the incompatible run stays
  pending while other runs can advance beyond a full blocked command page.

Regression tests were added for both. Follow-up review of those fixes reported
no significant issues. This is code-review evidence, not executed regression
evidence or an owner/admin approval.

## Remaining acceptance gates

* [ ] Run the server planner, decoder and capability tests.
* [x] Run the local native runner materialization tests, including this host's
      junction and replay cases; cross-platform/full-stack execution remains open.
* [ ] Run the SQLx dependency selection, receipt replay and recovery regressions
      against the owned disposable PostgreSQL fixture.
* [ ] Demonstrate exact child consumption through the candidate native services.
* [ ] Implement and run the issue's required `browser-consumption` and
      `adversarial` acceptance interfaces with trusted QA/source pins.
      The original driver was API-only and rejected arguments; the guarded
      browser implementation above is contract-tested but not runtime-accepted.
      The live adversarial entrypoint has five guarded executors, unexecuted
      against native services. All 23 cases now have separate offline native
      mappings, with scope and failures retained in the resumed bundle.
      Offline observations cannot produce accepted live TF02/03 output.
* [ ] Complete the required workspace, Clippy and web gates.
* [ ] Coordinate with the retained native Factory operator and reconcile the
      helper-module/receipt-replay file scope with its controller allowlist.
* [ ] Obtain the issue creator/assignee's verification and concrete human approval.

Issue creator: [@rajesh-ms](https://github.com/rajesh-ms). No issue assignee was
present when checked. Coordinate verifier/cache and preservation overlap with
[@dstkwll's PR #294](https://github.com/All-The-Vibes/ecorp/pull/294).

## Local source fingerprint

These SHA-256 values identify the literal working-file bytes used for the local
checks above, before Git checkout newline normalization. They are not artifact
provenance signatures and do not substitute for native candidate/source pins.

```text
7add1549722e1f2c4cf2f34de1f170724a0b70f15f2c2408f83395d1061a53d3  crates/crony-protocol/src/lib.rs
a09ab41f315b6148a75aab191c8ef265b3011ebace4383f78fe8a95c6933ecef  crates/crony-protocol/src/dependency_files.rs
ee45600e14533b82aad65acf3001e5a93409b95ca3626a921e75e3a64fd36c32  crates/crony-runner/src/main.rs
3777ad30ecdccd69cce7b40d6df08db33a1d380487081527eb9d89e316683927  crates/crony-runner/src/dependency_files.rs
163f15c4d32e374c552767c16f41f731a77c99e8d2e63f0ae49210698dcd430c  crates/crony-runner/src/source_checkpoint.rs
7bd7e5208973a5dd4fbe487a930d03236baa933cbcd1c98fedee65aaab0b12d0  crates/crony-server/src/main.rs
0036f3d74375f6384077cea7256e18dc9471bd149042aec34aacd99887973a72  crates/crony-server/src/planning.rs
3694c4eecc93d10660518dc159df57d2ffc5bf12badccae1fab438f1265c1b59  crates/crony-server/src/dependency_source.rs
a6f40a83c951736c188302d64c2ac0acea99e6f90a0bb87600d148cdc5765b34  crates/crony-store/src/lib.rs
acbb34dcb2be3162419481c4b8f4c1bfbcae51e0e626ceadf65ac77fcfb3ee2d  crates/crony-store/src/staffing.rs
f259454d66179d166e2725ce0f65dd454dbfb9dbe2dbe7fcb56418a2c92745e9  scripts/fake-agent.mjs
5f72dd01bf74ddc1ae950b8288d3da006d9d860f5e37e8785ab568bc576e53be  tools/e2e_research_handoff.mjs
```
