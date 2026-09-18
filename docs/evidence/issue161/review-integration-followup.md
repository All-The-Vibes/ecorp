# PR255 review and current-main integration

Date: September 17, 2026. Partial, non-closing contribution toward #161.
Reviewed starting head: `00a13ff1cf41bf90fc6efd5a5f1bda17ece92f6b`.
Integration base: `c44fe9c93b27b042f906930e0ac5958ed16ddd5d`.

## Review response and scope

Shyam's September 17 review identified readiness wording and migration sequencing,
not a new correctness defect in the bounded authority implementation. Afateen later
approved the same old head. Neither approval nor its old CI result is acceptance
of newly combined source. This contribution remains Ready for fresh review only;
no merge, auto-merge, deployment or completion of #161 is claimed.

Current main introduced planning-cost admission. Native merge preview identified
two conflicts, resolved by retaining **both** checks on new claims:

- mandatory matching authority pins for new production claims;
- native planning-cost policy validation before claim persistence.

Both claim-authority and cost-policy regression modules remain registered. The
authority admission test now also proves that a valid authority pin with zero
cost is rejected without ledger/idempotency effects, and that a subsequent valid
claim reuses the untouched operation key. No second ledger or admission mechanism
was introduced.

Migration `0042_factory_claim_authority.sql` and its manifest checksum are unchanged.
Open PR #283 also allocates0042; the proposed integration order is authority first,
then audit migration reconciliation by that contributor against the actual landed
lineage. This is coordination, not permission to merge either PR or rewrite any
already-applied checksum. The ledger UUID remains an immutable authority pin, not
a distributed lock across copied databases. Dispatch-time source drift rejection
still follows materialization; #256 remains separate.

## Fresh local validation

On the integrated working source, before the integration commit:

- 42 immutable migration checks passed; format and warning-free workspace Clippy passed.
- `cargo test --workspace --offline --locked -- --quiet`: **561 passed, 352 ignored**, zero failures. Ignored:1 runner,8 server,343 store. These were not executed by the generic gate.
- Frontend/office suite: **281 passed**; web build and lint passed.
- Focused authority UI and QA-plan tests passed.

The approved fixture preview used a new disjoint loopback PostgreSQL root:
`C:\Users\aabdelsalam\.ecorp\qa\issue-161-review-integration-20260918`, port55462.
The root did not exist and the port was free. Native local_stack.psm1 ownership
helpers started/verified only that PostgreSQL instance. There was no API server,
runner, controller, provider, remote GitHub effect or borrowed maintenance database.
SQLx applied actual migrations in owned test databases, with the test connection
supplied only in the test process environment (reduced-assurance environment delivery).

Explicit database execution, independent of the generic ignored-test count:

- `cargo test -p crony-store --offline --locked issue161_ -- --ignored --test-threads=1`: **6 passed**, including the combined authority/cost regression.
- `cargo test -p crony-server --offline --locked issue161_ -- --ignored --test-threads=1`: **3 passed**, including concurrent real handlers producing one held mission.
- `cargo test -p crony-store -p crony-server --offline --locked issue79_ -- --ignored --test-threads=1`: **6 passed** (5 store,1 real-handler), covering invalid cost, immutable history and concurrent reconciliation.

All15 targeted database/handler tests passed with no ignored cases in those targeted
runs. The owned database was stopped through verified ownership and its port checked
closed. Data, test logs and receipts remain retained. No existing authority fixture,
source checkout, runner credential, Project namespace or private draft was changed.

These are actual database/handler regressions, not a fresh multi-host, production
identity, real-provider or browser/server/runner rehearsal. The earlier runtime
report remains historical evidence at its stated source. No wider acceptance is
inferred from this integration. Three original untracked draft/patch files remain
excluded from the commit.

## Final main refresh

During validation, the team merged PR #306 as main
`aa2ef457d86d727232ae353f53a13c8c9f149bf6`. That UI/evidence-only change was then
merged without conflicts. It did not change this candidate's Rust, migrations,
Cargo manifests or lockfile; the15 targeted database results above therefore
exercise the same final backend bytes. All six repository gates were rerun:
**312 frontend tests passed**, **561 Rust passed /352 ignored**, migration42,
format, Clippy, web build and lint passed. The existing authority notice and landed
collaboration/exact-run/freshness paths are both retained. The enclosing final
commit identifies the final source; a fresh reviewer must assess that head.
