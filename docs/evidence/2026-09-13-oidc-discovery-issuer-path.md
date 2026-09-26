# OIDC discovery retains the complete issuer path

Date: September 13, 2026. Scope: isolated authentication compatibility fix and focused local regression evidence.

Base: `b2523964e7576cafc00e84a51e1044f55826dea7`.
Contribution branch: `codex/azure-production-readiness` (uncommitted at this checkpoint).

## Findings and change

`AuthService::initialize` used a relative URL join after trimming an issuer's trailing slash. URL joining treats the final path segment as a file: an issuer ending in `/tenant/v2.0` therefore requested `/tenant/.well-known/openid-configuration`, not the OpenID Connect document appended to the full issuer path. The same defect affected nested issuers such as `/realms/ecorp`.

The fix appends `.well-known` and `openid-configuration` using the existing `url` library's native path-segment API. Existing path bytes, including percent-encoded segments, are retained. The prior query/fragment clearing behavior, trailing-slash normalization, HTTPS enforcement, discovery-issuer comparison, principal mapping, and authorization policy are unchanged.

Harness-first check: reuse the pinned `url` 2.5.8 implementation (through `reqwest::Url`), existing `AuthService`, and existing Axum/Tokio test dependencies. No new dependency, custom authentication system, token persistence, or lockfile change is introduced.

## Validation

Environment: Windows ARM64; cargo 1.98.1 and rustc 1.98.1. The isolated worktree's own `target` directory was used with two compilation jobs. `DATABASE_URL` and `CRONY_ACCESS_TOKEN` were removed from the test command's process environment. Dependencies were resolved offline with the lockfile enforced.

```powershell
cargo test --offline --locked -p crony-server auth::tests -- --test-threads=1
cargo fmt --check
git diff --check
```

| Stage | Result |
| --- | --- |
| New regression tests against original implementation | Expected failure: 5 passed, 2 failed, 124 filtered out |
| Initial formatting check | Two formatting-only differences in the new test code; subsequently corrected |
| Focused tests after fix, including encoded-path case | 8 passed, 0 failed, 0 ignored, 124 filtered out; exit 0 |
| Final `cargo fmt --check` | Exit 0 |
| `git diff --check` | Exit 0 |

Before the fix, both `discovery_preserves_nested_issuer_path` and `discovery_preserves_entra_v2_issuer_path` returned HTTP 404 from the fixture because the request omitted the last issuer segment.

Passing coverage:

- root issuer with and without a trailing slash;
- nested issuer path with and without a trailing slash;
- Entra-shaped tenant plus `v2.0` path, with and without a trailing slash;
- percent-encoded issuer path without double encoding;
- foreign discovery issuer rejection;
- HTTP production issuer rejection when the explicit isolated-test override is absent;
- development initialization without discovery;
- the existing fail-closed role matrix.

Tests use a test-owned loopback listener on an OS-assigned port. A fixture guard aborts the Axum task when dropped, including assertion unwind. HTTP is enabled only through the existing explicit isolated-test override. UserInfo is not called, and no real identity token is used.

## Limits and unchanged authority

This is not a completed Microsoft Entra browser login, tenant-consent test, token-flow security review, production deployment, or browser/server/runner/provider acceptance claim. Full repository validation remains required before committing; only the approved focused checks ran here.

Subsequent checkpoint: the [full repository gate](2026-09-13-azure-readiness-repository-gate.md) passed against this contribution. The original focused-test observations above are retained unchanged; real sign-in and deployment acceptance remain separate.

Related work: [#242 browser authentication](https://github.com/All-The-Vibes/ecorp/issues/242) and [#248 private deployment/recovery](https://github.com/All-The-Vibes/ecorp/issues/248). This narrow compatibility fix does not close either issue or supersede their existing review requirements. Azure Blob compatibility, production browser onboarding, infrastructure readiness, and shared-authority integration remain separate gates.

No Azure resource/provider/app/role changes, factory dispatch, GitHub mutation, deployment, merge, source-checkout update, retained-database operation, or runner-identity replacement is part of this checkpoint. Private subscription inventory and planning notes are under Git-ignored `.azure/`; they must not be included in a public review payload.

## References

- [OpenID Connect Discovery 1.0, Provider Configuration Request](https://openid.net/specs/openid-connect-discovery-1_0.html#ProviderConfigurationRequest).
- [Pinned URL path-segment API](https://docs.rs/url/2.5.8/url/struct.PathSegmentsMut.html).
- [Microsoft identity platform OpenID Connect metadata](https://learn.microsoft.com/en-us/entra/identity-platform/v2-protocols-oidc).
