# Human-delegated protected resource jobs (#285)

## Implemented boundary

The ECorp panel creates a real mission and one `delegated-resource` task through
existing store admission, mission staffing, scheduler, source worktree, runner
assignment, artifact upload and persisted verifier policies. This is a bounded
native read worker, not an LLM pretending that authentication succeeded. It
does not execute a shell command on the server or give a provider credential to
an agent. The runner's existing `waiting_for_input` status represents the wait.

When the assigned operation appears, the job-creation gesture's reserved
browser window automatically navigates to a one-use server ticket. Browser
blocking has an explicit Resume sign-in fallback. The human performs login.
PKCE/state/nonce transactions survive server process restarts in Postgres;
state and cookie hashes are single-use, and PKCE material is encrypted.
Production identity must already be linked to the exact human actor in
`delegated_identities`; a callback cannot establish its own identity binding.
For Entra this separate link uses the tenant's stable `oid`. Normal ECorp login
continues to use the issuer and pairwise `sub` in `human_identities`.

The provider validates signed JWTs using bounded, issuer-pinned JWKS requests.
Initial public-client **authorization code + PKCE is not OBO**. The Entra adapter
then actually submits a separate middle-tier OBO exchange using the confidential
broker client, JWT bearer grant, and `requested_token_use=on_behalf_of`. Keycloak
uses its separate RFC 8693 exchange contract. Neither adapter falls back to the
other. Offline tests run the actual adapter against local signed-token HTTP
fixtures; they do not establish Azure qualification.

Only the trusted server retains the short-lived downstream token, encrypted by
the existing `SecretCipher` implementation. Every protected read rechecks Corp,
human identity and room membership, task, run, enrolled runner, connection epoch,
assignment token, adapter/tool, expiry, and live non-terminal task authority.
The target URL is server-configured, not supplied by the runner or prompt.
Browser admission, code redemption, token exchange, protected reads and receipt
release all revalidate the original assignment and lock current authority through
their bounded effects. Cancellation and revocation serialize with those effects.
Stored tokens are erased after the read, cancellation, or expiry. A server-owned
five-second sweep handles abandoned operations and scrubs expired, consumed or
superseded browser material in batches of at most 128 records per statement,
without requiring a browser, runner or API poll.

The supported connector performs one bounded GET of `{ "flag": "<value>" }`.
An independently configured SHA-256 expectation verifies the actual response.
The raw value never leaves the broker. A digest-only private preview is visible
only to the exact requesting human. **Release private receipt** is a separate,
explicit human decision; neither login nor an assistant action implicitly
releases it. The original runner continues polling, receives only the released
receipt, writes `delegated-result.json`, and passes the existing artifact and JSON
verifier before the original task/run/mission can complete. Private operation
state and decision history are separate from shared snapshots and prompts.

No suitable generic delegated browser/OBO connector exists in the current native
harness. The addition is a trusted adapter, not a replacement session, scheduler,
permission, workspace, artifact, or verifier implementation. An ordinary task
cannot select this adapter to obtain another task's delegation.

## Configuration

The displayed production default is **Entra**, disabled without explicit
configuration. No configuration automatically selects Keycloak.
Set server-only environment variables (never runner or web environment):

| Variable suffix (`CRONY_DELEGATED_`) | Meaning |
| --- | --- |
| `PROVIDER` | `entra`, explicit `keycloak-test`, or `disabled` |
| `TENANT_ID` | Entra tenant GUID; not used by Keycloak |
| `ISSUER` | Keycloak-only explicit loopback realm issuer |
| `INTERACTIVE_CLIENT_ID` | Public PKCE application |
| `BROKER_CLIENT_ID` | Confidential middle-tier application |
| `BROKER_CLIENT_SECRET` | Server-only credential, never logged |
| `REDIRECT_URI` | Exact registered `/api/delegated/callback` URL |
| `INITIAL_SCOPES` | Space-separated `openid` and broker API delegated scope |
| `DOWNSTREAM_SCOPE` | Explicit downstream delegated scope |
| `DOWNSTREAM_AUDIENCE` | Expected downstream token audience |
| `RESOURCE_URL` | Fixed bounded protected GET endpoint |
| `EXPECTED_SHA256` | Independently obtained expected resource digest |
| `BROWSER_BASE` | External API origin |
| `UI_URL` | UI root to return to after callback |

