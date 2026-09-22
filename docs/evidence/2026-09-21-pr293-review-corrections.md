# PR #293: bounded review corrections

This correction starts from `7f21056dc8693617cb1cf8ad5f0b14d0ce071051`.
It does **not** establish full-PR acceptance, production qualification, or NICE.

## Corrections

- **F04:** both RPC providers must corroborate receipt absence and the consumed
  nonce before replacement, rebroadcast, or nonce-conflict quarantine. Existing
  inclusion/finality checks remain.
- **F05:** only a successful, well-formed receipt with no new anchor event may
  enter original-event reconciliation. Invalid, duplicate, contradictory, or
  incorrectly bound evidence propagates as an error.
- **F08:** move the unchanged publication test module after production items to
  satisfy strict Clippy. No warning suppression or weakened check.
- **F12:** qualification source identity includes schema, contract, and other
  Git source inputs. Ignored credentials and generated runtime/build evidence
  remain excluded.

## Issue-lane evidence

Each correction was implemented by a separate native Astra executor. These
results describe the isolated issue lanes, not an invented full runtime run:

| Finding | Actual failing check | Actual corrected check |
| --- | --- | --- |
| F04 | Two behavioral HTTP regression failures after extracting the unchanged old decision | Both regressions pass; the final F05 library run preserves all six F04 HTTP tests |
| F05 | Five behavioral failures and two passing controls for the old catch-all fallback | Seven regressions and all 30 library tests pass |
| F08 | Strict scoped Clippy exits 101 for `items_after_test_module` | Clippy exits 0; 29 crate tests and two feature-selected transport tests pass |
| F12 | Native Git/filesystem regression detects the omitted inputs: 63 failing subtests, including all 59 existing schema/contract/build inputs | 170 tests pass, including all 104 pre-existing qualification guards |

Reproduce with the repository-pinned tools:

```sh
cargo test -p crony-base --lib --locked --offline
cargo clippy -p crony-base -p crony-server --all-targets --locked --offline -- -D warnings
cargo clippy -p crony-audit --all-targets --locked --offline -- -D warnings
cargo test -p crony-audit --locked --offline
cargo test -p crony-audit --features test-support transport_tests --locked --offline
node --test tools/native_qualification_attempt.test.mjs tools/native_qualification_finality.test.mjs tools/native_qualification_trust.test.mjs
```

The HTTP tests use owned loopback fixtures; receipt tests use synthetic values;
contract tests use an in-process EVM. No live chain, real wallet, KMS credential,
Factory execution, or database fixture was used for these corrections.
Original failures, source snapshots, commands, exits, and native agent identities
are retained in the executor's external PR-293 round-1/round-2 receipts.

## Still blocked

The full 22-row independent audit remains NAUGHTY; overall readiness is BLOCKED.
Unresolved findings cover disclosure authorization, wallet enrollment authority,
complete-archive admission, receipt fee enrichment, lock ordering, bounded
destination discovery, terminal incident preservation, gateway error categories,
and two optional unused RPC surfaces. None is closed by these four corrections.

The current user-required validation has **nine** commands. This branch lacks
`check:docs`, `test:unit`, and `test:steward`; their actual exit-1 results are
unavailable gates, not passes or waivers. Hosted CI is separately blocked by
inherited mutable Action refs prohibited by organization policy.

The Docker Linux endpoint was unavailable, so there is no fresh SQLx or full
browser/server/runner/chain acceptance claim. Required committed screenshot
evidence, genuine author/human review, draft status, stacked dependencies, and
the two existing conflicts with the actual PR-283 target remain separate gates.
Scoped publication review does not substitute for full Santa acceptance.
