# Local browser OAuth and delegated token exchange proof

This isolated, synthetic-only lab demonstrated a real browser sign-in, real
provider-issued tokens, real RFC 8693 exchange, and a bounded flag read on this PC.
It does **not** demonstrate Entra-specific OBO, Azure authorization, Cosmos access,
or resolution of the existing Entra application consent gate. The original Cosmos
harness and all Azure objects are outside this lab and unchanged by it.

## Run

Prerequisites: Node 22.14 or later, Docker Desktop Linux engine, and installed
Microsoft Edge. No host Java installation, Azure CLI, corporate login, tenant
consent, or administrator OAuth credential is used.

Run from this directory in PowerShell:

```powershell
npm ci
npm run setup
npm test
npm start
```

`npm start` runs the three Node listeners in the foreground. In a second terminal:

```powershell
npm run test:live
npm run login
```

Browser URL: **http://127.0.0.1:18881/**.
`npm run login` opens a separate visible Edge profile and fills the randomly
generated synthetic reader credentials without printing them. Close that window
when done. There is no shared MCP browser profile. The live test command uses
headless Edge and four concurrent isolated contexts, closing them afterward.
No screenshots, browser traces, HAR files, token exports, or storage-state exports
are enabled. Browser working directories are explicitly confined to `.private`.

Stop only this lab:

```powershell
.\Stop.ps1
```

This verifies the recorded Node PID, process creation time, command, and lab root
before stopping it, and stops only this compose project's Keycloak service.
It retains the synthetic identities and Docker volume. Restart with
`npm run setup`, then `npm start`. Setup first checks all four ports; it refuses to
run over existing listeners. It does not kill processes to free ports.

For deliberate re-provisioning after modifying the generated realm configuration,
stop the lab first, then use `node setup.mjs --reimport`. This performs an offline
override of **only the synthetic local-obo realm**; it invalidates its old sessions.
Ordinary restarts do not override an existing realm.

## Actual flow and boundaries

| Component | Binding | Trust boundary |
|---|---|---|
| Official Keycloak 26.7.4 | `127.0.0.1:18880` | Local realm and provider signing keys |
| Native interactive client | `127.0.0.1:18881` | Public `interactive` client; code + S256 PKCE |
| Confidential connector | `127.0.0.1:18882` | Accepts only `aud=connector`, `azp=interactive` |
| Flag API | `127.0.0.1:18883` | Accepts only `aud=flag-api`, `azp=connector`; expected reader subject |

The browser receives a state- and nonce-bound authorization request. The native
callback requires an HttpOnly SameSite cookie, consumes a three-minute
single-use transaction, and lets `openid-client` verify the code exchange,
state, nonce, and PKCE. `jose` additionally verifies ID-token and access-token
signatures against provider JWKS, exact issuer, audiences, expiry, and required
claims. The native callback immediately redirects to a clean `/result` URL.
Authorization codes naturally occur in the OAuth callback; they are never
request-logged by this app.

The connector authenticates with its own generated confidential client secret
and sends `grant_type=urn:ietf:params:oauth:grant-type:token-exchange`,
`subject_token_type=urn:ietf:params:oauth:token-type:access_token`, and
`audience=flag-api`. Keycloak standard token exchange **v2**, not deprecated
legacy exchange, is explicitly enabled on the provider and connector client.
The connector validates the new token and checks that its subject equals the
validated incoming subject. This is not bearer forwarding.

The flag API checks the exact **pre-provisioned reader UUID**, not whichever
user signs in first. Both synthetic users can authenticate and exchange tokens;
only that configured reader can read. Writes are denied even to the reader.
The API returns a short synthetic flag only to the connector in memory; the
connector exposes its SHA-256 digest and binding indicators, never the raw flag.

Access tokens last 120 seconds. No password grant, client-credentials grant,
service account, refresh-token fallback, impersonation, or corporate identity is
part of the read path. A negative test deliberately attempts disabled grants
and confirms rejection. Realm import is local bootstrap, not a qualifying read.
Explicit subject mappers are necessary because this minimal realm intentionally
does not inherit Keycloak's default client scopes.

## Evidence from this PC

Latest expanded headless run completed **2026-09-17 01:24 UTC** (September 16, Central daylight time).
`live.evidence.json` is gitignored and contains only status, audience labels,
binding booleans, and a flag hash; no raw subject identifiers or tokens.

