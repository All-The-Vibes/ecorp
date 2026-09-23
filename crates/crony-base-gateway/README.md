# Isolated Base signing gateway

`crony-base-gateway` is a runnable customer gateway, separate from the worker.
It composes the existing `PgStore` read-only `IntentAuthorizer`, an independently
administered `PostgresSigningJournal`, the supported Alloy AWS KMS signer, and
the authenticated Corp-scoped JSON-RPC router. It has no raw signing, local
private-key, deployment, funding, registration, or transaction broadcast endpoint.

With no `ECORP_BASE_GATEWAY_CONFIG`, the executable exits successfully with an
explicit disabled message before reading credentials, opening databases, loading
AWS configuration, or binding a listener. An invalid supplied configuration fails
closed with a nonzero exit code. Errors do not include secret values or file paths.

## Commands

From the workspace root, after customer provisioning:

```powershell
cargo build --locked -p crony-base-gateway
$env:ECORP_BASE_GATEWAY_CONFIG = 'C:\customer\base-gateway\gateway.json'
cargo run --locked -p crony-base-gateway -- --check-config
cargo run --locked -p crony-base-gateway
```

`--check-config` verifies only configuration and the independently pinned manifest
chain. It does not assert database, TLS, KMS, network, or fee-model qualification.
The binary does not automatically load `.env` files. `.env.example` documents the
single application environment setting; secret values are broker-mounted files,
not command arguments or configuration JSON. Relative file paths resolve beside
the configuration file. `gateway.example.json` is deliberately unenrolled and
cannot start until customer-specific values and approvals replace the defaults.

## Required isolation and provisioning

Use one gateway instance per approved manifest destination. Independently provision
the authority/bootstrap pin, latest accepted manifest version/digest, publisher,
immutable KMS key ARN, spending policy, and permitted Corp IDs. The manifest-chain
file cannot supply its own trust root. An old but correctly signed chain fails
against the separately retained latest accepted version/digest.

Mount the application intent database URL, independent journal database URL, and
workload token as separate restricted UTF-8 files, one value per file. Optional
trailing newline is accepted. The token must be at least 32 bytes of externally
generated high-entropy secret material. Protect the files using the host secret
broker and operating-system ACLs; never commit actual credentials.

Both database URLs require `sslmode=verify-full`, explicit database and ASCII role
names, and distinct named external hosts and roles. Use the appropriate trusted
CA configuration for each service. Distinct hostnames do not prove independent
administration: separate operators, backups, and restore controls remain required.
The gateway never runs migrations or installs its journal.

The application role must have the SELECT rights needed by `PgStore`'s authorized
attempt and retained-archive queries, but no table writes, object ownership,
schema CREATE, or administrative roles. The connection always sets
`default_transaction_read_only=on`, a 15-second statement timeout, and a 5-second
lock timeout. The existing intent authorizer remains responsible for exact Corp,
fence, reservation, archive, and frozen-request authorization; it is not duplicated.

Install `..\crony-base\gateway-journal.sql` using an independent administrator.
The journal runtime role needs schema USAGE, SELECT on all three journal tables,
INSERT on `base_gateway_attempts` and `base_gateway_results`, and USAGE on the
cursor sequence. It must not have UPDATE, DELETE, TRUNCATE, TRIGGER, DDL,
ownership, or administrative privileges. Do not grant INSERT on the epoch table.
Provision default privileges and revoke PUBLIC schema CREATE as appropriate.
Runtime startup checks effective role privileges before KMS access, obtains the
persistent journal epoch and complete wallet request snapshot, and rejects an
incomplete or cross-Corp snapshot. It does not fabricate an empty journal.
The journal must retain every possibly outstanding request and result, including
frozen requests without returned signatures; backups must remain independent.

The concrete AWS adapter uses the supported AWS SDK workload credential chain.
Prefer workload identity/role credentials with refresh, not developer profiles or
static environment credentials. Environment-only credential delivery is reduced
assurance and is not evidence of production secret-broker isolation. Grant only
the required `kms:DescribeKey`, `kms:GetPublicKey`, and `kms:Sign` access to the
configured immutable key ARN. The key must be enabled, AWS-origin,
`ECC_SECG_P256K1`, `SIGN_VERIFY`; the recovered address must match the configured
publisher. Imported/exportable key and local-key signing fallbacks do not exist.
The application worker must never receive this KMS permission.

Only commercial AWS regions and immutable UUID key ARNs are supported by this
host. KMS requests use the official regional HTTPS endpoint, not an endpoint
override from application requests. GovCloud, other partitions, and custom KMS
endpoint routing require separate qualification and implementation.

The HTTP listener is deliberately restricted to explicit nonzero loopback ports.
Run an authenticated TLS ingress in the same network namespace, verify its
workload/client access policy, and preserve the gateway bearer credential.
`tls_ingress_confirmed` is an administrator acknowledgment, not a generated TLS
proof. Never publish the plaintext port. The router checks the credential and
Corp scope on every request. Supported methods are `ecorp_gatewayIdentity`,
`ecorp_journalSnapshot`, `ecorp_signAttempt`, and `ecorp_lookupAttempt`.

## Local evidence and boundaries

```powershell
cargo test --locked -p crony-base-gateway
cargo clippy --locked -p crony-base-gateway --all-targets -- -D warnings
```

The opt-in PostgreSQL role qualification regression uses SQLx's isolated test
database and short-lived synthetic roles; run only against an explicitly owned
fixture with role-creation privileges:

```powershell
cargo test --locked -p crony-base-gateway --lib -- --ignored --test-threads=1
```

No tests invoke production KMS or public Base RPC. Compilation and local tests
are not evidence of customer IAM, TLS ingress, provider independence, actual
fee-model activation, or cross-system restore safety.

The `aws-config`/STS versions and Smithy query/XML cohort are pinned alongside the
existing KMS-compatible runtime in `Cargo.lock`; newer nominally compatible
Smithy releases changed document types and fail this SDK's compilation.