Entra requires HTTPS. Explicit development loopback is allowed only locally.
Keycloak is rejected in production mode. Use the existing
`CRONY_SECRET_MASTER_KEY_HEX` production key policy; do not rotate an existing key
without migrating existing encrypted records. Tokens cannot be decoded by the
runner. Ordinary environment-delivered provider client configuration retains the
existing trusted-process/reduced-assurance limitation.

Before allowing an Entra job, an administrator must independently verify the
Corp, existing human actor, exact tenant issuer and that human's stable Entra
object ID, then provision `(corp_id, actor_id, issuer, subject)` in
`delegated_identities` through the deployment's privileged database migration or
identity provisioning process. `subject` is that verified `oid`; do not copy the
login application's pairwise `sub`, use an email address, or infer the mapping
from an incoming callback. Uniqueness prevents one provider identity from mapping
to multiple actors in the same Corp. Removing or changing the mapping revokes
existing delegated authority. The development-only `/api/demo/delegated-link`
route admits only the explicitly configured Keycloak test issuer, preserves login
identity rows, and accepts repeat provisioning only for an identical mapping.
This route is absent in production.

Migration `0055_delegated_authority.sql` keeps existing operation and audit
history but fails unfinished operations that predate the distinct identity and
original runner binding. It erases their bearer material and consumes prior
browser transactions. After independently provisioning the new mapping, start a
new job; an old operation cannot acquire authority by being migrated. Provider
configuration and discovery are validated before database connection, migrations,
artifact activation or recovery effects.

## Local fixture and restart

`tools\fixtures\delegated-keycloak` preserves the official Keycloak 26.7.4 fixture
source and pinned npm lock, without credentials, realm data, volumes, browser
storage, tokens, or prior evidence. Its original standalone checks are not ECorp
acceptance. The integrated harness defaults to this checked-in fixture. To retain an existing
private lab, set `ECORP_DELEGATED_LAB` to its absolute path (or pass `-LabPath`
to the PowerShell launcher). No private state is copied into source control.

After building `crony-server` and `crony-runner`, run:

```powershell
.\tools\delegated_local.ps1 -PrepareProvider
# For an explicitly requested restart:
.\tools\delegated_local.ps1 -Restart
```

For a fresh checkout, first follow `tools\fixtures\delegated-keycloak\README.md`
(`npm ci`, `npm run setup`, then `npm start` in its own foreground terminal).
Keep the provider's private files and Docker volume local. Provision the isolated
Postgres service in another PowerShell terminal:

```powershell
$env:ECORP_DELEGATED_POSTGRES_PASSWORD = [Convert]::ToHexString(
    [Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
# Retain this value in your private local secret storage; never print or commit it.
docker compose -f tools\fixtures\delegated-postgres.compose.yml up -d
cargo build -p crony-server -p crony-runner
# Keep the password environment value in this terminal for compose resolution.
.\tools\delegated_local.ps1 -PrepareProvider
```

Do not regenerate that password for an existing database volume. The launcher
prefers an existing private `output\obo-postgres.compose.yml` when present;
`-DatabaseComposePath` selects an explicit configuration. Do not start a second
fixture over occupied ports or reuse another project's data volume.

The retained September 17 stack instead uses:

```powershell
$env:ECORP_DELEGATED_LAB = (Resolve-Path ..\ecorp-identity-lab\local-obo).Path
# Only when deliberately restarting the owned demo:
.\tools\delegated_local.ps1 -Restart
```

The first command adds only the ECorp callback to the existing private realm
configuration, preserving a private backup before scoped provider reimport.
It does not provision Azure. It preserves the fixture's standalone redirect,
its identities and resource. API/UI are 8791/5187; the isolated database remains
on 54330; fixture bindings remain loopback 18880–18883. Startup uses the existing
owned-process lifecycle and `output\local-pids.json`; factory execution is off.
The script passes delegated configuration only to the server and clears it from
the launching process. Its randomly generated local cipher key is protected by
the current Windows user's ACL in `output\delegated-private`.

