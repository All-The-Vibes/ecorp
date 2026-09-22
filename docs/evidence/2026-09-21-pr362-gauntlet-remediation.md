# PR #362 evidence remediation — September 21, 2026

This is an additive evidence correction, not another application/security-policy repair,
an independent approval, a merge, or production acceptance.

## Source and attribution

- Author's reviewed head: `3963858e553be7ef375568e505c37e24e1fad192`.
- Contained target: `410eddfc8bfcfa874dae05555128d39a914f0456`.
- Reviewed source tree: `356a14754ae61d8bb454d1ad9c2f7e397565d29f`.
- New native worktree: `ecorp-gauntlet-fix362-20260921`; branch:
  `codex/pr362-gauntlet-evidence-20260921`.
- Operator: automated Codex evidence-remediation worker, authorized by the PR author/user.
  This is not a representation that the human author personally performed this worker's actions.
- Original author attestation is retained: the PR checklist states
  “Self-review and independent source reviews completed.” Its private process is not independently
  observable. This addendum neither replaces that attestation nor invents a requirement for a new
  human self-review.
- Member-account review `5269572782` already approved the exact head and describes detailed local
  and browser/server/runner verification. It is evidence to retain, not absent work and not the
  author's self-review. GitHub's protected-review decision remains separate.

The automated maintainer check traced the reported omissions against the pinned base template,
both independent gauntlet reports, the existing author attestation, retained logs, and native
tests. No introduced source defect was found by either initial independent lane. This worker
does not act as either fresh independent reviewer.

## Explicit test configuration

- **Firmware:** N/A — software-only transport, fixture and documentation work; no device firmware.
- **Hardware:** Windows x64 host; local loopback fixture services. No physical multi-host claim.
- **Toolchain:** Rust/Cargo 1.98.1, Node 24.16.0, pnpm 11.19.0; exact invocation versions are in the
  raw receipt. Existing bundled Python and Playwright are used where identified.
- **SDK:** N/A to the tested provider boundary — no real provider SDK session is exercised.
  Existing dependency/SDK pins remain unchanged; fixture success does not qualify provider execution.
- `CARGO_BUILD_JOBS=2`, isolated candidate build output, `RUST_TEST_THREADS=2`.
- Existing pnpm dependencies restored from the approved Package Feed mirror with the committed
  frozen lockfile and integrity validation. No dependency, tool, lockfile, or bypass flag was added.
- Forbidden shared API `8791`, web `5187`, database `54329`, and live Factory are not QA targets.

## Raw local receipts and earlier evidence

The committed [receipt index](pr362-gauntlet-20260921/manifest.json) binds the images and raw
logs by SHA-256. [Raw receipts](pr362-gauntlet-20260921/receipts.zip) are archived byte-for-byte
to preserve native CRLF and test-output whitespace without weakening Git's normal checks.
For an index entry with `archive`, its `path` is the member name inside that ZIP.
The exact executed source is the 739-file blob/SHA-256 inventory; the final
source check verifies those executable/test inputs stayed unchanged. Only `docs/evidence`
additions and the link from the original report differ in this candidate. The final candidate
commit/tree readback is in the operator packet, avoiding a self-referential commit hash here.

The operator packet is retained at:

```text
<original-user>\repos\ecorp\output\pr-gauntlet-20260921\pr362\remediation
```

`plan.md`, `initial-source.txt`, `remote-before.txt`, `pr-before.json`,
`tracked-inputs-before.json`, `run-gates.ps1`, and `precommit/identity.json` record scope,
source identities and executable commands. Each gate's unmodified stdout/stderr, actual exit,
timestamps, and SHA-256 are retained in `precommit/*.log` and `precommit/results.json`.
Ignored, skipped, filtered and unrun cases are not passes.

`retained/inventory.json` hashes copied historical author-worktree logs without modifying their
originals. In particular, `post-rebase-native-startup-results.json` records successful startup
at `09f916380ad8e9d8b7a2ebf34738590ece3c44b0`, not the later merged head. The original full-suite
logs do not bind every command to the complete merged tree, so fresh candidate gates supplement
them rather than claiming they never existed. The public exact-head review is retained separately.

All nine current contributor gates returned **exit 0** on this worktree's unchanged executable
source. Their native invocations were also captured in Windows Terminal, not reconstructed from
saved logs. The first raw pass and each capture pass remain distinct.

