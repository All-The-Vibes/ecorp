# Searchable history performance and logging corrections

PR #385, issue #258. Parent: c54e25b08276d29a7c6d514fcef593fb06e57fec. Current main: 878a1774774b0630c904cbaf4b05e1b346777817.
Tested implementation tree: fa70e7e55de26784898ce7e04b8304b118659b2a.

All eleven canonical pnpm check gates passed on the same complete physical source
as performance native r1: 7,282 files, SHA-256 bd30f819414dbde496c148c50f43c6ed231215e560b22ac8c5958b77703751e1.
Node: 3,165 total / 3,100 passed / 65 skipped / zero failed, cancelled or todo.
Rust workspace: {"failed": 0, "ignored": 577, "passed": 882, "summaries": 41}. Native EVM passed its separate gate.
Six source snapshots bind locked install/build/lint, canonical r1 and native r1.
The final commit did not exist during execution. Evidence was added afterward and
validated separately for unchanged tested bytes, Git tree, gate plan and discovery.

Unexpected history failures now emit a static category while preserving the safe
503 response. The logging regression verifies that client errors emit nothing and
that diagnostic canaries never reach the captured log or response.

Event visibility is inlined. Separate journal-sequence and exact-ID paths authorize
each candidate before the page limit; the returned page resolves causal records by
their exact IDs with current Corp/room visibility. Event payloads remain excluded.
The owned PostgreSQL history suite passed 13 tests. Its separately run prepared-plan
test passed across eight scenarios over 20,000 synthetic journal events. Both custom
and generic plans examined 78 event rows for first, deep-cursor and scoped pages
(26 returned including lookahead), and 2 for an exact old record (1 returned).
Sparse filters may still examine more candidates; these are measured fixture results,
not a universal constant-work promise. Focused counts overlap and are not additive.

Native acceptance passed 18 checkpoints through a real browser, server, PostgreSQL
and native fake-process runner, including protected paginated history, exact selection,
current authorization denial, disconnect survival and persisted verification evidence.
Six original captures and their inspection receipt are included. Scripted development
Bob decisions are fixture behavior, never independent human approval.

Both earlier evidence packets remain unchanged: 59 original files and 57 first-review
correction files. Their chronology and qualifications remain history. The PR headline
is prepared to reference this packet; the separate publication receipt verifies the
actual pushed head, updated description and responses to the three new review comments.

Hosted CI, CodeQL, quality and security remain required while organization Actions is
disabled. This packet is local validation and assistant self-review, not independent
approval, merge or issue completion. Historical Cargo advisory debt is not a clean
audit. Full qualifications are in summary.json. Private fixture credentials and
preparation logs are excluded. Each copied artifact records original/published SHA-256
and sanitization treatment. Focused receipts retain hashes of the full private originals
and prove both complete 7,282-file inventories equal source-equivalence.json.
