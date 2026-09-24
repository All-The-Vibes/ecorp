# PR #359 completion evidence

Date: September 22, 2026. Maintainer completion pass performed under the existing ECorp-only authorization.

Create immutable fixture outputs exclusively, preserve occupied hard-linked/symlinked outputs, surface durable browser operation-key persistence errors before API calls, sanitize Edge environment inheritance, and select reusable agents in the authorized saved-connection room. Integrate current main and retain prior work and evidence.

Nine contributor gates; 19 actual PostgreSQL tests; actual Edge Pin/Unpin at 390 CSS pixels and 1440 pixels through the native server and runner; source-bound retrospective filesystem/authentication regressions. The provider is deterministic and development principals are used; no production-provider or OIDC end-to-end acceptance is claimed.

The nine required commands passed on source head `85fc88f037ee71531cf6c945f2a2fdc86be82e4b` with staged tree `5c8db0930157853b582d3184b1521b1161dbd5ae`, incorporating main `08b0b89b2dd16c1906c9dd3468c5ddecca24c4ce`. `validation.json` binds the commands, tool versions, statuses and log hashes. Local user and checkout paths in the published logs are normalized; original hashes are also retained. The evidence files added here are subsequent documentation of that tested tree, not a claim that a not-yet-existing commit was executed.

`validation.png` is a genuine Edge screenshot of `validation.html`, rendered from these saved results. It is a test-report capture, not an application screen. Full result lines, including opt-in ignored tests, remain in the logs. No original RED/GREEN development chronology is inferred from retrospective validation.

Reproduction: use an isolated checkout of the PR, install the repository-pinned Rust/Node/pnpm toolchain, run `pnpm install --frozen-lockfile`, and execute the nine commands listed in `validation.json`. Set `RUST_TEST_THREADS=1` for the recorded Windows test configuration. Build the repository's native `crony-mcp` binary and set `CRONY_MCP_TEST_BINARY` to that owned binary for native MCP unit coverage. These results do not substitute for fresh hosted checks, required independent reviews, or production identity/provider acceptance.

Maintainer self-review: inspected the final implementation and its current-main integration against the product, architecture, security and evaluation contracts. Only evidence documented here is claimed; existing historical reports retain their original scope and limitations.

Native Git received `core.longpaths=true` through process-only Git configuration for the recorded commands. Repository and global Git configuration were not changed.

Build provenance: Workspace package artifacts are removed under the task Cargo mutex before Rust validation. Third-party dependency cache is retained. Node tests use a freshly built copied native MCP binary. `validation.json` also binds the workspace-refresh and MCP-build logs, their original/published hashes, and the copied MCP binary hash.

## Review corrections and actual results

- A359-F01: immutable provider artifacts and final snapshots now use exclusive creation, with directory revalidation and a post-write source-integrity check. The same 16-test retrospective run on the unchanged published implementation had 8 passes and 8 failures; the corrected run had 16 passes, 0 failures and 0 skips. The Windows symlink cases actually executed. The initial import failure remains retained and is not counted as baseline defect evidence.
- A359-F02: storage read, write and cleanup failures propagate to visible callback errors. Key acquisition is inside each caller's error boundary and precedes API dispatch. An uncertain response retains its durable key; successful cleanup removes only the matching key. No UUID fallback silently claims durability.
- A359-B02: the earlier r2 README sentence claiming that the browser did not receive the database credential was inaccurate. Edge inherited the ACL-readable PGPASSFILE locator from the focused driver. The old packet and historical claim are preserved. The new Edge launch uses an explicit environment allowlist; the receipt records its variable names. PGPASSFILE goes only to the fixture/SQL client child. Same-user OS isolation is still not established; native server/SQLx environment delivery remains reduced assurance.
- Narrow-screen acceptance: actual Pin and Unpin clicks executed at 390 CSS pixels; every recorded 390/1440 viewport had equal client and scroll width. Ten genuine application captures, both requests/responses and empty browser-error results are retained. The completed-retention captures show the office after retirement; retained history is established by the saved native snapshot and assertions, not by a visible history list in those screenshots.
- Room planning: 16 store and 3 server SQLx tests executed against a fresh, owned PostgreSQL instance. The added regression has an older room A and newer room B, saves/reuses a B-room pinned worker and rejects unauthorized/foreign-Corp or revoked access. Candidate selection carries the authorized saved-connection room into the store lookup; no cross-room execution is permitted.

## Retrospective effectiveness evidence

The full historical driver from `5bfb44015b1f97e21e768ea0054b26f16b83350d` and full corrected driver ran against six fresh synthetic Git sources with a committed sentinel. Equality, nested output and a junction alias all caused the old driver to add its checkpoint inside the source; all three corrected cases rejected before writes and preserved the complete source state. The first network fetch was intercepted before network activity. `retrospective/full-driver-path/receipt.json` records the exact driver hashes, commands, timestamps, before/after Git/filesystem state and execution logs. The earlier r2 path test used a non-Git fixture and is explicitly insufficient as source-damage proof; its failure is retained.

For database authentication, the PowerShell AST extracts and executes the exact initdb command bytes from the retained r1/r2 supervisors, bound to their hashes. Two new loopback-only PostgreSQL fixtures show the baseline trust configuration accepting a wrong password (exit 0), and SCRAM rejecting it (exit 2); the correct credential works in both. Their exact owned processes were stopped and listener cleanup verified. Private credential files and database directories were retained locally and are not published. These are retrospective baseline/candidate runs, not claims of original development chronology.

Native execution used the same staged source tree as the nine gates. `native-lifecycle.json`, `source-binding.json`, and `artifacts.json` bind actual commands, source, executable and log hashes. The stack stopped only its recorded owned processes; fixture data, sources and workspaces were retained. Deterministic development principals and provider fixtures do not prove production identity or real-provider acceptance. Reproduction drivers use normalized path placeholders in this public packet; original bytes and hashes remain in the private evidence directory.

Trailing line whitespace and blank lines at EOF are removed from the published logs. This formatting normalization does not alter test-result text; original and published hashes are distinct. The local `.gitattributes` preserves published evidence bytes on checkout.
