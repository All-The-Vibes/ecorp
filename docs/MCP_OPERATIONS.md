# Native MCP inspection

ECorp ships `crony-mcp` in `crates/crony-gateways`. It is a stdio adapter over the existing
Corp-scoped server APIs, with no independent task store or execution loop. The root `.mcp.json`
configures its read-only mode for clients that support this configuration format.
Codex uses the project-scoped `.codex/config.toml` instead. It forwards the four explicit host
connection variables and enables `crony_snapshot` and `crony_factory_recovery_context`, with
native startup/tool timeouts.
Both configurations start the same reviewed gateway; they do not contain identities or credentials.

Build the trusted checkout with the repository's pinned Rust toolchain:

```powershell
cargo build --locked --package crony-gateways --bin crony-mcp
```

Configure the client to resolve that trusted binary, or install it into an operator-owned tool
directory using Cargo's native `install --locked --path crates/crony-gateways --bin crony-mcp`
and `--root` option. Do not resolve an unknown executable from the current directory. Rebuild
when the gateway contract changes; an old binary that rejects `--read-only` is not a reason to
remove the mode. Client approval of an MCP server remains distinct from ECorp tenant authority.

Codex loads project configuration only from trusted projects. After installing the native binary
and setting the routing variables, inspect registration with `codex mcp get ecorp --json` and
connection status through Codex's `/mcp` view. Project trust and a registered server are not proof
of an authorized API read; use the explicit probe below to establish that path. See the
[official Codex MCP configuration reference](https://developers.openai.com/codex/mcp/).
For linked Git worktrees, Codex may request trust for the underlying repository root. Follow the
exact project named by Codex's disabled-layer diagnostic; trusting only the linked path may leave
its project configuration disabled. Do not copy another operator's identities or user configuration.

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

Read-only startup rejects `--access-token`, including when `CRONY_ACCESS_TOKEN` is also
supplied. Unrestricted integrations retain their existing command-line compatibility.

The MCP process inherits the environment supplied by its trusted client. It does not discover
credentials, enroll a runner, bootstrap/reset a database, or select a replacement identity.
Read-only startup requires all three routing values explicitly, through these variables or
their corresponding CLI options; it fails before serving initialization if any are missing.
The API address must be an origin without credentials, query parameters or a path prefix.
Both the read-only gateway and probe require HTTPS except for normalized `localhost`,
`127.0.0.1` and `[::1]` origins in an explicitly owned development fixture.

## Read-only behavior

`crony-mcp --read-only` exposes snapshot and Factory recovery-context inspection, and rejects mission-creation and room-message
tools before any HTTP request. The unrestricted CLI behavior remains available for existing
explicitly authorized integrations; the repository inspection configuration does not select it.
Protocol startup and tool listing do not launch agent work.
All gateway API requests reject every redirect, including same-origin redirects, and require
HTTPS outside explicit loopback development origins. Configure the canonical API origin when
a proxy redirects a request. These transport boundaries also apply to unrestricted integrations.

Use `tools/probe_mcp.mjs` with its explicit binary and routing configuration to verify initialization,
the read-only tool list, and an authorized snapshot or selected recovery context. The probe is bounded, reads only the selected
server, and emits whitelisted metadata/counts instead of the private snapshot. A successful probe
proves that stdio-to-API path for the supplied identity, not a provider run or completed mission.
Read-only native HTTP bodies are capped at 16 MiB before JSON decoding; the probe separately caps
serialized stdio output. An oversized Corp snapshot fails inspection rather than returning a
truncated projection or treating omitted objects as absent.

Set `CRONY_MCP_BINARY` to the absolute path of the built gateway, alongside the routing variables
above, then run:

```powershell
node tools/probe_mcp.mjs --timeout-ms 15000 --output output/mcp-inspection.json
```

The output destination must be new. Existing evidence is not overwritten. By default the probe sends
initialization, the initialized notification, tool discovery and `crony_snapshot`; it does not
bootstrap, reset or write to the server. The versioned behavior and acceptance cases are in
[MCP inspection contract v2](specs/mcp-inspection-v2.md).

## Inspect one Factory recovery

Call `crony_factory_recovery_context` with exactly one argument, `work_item_id`, using the
hyphenated UUID of the selected Factory work item. It sends one GET to the existing native
verification-recovery context endpoint. Other arguments, including actor, Corp, recovery mode,
attempt limits and authorization claims, are rejected locally.

The context reports the native work-item version, source run, remaining attempts and mission
budget, retained recovery records, expected workspace/head and checkpoint capabilities. It is
an observation, not authority to recover. The server still requires its existing `Operate`
permission and human-role/room/Corp visibility checks. An unauthorized or hidden item remains
an error; the gateway does not select another identity or treat denial as an unavailable capability.

The tool never checkpoints, revises budgets, reopens a stopped run, resumes a provider or starts
a recovery. Use the existing separately authorized native workflow if a change is requested.
This inspection retains the bounded, no-redirect transport even in an unrestricted gateway;
the three existing tools retain their prior unrestricted behavior.

To probe this path without reading the broad Corp snapshot, provide the selected UUID explicitly:

```powershell
node tools/probe_mcp.mjs --work-item-id $env:CRONY_FACTORY_WORK_ITEM_ID --timeout-ms 15000 --output output/mcp-recovery-inspection.json
```

The environment variable in this example must be set by the operator to that existing work-item
UUID. The probe has no work-item default. Its report contains only IDs, version, counts, remaining
authority and native capability flags; it withholds policies, source paths, fingerprints and raw
failure details. Missing capability fields remain unknown and are never promoted to eligibility.
A successful probe establishes the inspection path only. It does not prove a recovery or provider
run, and mock HTTP tests do not establish real server authorization.

For operational interpretation, the
[ecorp-operations skill](../.github/skills/ecorp-operations/SKILL.md) describes how to correlate
mission, runner, budget, approval and verifier state without substituting an agent completion
claim for accepted evidence.

For a selected run and downloaded artifact checks, use the
[operation observation exporter and online consumer](OPERATION_OBSERVATIONS.md). They reuse this
native read-only snapshot and the server's exact context/download endpoints, while keeping
bounded history, persisted acceptance and future action authority explicit.
