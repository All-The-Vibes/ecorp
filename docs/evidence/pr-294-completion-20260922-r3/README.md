# PR #294 native replay correction

The earlier immutable driver `pr-294-completion-20260922/drivers/run-pr294-native-r3.ps1`
reads a raw receipt field that is absent from the published receipt. The retained
r4 driver also assumes the original private binary-reuse chain. Use the r5 driver
in this packet for a fresh replay. Earlier drivers and evidence retain their
original bytes and historical scope.

The replacement accepts `staged_tree` and `tested_staged_tree`, requires the nine
named passing gates, and checks that product source equals the tested tree. It
permits only the selected evidence packet and this replacement packet to differ
from that tree. It rebuilds both native binaries, preserves existing binaries,
starts a new owned PostgreSQL/API/runner/browser fixture, runs the twelve real
PostgreSQL cache-admission regressions and the actual browser policy/cache lane,
then stops only recorded processes. All data and failed attempts remain retained.

PowerShell 7.4+, repository-pinned Rust/Node/pnpm, PostgreSQL, installed Edge,
Playwright, and installed frozen-lockfile workspace dependencies are required.
All machine-dependent locations are explicit parameters. For example:

```powershell
& ./docs/evidence/pr-294-completion-20260922-r3/drivers/run-pr294-native-r5.ps1 `
  -Revision r5 `
  -ValidationDirectory ./docs/evidence/pr-294-completion-20260922-r2 `
  -Repository $reviewCheckout `
  -QaRoot $newOwnedQaDirectory `
  -PostgresBin $postgresBin `
  -CargoTargetDirectory $ownedCargoCache `
  -NodeDirectory $nodeBin `
  -PlaywrightModule $playwrightModule `
  -OutputDirectory $newEvidenceDirectory
```

Use canonical absolute paths for the variables. The new QA directory must be an
unoccupied `qa/pr265-run-activity-*` path outside the product checkout. Output
directory must exist. Default ports are 59014, 26294 and 25294; all must be free.
Change the three port parameters when needed. Source tree objects from the PR
history must be available locally. The fixture uses development identity and
deterministic native fake-process providers. Requested cache control does not
prove zero cache writes or authorize cleanup.

Fresh replay r5 passed using the published r2 receipt: both native binaries were rebuilt, all twelve PostgreSQL regressions passed, and the real Edge/browser/server/runner policy success, policy failure and explicit cache-policy cases passed. Desktop and mobile saved-contract text exceeded 4.5:1 contrast. The source remained unchanged throughout execution. The lifecycle, logs, exact driver hashes and actual screenshots are retained here.

All nine existing validation results are reused only after proving identical product source; `validation.json` retains their original tested tree and explicitly binds the unchanged prior packet. `source-binding.json` distinguishes that tree from the replay tree. Node 24.21.0 was used locally against the repository 24.19.0 pin; hosted pinned-toolchain checks remain required. PostgreSQL 17.10, Rust 1.98.1 and the installed Edge browser were used.

The earlier packets remain byte-for-byte unchanged. The new invocation requires no prior private binary, private path substitution inside the drivers, or omitted supervisor. It accepts either receipt schema and rebuilds before replay.

Five receipt-admission cases also passed on the retained r3 replay driver: matching and mismatching trees for both raw and published schemas, plus rejection of a failed gate. `guards/result.json` binds these checks to the exact executed driver hash and source commit. Synthetic receipts are test fixtures only. Matching cases intentionally stop at the occupied-fixture preservation guard, before provisioning; mismatching or failed receipts are rejected earlier. No lifecycle or process was created, and existing fixture ownership and source stayed unchanged. The exact historical test driver is retained with its original local paths; it is separate from the parameterized native replay command above.
