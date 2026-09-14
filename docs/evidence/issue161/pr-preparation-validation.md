# Issue 161 PR-preparation validation - September 13, 2026

## Status and scope

All six required repository gates passed in this approved local
documentation/publication-preparation pass. This is not a new full-stack or
multi-host acceptance run. The contribution remains uncommitted and unpublished.

- Contribution: `C:\Users\aabdelsalam\.ecorp\contributions\issue-161-shared-authority`.
- Branch/base: `codex/issue-161-shared-authority` at
  `b2523964e7576cafc00e84a51e1044f55826dea7`.
- Upstream `main` was refreshed read-only and still matches that base.
- Only three pre-existing candidate files changed in this pass:
  `docs/FACTORY_CLAIM_AUTHORITY.md`, `docs/EVALS.md`, and
  `docs/evidence/issue161/implementation-notes.md`.
- The other 34 existing candidate files are byte-identical to the preparation
  baseline, including product code, tests, migrations, QA drivers and original evidence.
- This validation report is the only additional proposed repository evidence file.
  The local PR/issue drafts and `candidate-review.patch` are preparation artifacts
  excluded from proposed staging.
- No staged change, contribution commit, push, issue/PR write, status/readiness
  change, service restart, retained-data reset, deployment or merge is authorized here.

The three documentation edits lead reviewers to the recorded runtime verdict,
preserve the earlier checkpoint and distinguish deterministic plan validity from
current dispatch readiness. They do not fix or change preflight behavior.

## Current local gates

Tools: Windows ARM64, Node `24.19.0`, Cargo `1.98.1`, pnpm `11.19.0`.
Rust dependencies use the existing cache with `--locked --offline`; no dependency
installation or lockfile change was performed.

| Command | Current result |
| --- | --- |
| `node tools/check_migrations.mjs` | Passed: 42 immutable migration checksums; no migration applied |
| `cargo fmt --check` | Passed |
| `cargo clippy --workspace --all-targets --locked --offline -- -D warnings` | Passed |
| `cargo test --workspace --locked --offline --quiet -- --test-threads=1` | Passed: 554 executed, zero failures, 332 explicitly ignored |
| `pnpm build:web` | Passed |
| `pnpm lint:web` | Passed |
| `git diff --check` | Passed on the tracked contribution |
| Relative documentation targets | 27 links in the three updated documents resolved |
| Preparation edit-scope hashes | Only the three authorized existing documents changed |
| Git index | Empty |

The fresh workspace totals include 213 passing runner tests with one explicitly
ignored stopped-provider probe, 121 passing server tests with seven ignored
database tests, and 62 passing store tests with 324 ignored database tests.
The remaining workspace crates account for 158 passing tests. The serial runner
suite took 315.69 seconds. Ignored cases are not passes.

The completed `git add --dry-run` preview selected exactly 38 candidate paths:
the 37 manifest entries below plus this report. It excluded `pr-draft.md` and
`followup-issue-draft.md`; the subsequently generated local `candidate-review.patch`
is also outside that exact list. No index entries were staged. This is a
file-selection preview, not permission to commit or publish.

Final read-only checks at `2026-09-14T02:35:24Z` confirmed the 37-file manifest
still matched, the index was empty, and 36 relative links across the three updated
documents, this report and the two drafts resolved. The retained operator source
was clean at `971445e1cbf9388c51803e2adf28b11bd98b1ffa`; both API receipts reported
`stopped` and ports 55461/18971/18972/15471 had no listeners. The retained runtime
result and patched helper still matched their recorded SHA-256 values. No
retained database or credential contents were read.

The test subprocess removes `DATABASE_URL` and ambient `CRONY_*` / `ECORP_*`
variables before Cargo starts. It selects no `--ignored` database/provider lane.
Serial execution runs the ordinary workspace suite; it is not a new parallel-load,
cross-platform or multi-host qualification. The format command returned exit 0
despite a sandbox profile-path canonicalization warning.

## Historical evidence stays historical

[runtime-acceptance.md](runtime-acceptance.md), [runtime-result.json](runtime-result.json)
and [qa-handoff.md](qa-handoff.md) are unchanged. Their database/native/browser/helper
results were not rerun in this pass. In particular, the separately recorded nine
database tests are not included as executed tests in the ordinary workspace gate.

