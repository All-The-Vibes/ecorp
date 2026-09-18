# MCP inspection contract v2

This additive contract extends [v1](mcp-inspection-v1.md). The wire protocol remains MCP
`2025-06-18` over newline-delimited JSON-RPC 2.0. Native identity, routing, notification,
credential, byte-limit and process boundaries remain unchanged. Validation at the actual
server boundary must be reported separately from compiled-gateway tests with a mock API.

## Read-only tools

`--read-only` advertises `crony_snapshot` and `crony_factory_recovery_context`. Every other
tool name, including both existing write tools, fails before HTTP. The unrestricted catalog
adds this inspection tool while preserving the three previous tools' behavior.

`crony_factory_recovery_context` accepts an object containing exactly one `work_item_id`:
a 36-character hyphenated UUID. Uppercase hexadecimal is accepted and routed canonically.
Missing, malformed, non-string, non-object and extra arguments fail locally.

The tool performs exactly one GET to
`/api/corps/{configured_corp}/factory/work-items/{work_item_id}/verification-recoveries`
with the configured actor's consistency claim and existing bearer authentication. It cannot
select a different server, Corp, actor or method. The server's existing `Operate` permission,
human-role and room/Corp visibility checks remain authoritative. Errors remain errors.

The returned work-item and Corp UUIDs must match the requested scope. No recovery eligibility
is recomputed in the gateway. The raw response remains within the requesting user's authorized
context. No checkpoint, budget revision, resume, retry, publication or approval is performed.

This tool uses the existing origin validation, no-redirect policy and 16 MiB HTTP body bound in
both gateway modes. Unrestricted legacy tools retain their existing transport compatibility.

## Probe

The probe validates the exact two-tool read-only catalog and read-only annotations. Its default
snapshot inspection remains available. `--work-item-id UUID` instead selects one recovery-context
read; it does not first request the broad snapshot. Unknown command-line options fail.

The report includes only the selected native IDs/version, recovery count, remaining attempts
and budgets, and returned checkpoint capability flags. Missing flags are unknown. It excludes
policy contents, workspace/source paths, fingerprints, failure details and credentials. Native
IDs and the selected Corp/item/mission relationship are validated before producing the report.
Raw API/gateway error bodies remain withheld. Output files remain create-only.

## Acceptance

- Actual compiled stdio discovery and the selected GET work in both gateway modes.
- Invalid UUIDs and extra scope/effect arguments make no HTTP request.
- The returned Corp/work-item mismatch is rejected without exposing the mismatched context.
- Known writes and unknown tools remain unavailable in read-only mode; notifications remain
  silent and effect-free, and protocol request correlation remains intact.
- Authentication, authorization and hidden-item errors remain failures. Probe diagnostics omit
  private bodies; recovery reports omit private context fields.
- Redirects and oversized declared/streamed bodies remain rejected by the bounded inspection
  transport. Existing snapshot/unrestricted compatibility and timeout/cleanup tests still pass.
- An explicitly owned real QA stack verifies the current API authorization and native context
  for eligible, exhausted/hard-stop and foreign-room cases, with no new runs or commands after
  inspection. This is a separate gate from mock API validation and requires no provider inference.

Tests are in `crates/crony-gateways/src/lib.rs` and `tools/probe_mcp.test.mjs`.
The probe and setup instructions are in [MCP operations](../MCP_OPERATIONS.md).
