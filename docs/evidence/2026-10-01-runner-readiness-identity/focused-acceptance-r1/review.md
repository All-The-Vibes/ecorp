# Issue #198 acceptance mapping and retrospective source review

Reviewed source: `3e882d6748735099b68fef8f73e979ecb29ff4e7` over main
`878a1774774b0630c904cbaf4b05e1b346777817`. This is implementing-agent review,
not independent approval. The publication changes evidence only. Local criteria
are mapped below; required hosted validation and a verified main merge remain
necessary before issue closure.

| Issue criterion | Observed evidence and boundary |
| --- | --- |
| 1. Browser-connect an authorized non-lab target and retain selection | The [native setup R1](../native-acceptance-r1/setup-history/r1-browser.json) recorded the approved, owned non-ECorp checkout, six actual Connect/Test operations, reload/reconnect and source retention before its later observer selector failed. Its overall status remains failed. [Native R4](../native-acceptance-r1/browser-r4.json) reused the same saved connections and target without duplication, including reload. An approved local checkout without a remote is an allowed child path. |
| 2. Actual Connect/Test for Copilot, Codex and Claude | Native R1 observed real configured Copilot and Codex as Ready and an unsigned-in Claude profile as Needs sign-in. Readiness does not mean inference on every provider. The 17 adapter tests separately cover native account/catalog parsing, missing/incompatible/failing processes and safe sign-in instructions with fake protocols; their [discovery](issue198-adapter-connection-list-r1.log) and [execution](issue198-adapter-connection-r1.log) retain exact cases. |
| 3. One bounded app through browser/server/runner/harness/verifier with source/download/review | The [native packet](../native-acceptance-r1/README.md) binds the actual Copilot Focus Ledger run, one observed attempt under a two-attempt policy, four persisted verifier checks, eight app Node tests, exact downloaded source, 14 combined browser/Node assertions and six demo-role review assertions. Requester review was denied with HTTP 403; eligible demo-principal review completed persisted state. This is automated development acceptance, not an independent human decision or real-GitHub publication. |
| 4. Saved selection, authority/source binding, idempotency, reconnect and old history | The new 17 SQLx tests execute actual transactions and migrations. The 26 runner and 17 adapter cases verify exact acknowledgement, old-source retention, replay/restart, fixed native operations, private profiles and protected Git/worktrees. The [60-assertion synthetic full stack](../protocol-correction-r1/acceptance/browser.json) and native R1/R4 retain their separate scopes. Fake provider results are never relabeled real inference. |
| 5. Keyboard, narrow layout, error recovery and next action | Native setup/R4 cover Escape/refocus, reload recovery and 390px fit. Synthetic full-stack acceptance exercises failed installation probes, signed-out and restored states with explicit next actions. Downloaded app assertions exercise keyboard operation and corrupt-storage recovery. The app's awkward narrow spacing, untested storage quota/denial and one undetermined local 404 remain limitations in the native packet. |

The child asks for one real app and permits an approved existing checkout.
All-provider inference, Factory and real-GitHub publication remain broader parent
#145/#63 obligations; they are not invented additional child criteria. Simulated
picker options alone do not establish criterion 1; that row relies on the actual
approved local-source connection. No live GitHub repository-picker or production
identity assurance is claimed by these focused protocol tests.

Source review and focused assertions:

- `crates/crony-store/src/workspace_connections.rs` was reviewed with surrounding
  setup/admission code. `workspace_connections_tests.rs:414`, `:483` and `:635`
  cover replay and current actor/Corp/room/machine authority. `:727` and `:818`
  cover private sign-in/catalog diagnostics and redacted shared events.
- Tests at `:861`, `:937`, `:985`, `:1074`, `:1182`, `:1270` and `:1363` cover saved
  settings, wrong source, runner/epoch fences, terminal duplicates, stale/expired
  reports and one-shot actor/step/expiry-bound sign-in input. Tests at `:1130`,
  `:1452`, `:1508`, `:1719` and `:1789` cover offline selection, late-event
  transaction rollback, immutable plan/run source and atomic live admission.
- `crates/crony-runner/src/connections.rs:233`, `:367`, `:417`, `:468`, `:532`
  and `:1012` were reviewed for typed setup, transient sign-in input, exact server
  acknowledgement, source resolution and preserved isolated workspace behavior.
  The runner's receipt-cap tests retain live/unacknowledged/unexpired operations,
  reject conflicting replays and do not reselect an old source after a late ACK.
- The three Windows native integration tests in
  `connection_setup/integration_tests.rs:335`, `:465` and `:623` exercise default
  and configured hook suppression with a positive control, private native
  profiles/login replay, then ready ACK, branch refresh and original run/source
  preservation across restart. The final test failed during R1 Git setup and
  passed during the unchanged-source short-root R2; both facts remain visible.
- `crates/crony-runner/src/adapter/connection.rs` and its provider modules reuse
  native Codex app-server, Claude CLI and Copilot SDK account/catalog/sign-in
  behavior through existing adapters. Ready requires usable catalog entries,
  with an explicit statement that inference has not been tested. No new
  execution, permission or retry mechanism is added by PR #393.
- PR #393's production scope remains `App.tsx:6151` (provider plus connection
  identity and truthful base/saved/feature labels), `missionRuntime.ts`'s reused
  classification and five JSX/helper regressions in `runnerReadiness.test.mjs`.
  Review findings 4160290754, 4160290828 and 4160606480 were already resolved at
  `d41efee9386064fcb73ae0ef660054439b0390e5`; their response IDs are 4161268521,
  4161268750 and 4161268945. Later Copilot review 5387022171 is COMMENTED with no
  new finding, not an approval or required hosted validation.

No new concrete product defect was established by this review. Long arbitrary
Windows fixture roots remain outside the passing evidence. All new evidence is
retrospective; it does not establish the chronology of earlier reported incidents.
Neither the focused tests nor a secret scan is a clean historical Cargo audit.
