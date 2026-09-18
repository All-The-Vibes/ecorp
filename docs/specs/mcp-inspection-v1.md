# MCP inspection contract v1

Status: implemented in the native `crony-mcp` gateway; validation scope is recorded separately.
Wire protocol: MCP `2025-06-18` over newline-delimited JSON-RPC 2.0 on stdio.

## Authority and capability

The process is configured for one server, Corp UUID and actor UUID. The server's existing
authentication and object authorization remain authoritative. An access token comes from the
trusted host environment; it is not a tool argument or an agent-readable configuration value.
Environment delivery retains reduced assurance.

Read-only startup requires explicit server, Corp and actor routing before accepting protocol
requests. The server must be an HTTP(S) origin without embedded credentials, query parameters
or path prefixes; HTTP is permitted only for normalized `localhost`, `127.0.0.1` and `[::1]`
development origins. No read-only routing value falls back to a default or replacement identity.

`--read-only` narrows the gateway's capability surface before any API request:

- `tools/list` advertises `crony_snapshot` only.
- `tools/call` for every other name fails locally, including known write tools.
- `crony_snapshot` performs one authorized GET to the configured Corp snapshot endpoint.
- The snapshot cannot select another actor or Corp through tool arguments.
- Redirect responses are rejected without following their location, even within the same origin.

Existing integrations that do not select read-only mode retain their current three-tool
catalog. The repository's inspection configuration explicitly selects read-only mode.

## Protocol behavior

Requests with IDs receive matching JSON-RPC responses. An explicit null ID remains a request.
The gateway treats every JSON object with an omitted ID as a notification, including malformed
objects, and produces no response or tool effect for them. Non-object frames and invalid
JSON-RPC versions on requests are rejected. Initialization and ping do not contact the server.

The client probe validates the negotiated protocol and the exact read-only catalog before
requesting a snapshot. A successful transport without an authorized snapshot is not a passing
inspection probe.

The read-only native transport accepts at most 16 MiB of HTTP body bytes before decoding JSON.
It rejects oversized declared lengths immediately and counts streamed/chunked bytes as they arrive,
including non-success responses. A response at the limit can still exceed the probe's separately
bounded serialized stdio envelope. This limit narrows inspection only; unrestricted integrations
retain their existing transport behavior.

## Probe boundary

The probe requires an absolute, trusted binary path and explicit server/Corp/actor routing.
It does not discover credentials or create a missing environment. It limits elapsed time and
response bytes, closes its owned child process, and withholds raw server/gateway error bodies.
Its evidence contains only whitelisted protocol/scope metadata and collection counts from the
returned snapshot. Counts are observations of that projection, not total database inventories.

An output path is create-only. This contract does not authorize publishing the snapshot or
evidence outside the requesting user's scope, nor does it establish production identity,
OS isolation, a provider run, or accepted mission completion.

## Required acceptance

1. Initialization, notification and read-only discovery work through the actual compiled binary.
2. A configured authorized snapshot call reaches exactly the selected GET endpoint.
3. Both known write tools and unknown tool names are rejected before HTTP in read-only mode.
4. Notifications remain silent and effect-free; request IDs and protocol errors remain correlated.
5. Authentication/API failures disclose no private response content in probe output.
6. A stalled peer triggers the bounded timeout and owned-process shutdown path.
7. A probe of an existing real ECorp server preserves state and records its actual assurance scope.
8. Oversized declared and streamed HTTP bodies are rejected before JSON decoding, with no raw
   response content in diagnostics; the exact native byte limit and unrestricted compatibility pass.
9. A redirect cannot reach a second origin or produce a successful probe; unrestricted transport
   compatibility remains intact.
10. Missing read-only routing fails at startup without HTTP; the legacy unrestricted server
   default remains unchanged.

Source tests live beside the gateway and in `tools/probe_mcp.test.mjs`. The live probe is
`tools/probe_mcp.mjs`; the setup procedure is [MCP operations](../MCP_OPERATIONS.md).
