# OIDC issuer-path completion

Date: September 26, 2026. Issue #270.

OIDC discovery previously resolved `.well-known/openid-configuration` as a
relative URL. An issuer ending in `/tenant/v2.0` therefore lost its final path
segment. The correction appends the discovery segments with the pinned URL
library's native `path_segments_mut` API. It preserves encoded path segments and
the existing query/fragment removal, HTTPS requirement, issuer comparison,
principal binding and authorization behavior. No custom authentication or
permission mechanism is introduced.

The original contribution was recovered from issue comment `5705559640` and the
preserved Azure readiness contribution. The two September 13 evidence reports in
this change retain their original bytes, dates and limitations. They do not
describe the new regression or acceptance runs below.

On September 26, the focused regression initially produced six passes and three
failures on the previous implementation. The completed focused suite passed all
ten tests, covering root and trailing-slash issuers, nested paths, Entra v2 paths,
percent encoding, issuer mismatch, production HTTPS enforcement, development
initialization and query/fragment removal. Existing role and spending guards
remain covered. Test servers use ephemeral loopback ports and abort on fixture
drop.

An owned browser/server/native-runner/PostgreSQL stack passed with an HTTPS
issuer at `/tenant/v2.0`. It observed the complete discovery path, authenticated
the browser, created and ran a mission, persisted verifier evidence and artifact
bytes, and read matching state after server/runner restart. Missing/invalid
bearers were rejected with 401; principal mismatch, an unlinked subject, guest
mutation and requester self-review were rejected with 403. An independently
scoped synthetic member supplied the fixture's review decision. This is test
data, not a human approval. Source and artifact readbacks agreed; owned services
were stopped.

These are synthetic identities, a deterministic fake-process provider and an
owned HTTPS artifact fixture. SQLx and artifact/master-key delivery through the
environment is reduced assurance. No real Entra sign-in, cloud credentials,
AWS signature validation, production deployment, onboarding or human decision
is claimed. Broader provider/onboarding/deployment issues retain their separate
acceptance requirements.

The first complete canonical `pnpm check` passed all eleven named gates on base
`bdde15b25ac80139834549656e8e90f95b8d4547` with this correction: Node 3,023 passed
and 65 skipped; Rust 829 passed and 550 ignored; the separate EVM gate passed one
test; no failures. The source was stable during that run. The branch was then
fast-forwarded to main `08ed24829e033a39a8913d52be6a136eac1cc2aa`, preserving the
correction and both historical report hashes. A second complete canonical run
on this current-main candidate passed all eleven gates on September 26 at
15:20 UTC, with the same 3,023 Node passes / 65 skips, 829 Rust passes / 550
ignored cases and one separate EVM pass, zero failures and stable source.

The adjacent [completion packet](2026-09-26-oidc-discovery-completion/README.md)
publishes the source-bound receipts, logs, actual browser screenshots, driver
snapshots and retained failed attempts. The packet, scoped byte-preservation
attributes and this updated narrative were added after the canonical run.
Publication checks separately verify unchanged application code and the complete
named plan/full Node discovery inventory, then validate the added documentation
and scan its artifacts. Exact final-head hosted checks remain required before
merge; the linked PR and private run record retain the final source and receipts.

The private run record is `output/issue-completion/20260926T112626Z`, including
`issue270-red-r1.json`, `issue270-green-r2.json`, `issue270-native-stack-r6.json`,
`issue270-canonical-r2.json`, `issue270-canonical-r3.json` and
`issue270-current-main-r1.json`. Its native stack
record binds the executed binaries, drivers, source files, phases and cleanup;
it distinguishes the synthetic mission repository from the ECorp source.
