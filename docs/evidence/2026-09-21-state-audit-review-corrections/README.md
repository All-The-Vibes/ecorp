# State-audit review corrections — September 21, 2026

**Four corrective fixes are proposed for publication. B04 remains OPEN. This is not full-PR NICE or merge authorization.** Starting remote head: `ab84f5aa72649fad2e323fac95d3e8755ebd6e96`.

## Current publication scope

- **B01/A02:** ledger-before-destination reconciliation, matching configuration.
- **B02:** independently retained, explicitly destination-bound remote ancestry checked inside publication before any create, in addition to the database fence. Bootstrap limitations remain explicit.
- **B03/A01:** the two semantic verifier-policy denials use the existing refusal type; SQL/auth/integrity failures are not broadly reclassified.
- **B05:** native error prefix and HTTP409 remain intact while attaching the stable receipt, including refused replay.

Each included fix has genuine behavioral RED/GREEN evidence. Current combined validation and an actual browser capture of those results are in [publication-verification.json](publication-verification.json) and [publication-verification.png](publication-verification.png). The image is a test-report capture, **not product UI or browser-server-runner acceptance**. Current log derivatives and their private-original/committed-LF hashes are listed in [publication-log-manifest.json](publication-log-manifest.json).

## B04 was withheld, not declared complete

Independent review of the unpublished five-fix candidate `dad4e76a91ee9caecb8a246cfeddd004853137b6` found that B04's early normalization could lose already-retained padded-key receipt identity. One reviewer failed the candidate; the other's PASS could not override the two-reviewer AND gate. That candidate was not pushed.

The B04 source/test change is withdrawn from this proposed publication, restoring the exact original source-upgrade admission/replay implementation while preserving the four other fixes. This closes the newly introduced proposal regression by withdrawal, **not** by claiming the original normalization defect is solved. The original raw-versus-normalized alias gap remains OPEN for a separately verified history-compatible correction. No immutable receipt, database history, migration or prior Git commit is rewritten. This is not an error-swallowing fallback or a passing mark for B04.

The old B04 tests, passing/failing logs and source remain retained in Git history and the evidence packet. Removing the unshipped B04 proposal from this narrower publication does not remove or weaken the original branch's tests; it does not establish full acceptance.

## Historical five-fix-candidate evidence — not current acceptance

[verification.json](verification.json), [tdd-summary.json](tdd-summary.json), [verification.html](verification.html), [verification.png](verification.png), and [redaction-manifest.json](redaction-manifest.json) describe the historical five-fix candidate above. They are preserved unchanged as historical records. Their figures are **not promoted into the current candidate** after the B04 withdrawal.

That historical candidate had15 actual behavioral RED failures across five proposals, then six original contributor commands passed:561 workspace tests passed,371 ignored, plus29 store and10 server selected checks. Its newly added B04 same-version tests passed, but they did not cover the retained-state regression found by independent review. The existing worker-start tests' SQLx database-drop warnings remain in the logs. A passing historical run does not establish a later source revision or rewrite earlier failures.

The screenshot is a real browser capture of retained test results, not the product UI. Public logs are explicitly path-redacted and whitespace-normalized derivatives; private raw originals and SHA-256 mappings remain retained. Published hashes cover canonical Git UTF-8/LF bytes, not CRLF checkout bytes. No test result, error or warning is hidden by normalization.

## Current nine-command requirement and remaining gates

The user subsequently required nine contributor commands, adding `pnpm check:docs`, `pnpm test:unit` and `pnpm test:steward`. All three were actually attempted and returned command-not-found; their scripts are absent from the unchanged historical `package.json` on both old remote and this correction. They are **unavailable completion gates, not passing checks or waived requirements**. An older six-command success is not nine-command completion. Current attempts are retained with the publication verification.

Full PR completion remains BLOCKED on the open B04 issue, all current validation requirements, a fresh full-template Santa pair, original-feature portable runtime/browser-server-runner evidence, genuine original-author self-review and required human approvals, target integration and migration/dependency coordination. No applied SQL was renumbered or rewritten. Current-head hosted CI and automatic Copilot feedback must be read after any publication; earlier checks or quota refusals do not count as a new review.

The independently read live `refs/heads/main` tip at initial target validation was `410eddfc8bfcfa874dae05555128d39a914f0456`, not the PR API historical base `b2523964e7576cafc00e84a51e1044f55826dea7`. The original branch has conflicts in `.gitattributes`, `Cargo.lock`, `crates/crony-server/src/main.rs` and `package.json`. Recheck both original and current correction against the same live tip before pushing; counts alone do not prove conflict resolution.

## Reproduction and boundaries

Use only an explicitly owned disposable PostgreSQL maintenance database in `DATABASE_URL`; never a shared/application database. Relevant native lanes:

```sh
cargo test -p crony-store --lib --locked --offline state_audit_tests:: -- --include-ignored --test-threads=1 contract_revision::state_audit_refusal_tests::
cargo test -p crony-server --locked --offline state_audit:: -- --include-ignored --test-threads=1 factory_source_audit_tests::
```

Windows x64, Rust1.98.1, Node24.16.0, pnpm11.19.0, owned PostgreSQL17-alpine; two build jobs and one test thread. Unrelated credentials are scrubbed. Ephemeral fixture credentials use child environment delivery, explicitly reduced assurance. Fixture keys, metadata and remote transport are synthetic. No real audit-publication GitHub write, provider inference, live Factory activation or chain transaction occurred. No merge, force/base push, draft-ready mutation, approval impersonation or protection change is authorized by this report.