| Command | Actual result |
| --- | --- |
| `node tools/check_migrations.mjs` | 41 immutable migrations |
| `pnpm check:docs` | 5 validation documents, 2 runtime paragraphs, 9 commands |
| `pnpm test:unit` | 1,205 passed; 44 skipped; 0 failed |
| `pnpm test:steward` | 227 passed; 0 failed/skipped |
| `cargo fmt --check` | Exit 0; no stdout |
| `cargo clippy --workspace --all-targets -- -D warnings` | Exit 0 |
| `cargo test --workspace` | 572 passed; 343 ignored; 0 failed |
| `pnpm build:web` | Exit 0 |
| `pnpm lint:web` | 0 warnings/errors; exit 0 |
| `cargo test --locked --offline -p crony-cli transport::tests -- --nocapture` | 2 passed; 119 filtered |
| `cargo test --locked --offline -p crony-gateways -- --nocapture` | 18 passed across library/binaries |
| `node --test tools/security_fixtures.test.mjs` | 1 passed |
| Python `-B -m unittest discover -s tools -p test_startup_validation_harness.py -v` | 5 passed |
| Compiled MCP/probe/receipt trio from CI, with candidate `CRONY_MCP_TEST_BINARY` | 99 passed; 0 skipped |

The 343 ignored Rust cases and 44 skipped Node cases are not passes. Separate compiled MCP
execution does not silently convert the earlier Node lane's skips into passes.

The existing successful startup drill at `09f9163` is reused, not rerun merely to create an
artifact. A native Git comparison found no changes through `3963858` in the server, store,
domain, protocol, Cargo manifests/lockfile or both startup harness files. This is a retained,
source-equivalent startup-scope receipt, not a newly executed complete merged-tree startup run.

## Retrospective regression evidence — not historical TDD

These reproductions occurred **after** the original repair. They cannot establish when the
original author wrote tests or reconstruct missing historical TDD chronology.

| Boundary | Reproduction and meaning |
| --- | --- |
| Proxy exception disclosure | The unchanged current `tools/security_fixtures.test.mjs` is copied into a new, otherwise unchanged detached baseline at `410eddf`. `node --test tools/security_fixtures.test.mjs` exits 1: expected fixed public text, actual synthetic exception marker. The same test exits 0 on `3963858` (1 passed). `retrospective-proxy.json` binds the test hash, source and raw red/green logs. This executes the actual extracted proxy function, not a substituted mock implementation. |
| Gateway redirect diagnostic | The existing current `every_gateway_mode_refuses_credential_bearing_redirects` test function alone is overlaid on a new detached `09f9163` baseline. The exact focused Cargo command exits 101 at `message.contains("redirect 307")`; the same command passes on `3963858` (1 passed, 12 library cases filtered). The overlay diff and source-bound raw receipts are retained. Empty/HTML/JSON redirect responses in both access modes are exercised by the passing current test. |
| Native MCP redirect refusal | The unchanged current probe test is run against an exact `410eddf` native MCP binary, then the candidate binary. The same filtered Node command exits 1 then 0 (one test). The baseline's write-capable response lacks the expected `error` object, causing the retained TypeError at `.error.code`; this is the observed behavioral failure, not a claimed assertion message or environment failure. Binary and test SHA-256 values bind both runs. |
| Nonce generator | The existing repeated-plaintext test checks fresh 12-byte nonces, ciphertext and round-trip behavior. The former UUID-derived implementation can also pass those assertions. This worker does not invent a deterministic failing entropy test or claim those assertions prove the complete entropy distribution. |
| Explicit TLS minimum | Runtime handshake checks prove verified TLS 1.2 behavior. A Python/OpenSSL default may already enforce TLS 1.2, so a passing historical handshake alone cannot distinguish an explicitly configured minimum. The retained source diff and review feedback establish that configuration correction; no forced historical failure is manufactured. |
| Documentation/evidence omission | No application behavior is changed here. Executable red/green TDD is inapplicable to adding truthful metadata, existing receipts and genuine captures. Before/after rubric review remains the appropriate check. |

Other retrospective results, if present in the packet, are independently source-bound; no single
retrospective reproduction is represented as complete original red-before/green-after chronology.

