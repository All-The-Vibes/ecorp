# Assistant implementation review for issue #89

Base `878a1774774b0630c904cbaf4b05e1b346777817`; reviewed tree `e0fa27adaadb19cc373dcca2dfd104ae68047189`; complete physical-source SHA-256 `b22e647237915d772b0fbe5bdd1c7bd579de721793ce1962e627510463d037a4`. This is assistant review, not an independent human approval.

## Acceptance mapping

| Requirement | Implementation and observed evidence |
| --- | --- |
| Cover complete preserved tracked/staged/untracked delta | `crates/crony-runner/src/preserved_deliverable.rs` inventories both physical and semantic index state; retained proof tests and native parity exercise hidden staged source. |
| Reject narrowing without implicit scope expansion | `crates/crony-store/src/preserved_deliverable.rs`, `contract_revision.rs` and `budget_revision.rs` bind authenticated checkpoint evidence under the existing transaction and validate contract/finish scope; SQLx and browser r13 show rejection with no revision/provider effect. |
| Require current runner-global retained-deliverable support | Server admission tests cover missing/unavailable/workspace-scoped/other-runner/lost support, connection epoch, readiness, safe stop, legacy commands and fresh canonical-only starts. |
| Check exportability before resumed provider | `crates/crony-runner/src/retained_deliverable.rs` and `main.rs` verify checkpoint proof and run the existing native export preflight before provider launch. |
| Never automatically retry export failure in a fresh tree | Existing PR355 typed failure/recovery handling remains; current native/store regression lanes cover the surrounding retained-checkpoint behavior. |
| Precise recovery action | Domain/store errors identify excluded source and direct full-scope same-worktree recovery; browser r13 observes the HTTP400 error naming `base.txt`. |
| Full creation, evidence-only correction, complete export | Fresh browser r13 uses real native persistence, verification and export; independently imports the signed bundle, verifies byte preservation and runs the exported application. |

## Inspected boundaries

- Proof validation binds run, retained workspace, mission, room, Corp, base, full snapshot, semantic index and sorted complete path set. Checkpoint admission and command execution preserve existing actor authorization, durable idempotency, budget state and lock ordering.
- Capture occurs after native provider termination under the retained workspace lock. Time, entry, byte, path and artifact limits fail closed, and cancellation remains effective.
- Provider artifact exclusions are authenticated, deduplicated and raw-byte checked. A different staged blob, staged deletion, conflict stages or non-file mode remains deliverable state. The checker sanitizes inherited Git environment and reads the real index, with a documented 8MiB bound.
- Retained ResumeRun, VerifyRun and CheckpointWorkspace commands recheck global support on the selected current runner. Capability loss, replacement epochs and unready connections fail before send; safe stop remains available. Fresh starts and commands without a deliverable retain their original admission requirements. The eight admission tests and full server package were observed on the same repaired source as canonical r4.
- Existing and legacy recovery commands retain frozen scope and require re-attestation or capability negotiation when proof is absent. The server never executes the agent's shell. Configured source checkouts and unverifiable retained worktrees remain preserved.
- Native Copilot/Codex resume, the existing exporter, snapshot machinery and approval commands are reused. No new permission bypass, independent retry engine, migration rewrite or secret delivery mechanism is introduced.
- Pinned Copilot SDK 1.0.11 / CLI 1.0.79 are unchanged. Existing substantive issue/PR355 feedback about absent scope and pre-provider checks is addressed by the new guards and fresh evidence; original contribution chronology is retained.

No unresolved concrete correctness finding was identified in this inspected revision. Remaining limitations are explicit in `summary.json`: hosted gates, existing Cargo advisories, Windows serial-test qualification, controlled provider/authentication, and the earlier full-ECorp checkpoint timeout. Final publication must additionally verify the complete check plan, unchanged tested source, added evidence bytes, committed secrets and current remote base/head.