The retained source-drift result remains: preflight accepted the unbound deterministic
plan; dispatch rejected the unmatched immutable checkout after claim/materialization,
with one blocked item/mission, zero runs, unchanged prior projections and no
wrong-source workspace/write. The local follow-up issue draft proposes a reviewed
readiness contract, not a completed fix.

Physical multi-host, independent production-human/provider identities, production
deployment/auth topology and real-provider/GitHub effects remain open. #161 is a
non-closing contribution; #248/#249 retain their separate workstream scopes.

## Helper dependency and publication boundary

PR #237 was refreshed read-only and remains open at
`b31a38a62330aacba80c3953142e1da957a63ecd`. QA uses that detached dependency plus
the exact [native-timestamp patch](../../../tools/issue161/pr237-native-time.patch);
the patched helper digest recorded by runtime QA is
`aa0d3c377847c479c69e8be6e1f809bf4b155c53dc6903c1d6922fde4732e144`.
No integration change or message was sent to #237. Coordinate that fix separately;
do not copy its broader supervisor diff.

The next publication preview is one draft PR to `All-The-Vibes/ecorp:main` from
`codex/issue-161-shared-authority`, titled
`feat(factory): pin and expose the shared claim authority`, with `Refs #161`.
A separate narrow readiness issue is drafted locally only. Before either is
published, review the final candidate, approve commit/push/publication explicitly,
record the exact committed head and bind evidence links to that head. Never
force-push, auto-merge, close #161, move Project status or dispatch controllers.

## Candidate byte manifest

Checked at `2026-09-14T02:29:48.790Z`. The manifest covers the 37 existing candidate
paths below, not this self-referential report or the local publication/review artifacts.

- Manifest SHA-256: `1d9281e515340aa82c6ff863f4490220d40e769787a57ccf43736658458037e6`.
- Algorithm: SHA-256 of UTF-8 compact JSON of the sorted array of
  `{path,sha256}` entries below; paths sorted lexically, lowercase digests.
- Tracked `git diff --binary --no-ext-diff` SHA-256:
  `0cec0bf3c102b536f57da96ec88406f57a6d4ac17f8893359d6093db710caa54`.
- The manifest identifies this uncommitted candidate. It is not a Git commit or
  proof of every historical runtime input.