## Screenshot provenance and acceptance limits

Only actual test-surface captures may be committed. A rendered Markdown/HTML evidence report,
fabricated console image, or fake-agent PNG signature fixture is not a runtime screenshot.
The existing owned-stack browser harness provides actual browser/server/runner captures and
records image hashes, mission/run identities, source identity, viewport and expected outcomes.
Its deterministic `fake-process` and development principals are not real-provider or production
identity acceptance.

The committed images are in [screenshots](pr362-gauntlet-20260921/screenshots):

- `01-*` through `09-*`: actual native output for each contributor gate.
- `10-*`, `11-*`, `12-*`, `13-*`, `15-*`: affected CLI, gateway, proxy, Python and compiled MCP tests.
- `proxy-retrospective-{red,green}.png`: actual retrospective regression invocations.
- `browser-*`: real desktop/390px editor, saved-plan, verified-completion and deliberate-failure
  captures from the unchanged owned-stack browser harness.

The terminal scripts execute the named commands and retain full raw stdout/stderr, displaying a
bounded tail (or native Rust per-suite result lines). Cua captures the exact owned window using
the supported `start_minimized:false` non-activating launch route. Images were visually checked.
No foreground takeover, API shim, report replay, screenshot fabrication or fake-agent PNG is used.

Two failed evidence attempts remain retained: the initial minimized terminal had no rendered
pixels; the first capture wrapper did not create a log for rustfmt's empty stdout and failed its
subsequent hash step. The wrapper was corrected to create the empty log first and resumed in a
new directory at gate 5, without rerunning gates 1–4 or treating that helper error as a test pass.

### Owned browser/server/runner acceptance

Native helpers started a new server `18862`, web `15862`, runner `pr362-evidence-qa`, and a
label-owned Docker PostgreSQL container on loopback `50465`. There was no Factory watcher,
real provider, production identity, external chain or shared database.

The first browser attempt correctly failed because this worker's synthetic source omitted
the caller-supplied `fixture.test.mjs` required by the existing harness. Its failed run and
worktree remain preserved. A new commit on that synthetic fixture repository supplies the
Node test of the fake process's exact `verify.txt` and `schema.json` outputs. Only the owned
runner was restarted to advertise the new source pin; the server, web, database, credentials
and failed history were not reset. No product source or verifier policy was weakened.

The unchanged browser harness then passed: saved plans had zero runs before explicit launch;
the successful mission's real runner passed all six verifier kinds; the deliberate byte-floor
failure had zero accepted completion events. Desktop and 390px interaction/layout checks passed.
The product source is `3963858`; the independent synthetic source is
`7895b663383586f7be668efe84618c7339d17d62`. These are different identities, not interchangeable.
The report records both mission/run lineages and verifies the synthetic source stayed unchanged.

Cleanup verified three owned service processes stopped and zero uncertain/reused PIDs were
touched. The label-verified Docker container is stopped, not removed. Its volume, database,
credentials, source, failed/successful run worktrees, logs and ownership records are retained.

## Automated maintainer self-review

This worker checked the evidence-only path set, raw command exits/counts, unchanged executable
source and lockfiles, real screenshot pixels/provenance, retrospective labels, synthetic-source
correction and cleanup records. The exact final path/tree/hash readback is retained in the
operator packet. This is attributable **automated** maintainer review under the user's authority,
not a newly invented human self-review or an independent approval. The original author attestation
remains the author-supplied evidence.

## Remaining gates

The initial paired Santa result was FAIL/PASS, therefore **NAUGHTY**, with overall **BLOCKED**.
This evidence worker cannot upgrade that verdict. The parent must inspect the exact correction,
obtain fresh dual independent reviews, assess any remaining literal screenshot/chronology rubric
limits, refresh hosted checks and satisfy GitHub's protected reviews. No push, comment, PR-body
edit, review dismissal, merge, provider call, or policy waiver is performed by this worker.


September 22, 2026 publication correction: the report and retained receipt text now use `<original-user>` for personal home prefixes. The public archive is a path-normalized copy; private original bytes are retained. The manifest records separate original and published hashes, and hashes inside historical receipt payloads continue to describe the original execution bytes. Screenshot bytes, recorded results and historical source bindings are unchanged.
