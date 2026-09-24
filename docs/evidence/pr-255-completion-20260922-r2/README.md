# PR #255 completion evidence

Date: September 22, 2026. Maintainer completion pass performed under the existing ECorp-only authorization.

Correct the hosted Web model coverage failure by classifying the authority model as measured production code. Keep all line/function/branch thresholds and prior native acceptance intact.

Nine contributor gates and the explicit web-model coverage lane pass. The only change from the previously reviewed implementation is adding factoryAuthority.ts to the measured denominator; all native/browser application source and earlier acceptance evidence remain unchanged.

The nine required commands passed on source head `7f1db19f215bf1fbfafe1899014efddd33de3206` with staged tree `39a192cb12748f8b2c032975dddf929710a1c1d1`, incorporating main `08b0b89b2dd16c1906c9dd3468c5ddecca24c4ce`. `validation.json` binds the commands, tool versions, statuses and log hashes. Local user and checkout paths in the published logs are normalized; original hashes are also retained. The evidence files added here are subsequent documentation of that tested tree, not a claim that a not-yet-existing commit was executed.

`validation.png` is a genuine Edge screenshot of `validation.html`, rendered from these saved results. It is a test-report capture, not an application screen. Full result lines, including opt-in ignored tests, remain in the logs. No original RED/GREEN development chronology is inferred from retrospective validation.

Reproduction: use an isolated checkout of the PR, install the repository-pinned Rust/Node/pnpm toolchain, run `pnpm install --frozen-lockfile`, and execute the nine commands listed in `validation.json`. Set `RUST_TEST_THREADS=1` for the recorded Windows test configuration. Build the repository's native `crony-mcp` binary and set `CRONY_MCP_TEST_BINARY` to that owned binary for native MCP unit coverage. These results do not substitute for fresh hosted checks, required independent reviews, or production identity/provider acceptance.

Maintainer self-review: inspected the final implementation and its current-main integration against the product, architecture, security and evaluation contracts. Only evidence documented here is claimed; existing historical reports retain their original scope and limitations.

Native Git received `core.longpaths=true` through process-only Git configuration for the recorded commands. Repository and global Git configuration were not changed.

Build provenance: Workspace package artifacts are removed under the task Cargo mutex before Rust validation. Third-party dependency cache is retained. Node tests use a freshly built copied native MCP binary. `validation.json` also binds the workspace-refresh and MCP-build logs, their original/published hashes, and the copied MCP binary hash.

## Hosted coverage correction

Hosted job 106984498747 in workflow run 35798906572 rejected the changed TypeScript source set before executing model coverage. The authority model was missing from the explicit model list. The one-line correction includes factoryAuthority.ts in measurement; it does not add an exclusion or lower a threshold.

The focused coverage run measured 19 production models using 26 test files: lines 99.64%, functions 97.06%, branches 97.21%. Required thresholds remain 99%, 95%, 97%. Its complete input hashes, before/after stability record, command results and summary are under coverage/. Every input hash was checked against the candidate before packaging.

## Retained native scope

The prior packet ../pr-255-completion-20260922-r1/ remains byte-for-byte unchanged. Comparing its native-tested tree 96e4da4451f9aecd6a0978bc85e93bcbd1126bca to the current gate tree, while excluding only that named evidence packet, finds exactly tools/coverage_web_models.mjs. No server, runner, protocol, store, migration, application UI, native fixture or browser driver changed. Its six store/four server SQLx cases, two APIs/two runners, independent-ledger rejection, controller race, reconnect/rotation/handoff and actual browser mission/artifact hashes remain credited to their original source. No new native run is claimed for this instrumentation-only correction.

Local gates and coverage used Node 24.21.0; the repository pin is 24.19.0. Hosted checks still validate the pin. Issue 161 remains partial/non-closing with the same development-identity, same-host and deterministic-provider limits. Migration 0042 and the downstream unmerged #283 allocation remain unchanged.
