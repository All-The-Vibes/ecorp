# PR #358 lease dispatch correction

Aggregate budget transitions remain monotonic and auditable. Control steering now revalidates the current durable lease, message and command under the final dispatch transaction. Message and lease rows remain locked through synchronous enqueue; the transmitted token comes from that same locked record. Expiry is checked after lock waits. Release retains and advances the lease version, preventing release/reacquire from reviving an older command. Interrupt takes the run lock before the lease, matching queue and dispatch order.

All nine contributor gates passed on tree `ec90ff8a3fe1facbaf234141a843ca90ebb382ab`. Fresh native acceptance rebuilt server and runner and passed 28 store plus two server PostgreSQL tests, including five added lease/lock regressions. Three real aggregate scopes rejected late artifacts/completions. Native approval, rejection, expiry and actual runner ACK passed; the real Edge/browser/server/runner verifier policy lane also passed. The six PNGs under `browser/` are actual product captures. `validation.html` is a saved-result report, not a product capture.

The new parameterized replay driver accepts raw `staged_tree` and published `tested_staged_tree` receipts, requires all nine named gates, checks identical product source, and retains its exact adjacent supervisor and aggregate driver. Both focused and browser lanes always execute; the unusable historical skip switch is absent. Earlier packets and original driver bytes remain unchanged and retain their historical limitations.

Use a clean isolated review checkout with frozen dependencies and the pinned toolchain, PostgreSQL, installed Edge and Playwright. Choose new canonical QA/output paths, free ports and a dedicated Cargo target; do not overwrite retained `target/debug` server/runner binaries. Create the output directory first. The QA directory must be a new `qa/pr265-run-activity-*` path outside the product checkout.

```powershell
& ./docs/evidence/pr-358-completion-20260922-r3/drivers/run-pr358-native-r4.ps1 `
  -Revision r4 `
  -ValidationDirectory ./docs/evidence/pr-358-completion-20260922-r3 `
  -Repository $reviewCheckout `
  -QaRoot $newOwnedQaDirectory `
  -PostgresBin $postgresBin `
  -CargoTargetDirectory $ownedCargoCache `
  -NodeDirectory $nodeBin `
  -PlaywrightModule $playwrightModule `
  -OutputDirectory $newEvidenceDirectory
```

The default ports are 59018, 26358 and 25358. The driver stops only recorded owned processes and retains all source, databases, workspaces and logs. Its exact executed bytes and source/log hashes are bound in `source-binding.json` and `native-lifecycle.json`. The final evidence addition leaves the tested implementation unchanged.

Local Node 24.21.0 differs from the repository 24.19.0 pin. PostgreSQL 17.10 and Rust 1.98.1 were used. Development principals and deterministic providers are explicit; native database environment delivery is reduced assurance. `CRONY_SKIP_SERVER_RESTART=1` was explicit, so no server-restart recovery is claimed. Ordinary hosted CI and required independent review still apply.

Five receipt-admission tests passed on the exact retained replay driver: raw and published matching trees advance only to the occupied-fixture preservation guard; both mismatching trees and a failed gate are rejected before provisioning. No lifecycle or process starts and existing fixture/source state is unchanged. `guards/result.json` binds the tested driver and staged tree. Synthetic inputs are test fixtures, not validation claims. The exact historical guard driver retains its local paths separately from the parameterized replay driver.