| Candidate path | File SHA-256 |
| --- | --- |
| `CONTRIBUTING.md` | `5b1807086abee040807dec16ff62be6210a25f0a63f0185e42a5a1123a51400d` |
| `apps/web/src/App.tsx` | `b7081c9ac4f5092a36648147e241769552ee892c13b57bfebf4e940ce202d66d` |
| `apps/web/src/FactoryAuthorityNotice.css` | `dbe17d366cd1bdd99642a4928b87e64ff1820a9d3504837730d9eb593222a504` |
| `apps/web/src/FactoryAuthorityNotice.tsx` | `f545a4aabf16085201f88799aee6995911308697a0ce48405e764517104bbece` |
| `apps/web/src/factoryAuthority.test.mjs` | `c789d10004e3d67553ead2fe602ac80a3a995fc4fa55fc8b8924a4be8af8565c` |
| `apps/web/src/factoryAuthority.ts` | `eacc6d47036923621d7a69e0270062e0bdfdc7f9e58fc1c83d621ebd33ad8b3f` |
| `crates/crony-cli/src/factory.rs` | `598a550f9253dae8702fbe2f2a905f66839a35b77fb8980f84eefaa86d9b83b2` |
| `crates/crony-cli/src/factory/authority.rs` | `03ec03dce2e6b1d87571d4609ebe30e47b19dfd8a3c65e480d5695d4c6caf14d` |
| `crates/crony-cli/src/main.rs` | `e4f6268d7af2311792c8d42b093268fb61373d4897a2dac41d865a06403edd46` |
| `crates/crony-domain/src/factory_authority.rs` | `38251e3dfa0fe41315558aa0d5db2aea4cf6ab6a0eecb9950df6e3b81ba6e179` |
| `crates/crony-domain/src/lib.rs` | `2d48f771a84e0581622d49a6004ddb2f31e559c3c15211d8eb92a03c90c6602f` |
| `crates/crony-protocol/src/lib.rs` | `cb0d9875d747a2377b3eb1391a5079bd2fd0ad3675a88ab9c45f474715c8e87e` |
| `crates/crony-server/src/factory_authority.rs` | `8510a2d281f595a496f01e44848cf1274ad9dd8bb848a9ebe156bed89c3ce498` |
| `crates/crony-server/src/factory_connection_tests.rs` | `4a28963b4d8e3c9e2a484aefbc55bf20ba230ff368257433f1aec6edbe4106b6` |
| `crates/crony-server/src/issue161_authority_tests.rs` | `3b0d3b1dc81366f30fbd57f475e353f9c2eaec310aea89d8aa152511ed0c6d15` |
| `crates/crony-server/src/main.rs` | `be8a6c6a7c3a191008d9707fb3e2e2e1e25141b387d75adc19ff4b14fcdf362d` |
| `crates/crony-store/src/factory_authority.rs` | `5ec435ebb07c0f7953d8248ae543e3ef03404cd934c611b35f3d06671d635ee4` |
| `crates/crony-store/src/factory_connection_tests.rs` | `075c795623d32249af86628995ce13a3f820d1614b1aca49281e4e564313a3de` |
| `crates/crony-store/src/issue161_authority_tests.rs` | `16337fac14471a0040f8f1ea42ad1a71ee21684128eb84519167f090ec5717df` |
| `crates/crony-store/src/lib.rs` | `b5815a7c3dc6ab28777dfe65d87332444051374303da7d3a7a2abf521bba796f` |
| `db/migrations/0042_factory_claim_authority.sql` | `9f82f716212033df47426b2515fdbb5c0372a744840ffec0b86a0b563d090872` |
| `db/migrations/manifest.json` | `5d6f3b7a479c015bdc9213ff6ea9094aa4d6677e2ce963f67d3cea178150a057` |
| `docs/EVALS.md` | `9e5d1dd9422ebbfc4d565765abe92c4ac8674c02816f425feb2773b98ee02299` |
| `docs/FACTORY_CLAIM_AUTHORITY.md` | `739bd1b476caf9dd6934e91b73aa923f6771a8835e081009698de5dde884b099` |
| `docs/evidence/issue161/implementation-notes.md` | `165032692274491464c0493cf4ae88f09707c86caf3ccda85527f6307f0aaba6` |
| `docs/evidence/issue161/qa-handoff.md` | `b58023c310911ac0edf8bdcd282624659aa10d50bf81f2b21566c9a1ff64b8ff` |
| `docs/evidence/issue161/runtime-acceptance.md` | `b78a6196d60436e69514f211022ec203adb8b6973761d079765a01f07aaef7b2` |
| `docs/evidence/issue161/runtime-result.json` | `d60b01bf812e0850b365bafcf1ea6e4c8ddd508da34f4d848c58007b16d5c487` |
| `tools/issue161/pr237-native-time.patch` | `6c34349d7acdea6718bec4051a025adca8cc47df860bfe9c957dd91fc4a25732` |
| `tools/issue161/qa-api.mjs` | `9e71c396c2654e2825d5145264713831cb5a4988a4892dfab8d1fff646f7263c` |
| `tools/issue161/qa-evidence.mjs` | `a01fde8d5b3e9d808e7b20b2b874bfa8f280753c90fc84c629714f6a9473defe` |
| `tools/issue161/qa-finish-evidence.mjs` | `5906ae24cc2bc3756db0243d1f2779562093d5f7cca030d52c8ffd968f9a580b` |
| `tools/issue161/qa-host.ps1` | `cd9873884e3010f55b94e6cf6febe4eedbc59648a33188da59e6eda8d240e42d` |
| `tools/issue161/qa-plan.mjs` | `012c458bc4d558a06667b955db1a3e53bd0e9afa641553ac11ed33dc012a0ac3` |
| `tools/issue161/qa-plan.test.mjs` | `ebb1933b13ce7d1939411dabd1892eb88bf56c0f96ef80860a0d4922623260d7` |
| `tools/issue161/qa-reconnect.mjs` | `b0cc13d12729d8809b629399f00a8ceb0382fedacb7bc110124c5af2cc3dcae0` |
| `tools/issue161/qa-scenarios.mjs` | `e327cfbbef910348472957113e0712b321a07dd7d58edb472bd1b7eebae10a4b` |
