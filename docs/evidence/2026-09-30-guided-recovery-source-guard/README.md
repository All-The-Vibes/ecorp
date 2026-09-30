# Guided recovery source guard correction

Issue #262, PR #389. This packet resolves review comments 4146642007, 4146642079,
4146642119 and 4146642183 on the original capture/publication helpers.
Main: 878a1774774b0630c904cbaf4b05e1b346777817. Validated product head: 97b141ed47b16aa9682f88a6378c60c86487ec35. Tested tree: 8022064f34762e4f1828bc9d7cb2da6af6a8de88.

The earlier helpers checked resolved containment and the final symlink only. They
could accept a hard-linked file or a path through an aliased parent. Fresh capture
and publication now use the same native guard: declared paths must be canonical,
lexical ancestors must not be symlinks or reparse points, and files must be regular
with a link count of one. Streamed hashes also check the opened file's native
identity before and after reading. The adapter reuses the repository's existing
evidence reader.

All 22 native guard regressions passed, including real NTFS hard links and parent
junctions, ordinary files, source larger than 8 MiB, changed bytes and a mutation
during hashing. The first guard attempt rejected an ordinary file because native
lstat/fstat ctime values differed. Its failure and diagnosis are retained; the
successful guard uses the same portable identity fields as the existing reader.
No product validation ran with the failed guard.

Native R11 then stopped before browser acceptance because its copied Codex fixture
helper still required the old QA-root name. Its source equality and owned shutdown
passed. The failed attempt is retained; R12 uses the corrected explicit path
pattern and a fresh owned stack.

Fresh focused regressions: 39 passed, zero failed or skipped.
All eleven canonical pnpm check gates passed.
Node: 3142 total / 3077 passed / 65 skipped /
0 failed. Rust: 879 passed / 564 ignored /
0 failed across 41 summaries, using one test thread.
The native EVM gate remains separate. Model coverage: 502 passed; 99.69% lines,
97.58% functions and 97.12% branches against unchanged 99/95/97 thresholds.
These counts overlap and are not additive.

The fresh owned browser/server/PostgreSQL/runner stack passed 15 top-level acceptance
groups and retained 19 original screenshots. It re-exercised guided revision,
immutable request replay, stale reconciliation, explicit launch, native protocol
resume, persisted verification, authority restrictions and budget restrictions.
Provider execution and Codex protocol responses are deterministic fixtures;
seven recovery presentation cases and browser-storage variants are explicitly
synthetic. Zero actual human reviews occurred. Owned services stopped successfully.

Every validation boundary observed the same 7,304 physical source files:
cff87be69660700f2c966a5c19ded9e8b377f4c1ef36ecc3ae3aee2d28d32fb0. The committed product head existed before the tests. This final
evidence-only commit is added afterward, with source checks again at assembly,
evidence validation and commit. Publication inputs and new packet files also
require canonical single-link paths. The complete named check plan and full Node
discovery are unchanged; documentation and privacy/security checks run afterward.

The [original packet](../2026-09-30-guided-contract-recovery/README.md) and
[warning-correction packet](../2026-09-30-guided-recovery-warning-correction/README.md)
remain unchanged as history. This packet supersedes their incomplete source-alias
assurance for readiness. It does not attest historical filesystem metadata or
continuous operating-system locking.

Artifact hashes bind original and published bytes. Personal paths and discovered
credential strings are redacted; synthetic idempotency identifiers use stable
aliases. Screenshots retain original bytes. Published driver copies have redacted
local paths; configure explicit owned paths before reproducing them. Run Python
with bytecode caching disabled to preserve the source inventory.

GitHub Actions remains disabled. Required hosted CI, CodeQL, quality and security
checks remain mandatory. No merge, issue completion, independent approval or clean
historical Cargo advisory audit is claimed. Actual Node: 24.21.0; the repository
declares 24.19.0, so execution on that declared runtime is not claimed.

Qualifications:
- This is newly observed validation and assistant implementation self-review. It is not original development chronology, independent GitHub approval or a human decision.
- Both historical packets remain byte-for-byte intact. Their old capture/publication predicates did not attest canonical declared paths or single-link source. Fresh validation supersedes that assurance gap; it cannot establish past filesystem metadata.
- Source guard R2 is a thin adapter over the existing repository verify_public.py directory_root, unlinked_path and regular_file guards. It adds streamed hashing and opened-file identity checks, not a new execution or permission system.
- The first native guard attempt rejected an ordinary file because this Windows/Python runtime returned different lstat/fstat ctime_ns. That failed attempt is preserved. R2 uses the existing reader's portable device, inode, size, mtime_ns and link-count identity fields; all 22 fresh native guard cases passed.
- Native R11 stopped before browser acceptance because its copied fixture helper rejected the new QA-root name. Source equality and owned shutdown passed. Its failure is retained; R12 uses a fresh owned stack and the corrected explicit path pattern.
- Alias checks establish observed metadata and bytes at capture and publication boundaries. They do not claim continuous operating-system locking or historical metadata.
- The fresh owned browser/server/PostgreSQL/runner stack uses deterministic fake-process execution and a synthetic Codex protocol, not live vendor inference, production identity or GitHub effects.
- Fifteen top-level browser groups include seven explicitly synthetic recovery presentation cases. Malformed warning variants are synthetic browser-storage edits to a receipt saved by the local server. Zero actual human reviews occurred.
- Nineteen original screenshots are retained. They are acceptance artifacts, not exhaustive visual or accessibility certification.
- The product head was already committed before this execution. The final evidence-only commit did not yet exist. All original bytes remain unchanged; separately checked evidence is added afterward.
- Native r12 records final canonical validation as pending because it completed earlier. The later canonical receipt and matching-source binding establish its successful completion without rewriting that historical native receipt.
- Skipped Node and ignored Rust cases are not passes. Focused, coverage, native and canonical counts overlap. Dedicated live and immutable historical replay lanes remain separate.
- Locked-dependency receipts are reused with unchanged locks. Steward log bytes were first bound retrospectively by the existing dependency-artifact receipt. Dependency installation was not re-executed.
- Rust workspace tests use RUST_TEST_THREADS=1 without filtering tests. The separately required native EVM gate is still executed.
- The actual Node runtime is 24.21.0, while the repository declares 24.19.0. Execution on the declared Node version is not claimed.
- Required hosted CI, CodeQL, code-quality and security checks remain unavailable while GitHub Actions is disabled. No merge, issue closure, self-approval, policy change or clean historical Cargo advisory audit is claimed.