The local human credential is privately available in the selected lab's
`.private\config.json`, fields
`reader.username` and `reader.password`. Do not paste credentials into chat,
mission text, tool arguments or logs.

## Validation and remaining qualification

Migration checksums cover exact bytes. Keep SQL files LF-only as required by
`.gitattributes`, including newly created files on Windows, before recording
manifest hashes or running SQLx. The manifest for migrations 42/43 uses their
committed LF bytes; earlier local CRLF hashes were not portable to CI. Do not
rewrite an existing database's SQLx history to compensate. A disposable local
fixture initialized with CRLF migration bytes needs a separately owned fresh
database for LF-source validation; preserve the original demo and its evidence.

```powershell
cargo test -p crony-server
cargo test -p crony-runner delegated
cargo fmt --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
node --test apps\web\src\DelegatedPanel.test.mjs
corepack pnpm build:web
corepack pnpm lint:web
node tools\check_migrations.mjs
# Optional SQLx-owned disposable DB regression (never use the application DB):
# Set DATABASE_URL privately to the owned maintenance database, then:
cargo test -p crony-server delegated -- --ignored --test-threads=1
# First start a fresh owned native fixture with tools/qa_delegated.ps1.
# Supply the pinned Keycloak 26.7.4 directory, Java 21, PostgreSQL tools,
# matching-source server/runner binaries, Node and Playwright directories.
$env:ECORP_DELEGATED_QA_ROOT='C:\qa\delegated-keycloak-acceptance'
$env:ECORP_SYNTHETIC_OBO_TEST='1'
node --test tools\e2e_delegated.mjs
```

The synthetic integrated lane uses a separate headless Edge session and explicitly
synthetic accounts, exercises real ECorp jobs, and records only non-secret
evidence under the fixture's `evidence` directory. `tools/qa_delegated.ps1`
copies the provider and lab into a new private QA root, creates an independent
source repository and SCRAM database, and records exact process identities.
`-Phase Stop -QaRoot <root>` stops only those owned processes and retains all
data. The driver verifies every process, listener and database before HTTP or
private configuration access and again before every test-admin SQL statement.
The database probe captures original assignment scope in memory, never command
arguments or evidence. The browser lane covers start, login, private preview,
release, original-run completion and cancellation with a delayed authorization
response. It does not substitute for the requested human login.

**Live Azure / Entra: NOT_EXECUTED.** No Azure SQL, Cosmos DB, Graph connector or
Azure resource was provisioned or live-qualified. This change implements the
configured bounded protected-resource connector, not arbitrary data access.
The local app uses development principals; it is not proof of production ECorp
OIDC authentication or OS isolation. Server/runner reconnection during an active
credential exchange has not been live-qualified. The persistent transaction and
credential representation alone is not evidence of reconnect acceptance.

The September 17 user reported a successful browser demonstration. Independent
readback confirms a later replacement job completed with explicit release and
a verified, hash-matched receipt; the earlier supplied task expired unreleased.
Exact lineage, failure preservation, and the distinction between the running
migration-42 stack and migration-43 source are recorded in
`docs\evidence\2026-09-17-delegated-285.md`. This does not qualify live Entra.

To repeat the human path, open `http://127.0.0.1:5187`, select the canonical
mission room as Alice, and create a protected-resource job in the delegated
panel. The human signs into the separate provider window, returns to ECorp,
inspects the private digest, and chooses **Release private receipt**. Verify the
same task's original run reports completed/passed; download its artifact through
the authenticated API and compare SHA-256 and exact operation/task/run IDs.
Do not count a new replacement task as completion of an earlier failed task.
Room mismatch now rolls back mission, task, staffing, events and delegation
together instead of retaining an orphan. The SQLx regression tests this against
all 43 migrations; it is not evidence of a post-cleanup live-stack restart.

No remote
communication, PR publication, consent click, or human receipt release is
authorized as an incidental implementation step.