| Check | Actual result | Classification |
|---|---|---|
| `npm test` | 5 passed | Unit behavior tests |
| `npm run test:live` | 10 scenarios passed; 11 node:test entries including wrapper | Live parallel browser/provider/API tests |
| Native browser -> connector -> exchange -> flag | 200, matching flag digest and preserved/bound subject | Live end-to-end |
| Connector-audience token directly at flag API | 401 | Live API |
| Flag token sent backwards to connector | 401 | Live API |
| Missing/malformed token on both APIs | 401 | Live API |
| Corrupted provider-token signature | 401 | Live API |
| Valid nonreader token after exchange | 403 from flag API and connector | Live browser/provider/API |
| Reader POST to protected flag route | 403 | Live API |
| Wrong S256 verifier / reused authorization code | 400 `invalid_grant` | Live provider |
| Wrong state / nonce | Rejected | Live browser response, relying-party library rejection |
| Missing transaction on callback | 400 | Live native client |
| Password / client-credentials grants | 400 / 401 `unauthorized_client` | Live provider |
| Token exchange with missing / wrong connector secret | 401 / 401 | Live provider |
| Exchange to unauthorized audience / unknown scope | 400 / 400 | Live provider |
| Exchange requesting a different subject | 400 | Live provider; unsupported v2 impersonation request rejected |
| Token A differs from token B; actor claim | Distinct provider tokens; no `act` claim issued | Live validated token inspection |
| Scoped stop, four ports released, restart, full live suite | Passed | Live lifecycle |
| Phoenix `verify-trace` | `ok=true`, 13 rows, no broken entry | Trace integrity |

TDD/Phoenix history is retained in `.phoenix`: the first sense was **red**
because the new behavior tests referenced an implementation not yet present.
There was **no pre-existing green baseline**. Implementing the behavior made all
five tests green; snapshots were blessed only after that. The first live run
failed, revealing redirect interception behavior and a missing access-token
subject mapper. Both were corrected; the entire live suite then passed under
Phoenix. Unit snapshots do not imply a previously passing live suite.

Repeat objective checks:

```powershell
$env:PHOENIX_WORKSPACE = (Get-Location).Path
$phoenix = 'C:\Users\awiedemann\Workspace\Scout\bin\phoenix-mcp.exe'
& $phoenix sense '{"kind":"command_exit","target":["node","--test","test/security.test.mjs"],"expect":0}'
& $phoenix sense '{"kind":"command_exit","target":["node","--test","--test-concurrency=4","test/live.test.mjs"],"expect":0}'
& $phoenix verify-trace
```

Runtime details are in `.private\server-runtime.json`,
`.private\provider-runtime.json`, and `.private\tool-runtime.json`.
The agent-started process uses a detached PowerShell tool session. Do not stop
Docker Desktop's shared host listener PID; stop the compose service instead.

## Deliberate limitations

**Development HTTP loopback only; not production.** The provider uses start-dev
and its embedded database. Loopback HTTP and non-Secure cookies are acceptable
only for this local synthetic demonstration. No public, wildcard, or IPv6
listener is published. The container internally listens on its own network;
Docker publishes only `127.0.0.1:18880`.

**Same-OS-user execution does not prove credential isolation.** The client,
connector, tests, and operator share an OS account; that account can inspect
their processes and private files, including the connector secret. `.private`
is gitignored and its Windows ACL is restricted to the invoking account, but
this is not a security boundary against that account or host administrators.
Production would need separate process identities, secret storage, HTTPS,
operational hardening, and independent service authorization.

Generated passwords, client secret, synthetic flag, imported identity UUIDs,
and provider data remain local private runtime state. Never copy `.private`,
Docker volumes, or provider tokens into issues or source control.

This provider did not issue an `act` claim. The proof checks issuer, audiences,
authorized parties, and preserved subject; it does not claim an encoded actor
chain. RFC 8693 exchange is not interchangeable with Microsoft's Entra OBO
grant. Workload identity federation would likewise not establish human Cosmos
consent.

Source/version references: [RFC 8693](https://www.rfc-editor.org/rfc/rfc8693.html).
[official downloads](https://www.keycloak.org/downloads) listed 26.7.4 when
checked; [standard token exchange documentation](https://www.keycloak.org/securing-apps/token-exchange)
describes supported v2 and its per-confidential-client enablement.
The exact official image digest pulled is recorded in private runtime metadata.
