# PR #293: Base V2 review corrections and local qualification

Require agreement from both receipt providers before replacement, lock shared sender lanes before destinations, allow only monotonic L1-fee enrichment, require a complete-archive witness, fairly discover configured destinations, and preserve terminal incidents.

The reviewed final source tree is `df9d80c488eee93b00875c8f8e29a4bba1ca892f`. All nine contributor gates passed. Both additional branch commands also passed: `node tools/check_state_audit_compatibility.mjs` and `cargo test --locked -p crony-audit --test ethereum_local_chain`. The latter is an in-memory revm test; it is separate from the owned Anvil execution.

The final-source native build produced five hashed binaries. `native/execution.json` records 17 passing steps, including a real browser-to-server-to-runner task with explicit mission, verifier and independent review state; complete GitHub-style archive publication/readback; once-only signing journal recovery; actual local-chain receipt and finality ancestry; signing, broadcast and final process restarts; and browser authorization/readback. `native/product/acceptance.json` is the original acceptance result. Its surface and restart hashes are verified against the exact bytes published here. The three PNGs in that directory are genuine product captures. `validation.png` is a rendered test report.

The separately retained worker acceptance used owned PostgreSQL and Anvil 1.7.1 with an actual local HTTP gateway and restart/finality path. Database regressions executed 33 Base V2 tests, configured-destination observation in both server and worker binaries, and 22 archive/state-audit tests. Their source tree was `cc92da1a2d52fa724c5a35c8ee2e871a5a7da7ed`. Production source and those executed tests match the final tree; the complete six-file delta is retained as `retained-regression-source-delta.patch`. It consists of five documentation files adding two branch-specific validation commands and a fully qualified SHA1 Digest call in one archive publication test. The changed test is covered by final-tree contributor validation. Earlier regression receipts are not represented as whole-tree-identical reruns.

Corrections correspond to the six review threads:

- Both receipt providers must confirm matching absence before rebroadcast or replacement; disagreement remains pending reconciliation.
- Every wallet operation acquires the shared sender lane before destination locks, including deterministic multi-wallet enrollment and wallet-wide incident paths.
- Only L1-fee `None` to `Some` enrichment is accepted after canonical receipt equality; the enriched observation persists through final settlement.
- Preview, signing readiness and intent creation require a verified complete-archive publication witness.
- Worker discovery queries configured destination IDs, with a regression beyond the first 1,024 global rows.
- Finalized contradiction, conflicting anchor and invalid evidence remain terminal until linked recovery.

Reproduce from a fresh isolated checkout with the pinned Rust/Node/pnpm tools and frozen dependencies. Run the commands in `validation.json`, the two branch-specific commands above, and the selected ignored PostgreSQL tests listed in retained logs against a new owned maintenance database. The exact executed external supervisors/adapters are retained under `native/recorded-drivers/`, with original and adapted source hashes in `native/driver-adaptations.json`. Their paths are those of the recorded Windows environment and must be rebound to new owned roots before replay. The native product acceptance assertions were unchanged. Use fresh fixture databases, ports and output roots; never point these drivers at a shared service.

Native r1-r4 attempts are retained with their observed failures. R2 failed the external synthetic-clone long-path setup, r3 exposed local timestamp rendering differences, and r4 preserved the same instant with different fractional-string precision. R5 enabled long paths only in its new synthetic clone, used UTC for the owned database, and retained exact process timestamps with `ConvertFrom-Json -AsHashtable -DateKind String`. No acceptance assertion was weakened. Original fixtures and logs remain preserved; all eight r5 roles were stopped by the owned cleanup.

Limits: Windows, Node24.21.0 (repository pin24.19.0), Rust1.98.1, PostgreSQL17.10. Docker was unavailable. Full qualification used loopback trust authentication, explicitly reduced assurance; the separately retained SQLx/worker lanes used SCRAM and reduced-assurance environment-only SQLx credential delivery. Identity actors and the runner are developmental/deterministic; signing uses a memory signer; GitHub and fee oracle are local fixtures. Both RPC endpoints share the same Anvil instance and are not independent infrastructure. This is not public Base, real GitHub, external KMS, hardened authentication or production qualification. Factory remains disabled. Hosted checks and required independent review are separate.

Evidence privacy: selected public chain/stream hashes, idempotency UUIDs and literal fixture credential handles are preserved in readable exact receipts. They are not authentication values. Credential directories, database configuration, provisioning material and nested source/runner workspaces are not part of this packet.

Trailing line whitespace and blank lines at EOF are removed from the published logs. This formatting normalization does not alter test-result text; original and published hashes are distinct. The local `.gitattributes` preserves published evidence bytes on checkout.

The source-tree delta patch is a zero-context Git diff; apply with git apply --unidiff-zero --index. The published full-runtime supervisor removes blank lines at EOF only. Its original executed hash and published hash are separately retained. All product acceptance/restart bytes remain exact.
