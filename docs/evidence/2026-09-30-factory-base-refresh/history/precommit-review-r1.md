# Issue 84: precommit implementation review

Reviewed on September 30, 2026 by the automation in this chat. This is an AI implementation review, not an independent human decision or a GitHub approval. The authenticated publication actor remains `shyamsridhar123`; self-approval is prohibited.

The candidate is the uncommitted `codex/issue84-base-refresh` worktree at `<USERPROFILE>\.codex\worktrees\issue84-base-refresh\ecorp`, based on `878a1774774b0630c904cbaf4b05e1b346777817`. `issue84-source-binding-r1.json` binds the 7,162 candidate files to full-stack acceptance R10, the start of canonical validation R1, and runtime build R2. A later commit-binding receipt is required before publication.

The implementation adds a governed verification-only operation for an already verified Factory deliverable whose publication base advanced. It retains the original mission, run, deliverable and verified commit, constructs the saved delta in new private Git storage, reruns the complete saved policy, requires independent review, and selects the result only through explicit adoption. Publication continues through its existing aggregate and native publisher.

## Acceptance mapping

| Issue requirement | Implementation and observed evidence |
| --- | --- |
| Explicit actor authorization and idempotency | `crates/crony-store/src/factory_base_refresh.rs:290` and `:342` authorize and settle with the current actor, claim, item version and exact saved operation arguments. CLI replay tests cover changed arguments, actor, item, key and settlement action. Acceptance R10 authorization/adoption/abandonment retries converge. |
| Pin new base and preserve lineage | Domain requests accept full immutable source IDs. `db/migrations/0057_factory_base_refresh.sql` retains scoped original/new mission, task, run, deliverable, base, commit and decision identities. Update/delete guards preserve authority and make settlement terminal. Adoption tests and acceptance R10 retain the original result. |
| Reconstruct in new isolated storage | `crates/crony-runner/src/base_refresh.rs:84` reuses portable deliverable bundles, native Git object transfer and `merge-tree`, then existing canonical snapshots/export. Source repository refs and worktree are not rewritten. Nine native runner regressions cover exact tree, conflicts, tampering, non-descendant bases, changed scope and existing owned directories. |
| Complete persisted verifier policy | `crates/crony-domain/src/factory_base_refresh.rs:68` copies all saved automated checks, preserves role restrictions and strengthens the manual gate. Store contract revalidation and runner policy failure tests reject replacement or weakened evidence. R10 executes artifact, file and command checks on the refreshed run with no provider allocation. |
| Fresh independent review | `crates/crony-store/src/factory_base_refresh/lifecycle.rs:311` excludes authorizers and original requesters/producers across bounded lineage. `factory_base_refresh.rs:198` rechecks reviewer role/membership and the exact saved decision at adoption/publication. R10 rejects requester review and premature adoption, then exercises the actual App review callback and reload. Fixture actors are explicitly not independent human signoff. |
| One branch and PR from exact result | `crates/crony-store/src/publication.rs:1747` fences pending refreshes and validates adopted lineage before the existing one-per-item effect. R10 native publication and retry produce one fake GitHub PR, one publication branch, and exact commit `21c5153d82e75e11a30c5a73e9e616529f232912` on a local bare remote. This is not a hosted GitHub publication claim. |
| Reject conflicts and changed authority | CLI checks observed issue/repository identity and exact remote base; dispatch revalidates saved contracts, claim, connection, command and scope. Negative tests cover stale callbacks, role loss, source changes, provider metadata, emergency stop, quarantine and breakers. R10 rejects changed issue/repository/policy and preserves the original result after a merge conflict. |
| Durable audit with both bases, result and review | `crates/crony-store/src/state_audit.rs:1347` records refresh operations; `:1725` includes linked history. `crates/crony-audit/src/history.rs:327` validates bounded unique lineage and scope. Store R11 includes the adopted archive regression preserving both missions and the exact decision. Existing applied SQL is unchanged; only migration 0057 is new. |

## Review coverage

Inspected the new domain, protocol, server, CLI, runner and store paths plus affected publication, checkpoint retention/correction, budgets, breakers, source export, workspace handling, browser decisions and state-audit code. Reviewed the entire runner reconstruction and server refresh module, authorization and settlement transactions, dispatch race handling, inherited artifact provenance, policy transformation, migration constraints, operator documentation and acceptance driver.

The native Git, workspace, verification, durable command and publisher capabilities are reused. The new ECorp mechanism supplies scoped cross-mission authorization, bounded immutable lineage and adoption; it does not add a provider execution or permission mechanism. Provider-free allocation is recognized only for the exact saved verification-only authority and cannot be widened by provider-session or model metadata. Three lifetime attempts include abandoned attempts. Original hard-stop and budget provenance still fence adoption/publication.

The App callback now retains a decision key across uncertain responses and fails before dispatch if browser storage cannot retain it. Five tests exercise the actual callback extracted from `App.tsx`, including both approval and rejection, failed storage, and actor/run/decision scoping. R10 independently exercises the browser-to-server path.

No new unresolved production defect was found in this review. Ordinary `git diff --check` passed. A diagnostic invocation that forced `core.autocrlf=false` produced line-ending-only whitespace noise; it was not a source defect and did not change any file.

## Observed validation and limits

- Full-stack R10: 10/10 scenarios passed; source unchanged; real Chrome/App/server/runner/Git with a fake-process provider, fake GitHub boundary and local bare publication remote. The publisher credential was revoked and all owned services stopped, including PostgreSQL with exit code 0. Failed R8/R9 attempts remain preserved.
- Store R11: 21 passed, 0 failed, 0 ignored, 551 filtered; real owned PostgreSQL with synthetic fixture metadata, not native provider proof.
- Predispatch R1: 8 passed, 0 failed, 0 ignored, 564 filtered; separate owned PostgreSQL regression lane.
- Native runner R4: 9 passed, 0 failed, 0 ignored, 286 filtered in the relevant binary; the library binary had 0 selected / 25 filtered.
- CLI R4: 12 passed, 0 failed, 0 ignored, 156 filtered.
- Browser decision R1: 5 passed, 0 failed/skipped/cancelled/todo.
- Locked dependency installation and runtime build R2 passed. Focused evidence predating later changes must be read with its recorded source manifest; it is not automatically final-revision evidence.
- Canonical `pnpm check` R1 is still running. Migrations (57), state-audit compatibility, the native EVM gate (1 passed), documentation and repository-documentation checks passed. Node discovery, formatting, clippy, Rust workspace tests, web build and lint are not claimed complete in this receipt.
- Optional legacy browser `--pure-test` comparison R2 reports the same 28 tests / 18 passed / 10 failed on main and candidate. It is outside canonical discovery; those failures remain recorded rather than relabeled as passes. The R2 comparison corrects the earlier R1 parser error.
- Inventory R15 found 97 open issues and 11 open PRs, with main unchanged. Repository Actions was disabled. Required hosted CI, CodeQL, security and code-quality evidence is unavailable. No merge, issue closure, self-approval or policy override is allowed on the strength of these local results.

Before publication, finish canonical validation, resolve concrete failures, refresh remote issue/PR/main/gate state, bind the commit to the tested source, and publish exact results and limits. Keep issue 84 open until the implementation PR is actually merged and every acceptance requirement is fulfilled.
