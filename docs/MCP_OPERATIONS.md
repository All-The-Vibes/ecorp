# Native MCP inspection

ECorp ships `crony-mcp` in `crates/crony-gateways`. It is a stdio adapter over the existing
Corp-scoped server APIs, with no independent task store or execution loop. The root `.mcp.json`
configures its read-only mode for clients that support this configuration format.

Build the trusted checkout with the repository's pinned Rust toolchain:

```powershell
cargo build --locked --package crony-gateways --bin crony-mcp
```

Configure the client to resolve that trusted binary, or install it into an operator-owned tool
directory using Cargo's native `install --locked --path crates/crony-gateways --bin crony-mcp`
and `--root` option. Do not resolve an unknown executable from the current directory. Rebuild
when the gateway contract changes; an old binary that rejects `--read-only` is not a reason to
remove the mode. Client approval of an MCP server remains distinct from ECorp tenant authority.

## Connection authority

Supply these variables through the trusted host/client environment before starting the gateway:

| Variable | Meaning |
| --- | --- |
| `CRONY_SERVER_HTTP` | The exact ECorp server selected by the operator; use HTTPS outside an explicitly approved loopback development fixture |
| `CRONY_CORP_ID` | The selected Corp UUID |
| `CRONY_ACTOR_ID` | The authenticated actor UUID in that Corp |
| `CRONY_ACCESS_TOKEN` | The scoped, expiring access token required by a production server |

Do not commit token values, pass them on command lines, put them in an agent-readable `.env`
file, or print them in diagnostics. Environment-only token delivery is reduced assurance and
does not establish operating-system isolation. The server still validates identity, membership,
roles and object visibility. Development authentication is only appropriate for an explicitly
owned local fixture and is not evidence of production authentication.

The MCP process inherits the environment supplied by its trusted client. It does not discover
credentials, enroll a runner, bootstrap/reset a database, or select a replacement identity.
Read-only startup requires all three routing values explicitly, through these variables or
their corresponding CLI options; it fails before serving initialization if any are missing.
The API address must be an origin without credentials, query parameters or a path prefix.
Both the read-only gateway and probe require HTTPS except for normalized `localhost`,
`127.0.0.1` and `[::1]` origins in an explicitly owned development fixture.

## Read-only behavior

`crony-mcp --read-only` exposes `crony_snapshot` and rejects mission-creation and room-message
tools before any HTTP request. The unrestricted CLI behavior remains available for existing
explicitly authorized integrations; the repository inspection configuration does not select it.
Protocol startup and tool listing do not launch agent work.
Read-only API requests reject every redirect, including same-origin redirects, so inspection
cannot silently move to a different endpoint. Configure the canonical API origin when a proxy
redirects a request. Existing unrestricted integrations retain their prior transport behavior.

Use `tools/probe_mcp.mjs` with its explicit binary and routing options to verify initialization,
the read-only tool list, and an authorized snapshot. The probe is bounded, reads only the selected
server, and emits whitelisted metadata/counts instead of the private snapshot. A successful probe
proves that stdio-to-API path for the supplied identity, not a provider run or completed mission.

Set `CRONY_MCP_BINARY` to the absolute path of the built gateway, alongside the routing variables
above, then run:

```powershell
node tools/probe_mcp.mjs --timeout-ms 15000 --output output/mcp-inspection.json
```

The output destination must be new. Existing evidence is not overwritten. The probe sends only
initialization, the initialized notification, tool discovery and `crony_snapshot`; it does not
bootstrap, reset or write to the server. The versioned behavior and acceptance cases are in
[MCP inspection contract v1](specs/mcp-inspection-v1.md).

For operational interpretation, the
[ecorp-operations skill](../.github/skills/ecorp-operations/SKILL.md) describes how to correlate
mission, runner, budget, approval and verifier state without substituting an agent completion
claim for accepted evidence.
