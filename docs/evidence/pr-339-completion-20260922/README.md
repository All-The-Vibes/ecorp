# PR #339 completion evidence

Date: September 22, 2026. Maintainer completion pass performed under the existing ECorp-only authorization.

Merged current main into the four-file UI correction, reviewed the implementation and existing regressions, and retained fresh complete native acceptance and validation evidence.

Mission summary and review controls share existing authoritative reviewer eligibility; actual desktop/mobile native-stack acceptance is retained separately.

The nine required commands passed on source head `c71796a203620d231533f25277158551a2c97de2` with staged tree `d5d88dd7a002c094e86a806a1fc4823db8e654ed`, incorporating main `410eddfc8bfcfa874dae05555128d39a914f0456`. `validation.json` binds the commands, tool versions, statuses and log hashes. Local user and checkout paths in the published logs are normalized; original hashes are also retained. The evidence files added here are subsequent documentation of that tested tree, not a claim that a not-yet-existing commit was executed.

`validation.png` is a genuine Edge screenshot of `validation.html`, rendered from these saved results. It is a test-report capture, not an application screen. Full result lines, including opt-in ignored tests, remain in the logs. No original RED/GREEN development chronology is inferred from retrospective validation.

Reproduction: use an isolated checkout of the PR, install the repository-pinned Rust/Node/pnpm toolchain, run `pnpm install --frozen-lockfile`, and execute the nine commands listed in `validation.json`. Set `RUST_TEST_THREADS=1` for the recorded Windows test configuration. Build the repository's native `crony-mcp` binary and set `CRONY_MCP_TEST_BINARY` to that owned binary for native MCP unit coverage. These results do not substitute for fresh hosted checks, required independent reviews, or production identity/provider acceptance.

Maintainer self-review: inspected the final implementation and its current-main integration against the product, architecture, security and evaluation contracts. Only evidence documented here is claimed; existing historical reports retain their original scope and limitations.

Native Git received `core.longpaths=true` through process-only Git configuration for the recorded commands. Repository and global Git configuration were not changed.

## Native browser acceptance

The saved browser report and seven unmodified Edge screenshots exercise the real web/server/PostgreSQL/native runner path at 1440px and 390px. Alice's excluded-requester summary, disabled review controls and keyboard focus agree; Bob's eligible controls remain enabled; Eve cannot see the mission or run. Saving and launching in the browser created one isolated run. Its artifact check passed, and the persisted run completed only after the development Bob identity accepted the pending review. The source checkout stayed unchanged and the dirty worktree remained preserved. Owned processes stopped; the fixture, database, logs and worktrees remain available privately.

The report's source_commit identifies the isolated deterministic task repository. tested_staged_tree identifies the reviewed product source. These checks use development identities and a deterministic adapter; they do not claim real-provider inference, production identity validation or a human review decision.

The first two driver attempts remain in prior-browser-attempts: r1 failed before any operation because of an incorrect expect import; r2 saved and launched a different retained mission, then asserted workspace cleanup before the lifecycle event arrived. The final driver waits for the native workspace lifecycle to settle and preserves its actual disposition. No prior mission was replayed. browser-artifacts.json distinguishes original private-byte hashes from normalized published bytes. The published driver uses placeholder local paths and requires fresh owned fixture paths to reproduce; it is not an unattended replay command.

Trailing line whitespace and blank lines at EOF are removed from the published logs. This formatting normalization does not alter test-result text; original and published hashes are distinct. The local `.gitattributes` preserves published evidence bytes on checkout.
