# PR #358 retained-receipt dispatch correction

Preserve aggregate budget fencing and final lease/message dispatch checks. Accept the private upload-binding delta only through the full retained-provider-receipt authority check; reject altered executable fields and malformed bindings.

The previous exact-payload predicate rejected a legitimate receipt collection after upload reservation added its private binding. The new path calls the existing complete authorization validator only when payloads differ. It does not normalize away arbitrary keys, and ordinary commands remain exact. Regressions cover altered assignment tokens, extra executable fields and malformed or changed private bindings.

Nine contributor gates; 15 retained-receipt, 28 aggregate-store and two server SQLx regressions on owned PostgreSQL; three aggregate budget scopes; native approval/rejection/expiry with runner ACK; real Edge/browser/server/runner policy acceptance. Reused checks are explicitly bound to the identical complete source tree. The complete tested source tree is `adc64781851d12aa01ff9f4536156460980791c8`. Native r6 passed the build, 45 PostgreSQL tests and aggregate scopes. Native r8 reused only those hashed passing results on the identical tree and binary hashes, then passed the approval and browser lanes on a new fixture. It waited for the source-pinned read-only mission preview to demonstrate actual dispatch readiness before the single effectful launch. A stored connected flag alone was insufficient during reconciliation.

Earlier failures remain under `prior-attempts/`: r5 expected eleven retained-receipt tests although all fifteen passed; r6 and r7 attempted the approval mission before dispatch reconciliation completed. The historical r3 packet and its results remain unchanged. Product screenshots are the unchanged PNGs under `native-r8/`; `validation.html` is a rendered saved-result report.

## First-run replay

Use an isolated Windows checkout with frozen dependencies, the pinned toolchain, PostgreSQL, Edge and Playwright. Create a new output directory and choose a new `qa/pr265-run-activity-*` directory outside the checkout. Use a dedicated Cargo target and a checkout without existing `target/debug/crony-server.exe`, `crony-runner.exe` or `output/e2e-approvals.json`; preserve existing results instead of overwriting them. The three files in `replay/` must remain adjacent. No private reuse receipt is needed.

```powershell
& ./docs/evidence/pr-358-completion-20260922-r4/replay/run-pr358-native-first-run-r9.ps1 `
  -Revision r9 -ValidationDirectory ./docs/evidence/pr-358-completion-20260922-r4 `
  -Repository $reviewCheckout -QaRoot $newOwnedQaDirectory `
  -PostgresBin $postgresBin -CargoTargetDirectory $ownedCargoCache `
  -NodeDirectory $nodeBin -PlaywrightModule $playwrightModule `
  -OutputDirectory $newEvidenceDirectory
```

The first-run driver accepts the raw `staged_tree` and published `tested_staged_tree` schemas, checks all nine named gates and all non-packet source, builds the native binaries, starts a SCRAM-authenticated owned PostgreSQL stack, runs all 45 named SQLx tests, runs aggregate acceptance and both final acceptance lanes, and retains every log, source, database and workspace. Default ports are 59018, 26358 and 25358. Its composition is supplied for replay; only the separately retained r6 and r8 drivers are claimed as executed for this packet.

Local Node 24.21.0 differs from the repository 24.19.0 pin. Rust 1.98.1 and PostgreSQL 17.10 were used. Providers are deterministic and identity is developmental. Database environment delivery is reduced assurance. `CRONY_SKIP_SERVER_RESTART=1` was explicit, so no server-restart acceptance is claimed. Hosted checks and independent required review remain applicable.
