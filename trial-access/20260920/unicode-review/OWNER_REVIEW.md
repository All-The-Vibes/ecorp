# Unicode maintenance correction — owner review

**Native automated verification and exported-commit verification passed. The actual owner decision is pending.**

Reviewed native commit: **3aff250c118c1e24daebc39e7c8655049a344fb5**. Its only parent is 39632b957819012721c90902925d8fa7a9c7e873. This packet records no approval, publication or benchmark score.

## The exact change

Steward collected a valid Unicode body but then rejected it because its validator counted UTF-8 bytes while the collector limited UTF-16 code units. The observed body had 65,535 units and 65,795 bytes.

The three-file correction aligns the validator with the existing 65,536-unit string limit, adds seven meaningful regressions, and documents the distinction. The separate 16 MiB snapshot and cumulative-response byte limits remain enforced.

- scenarios/repo-steward/lib/common.mjs: use row.body.length for the body bound.
- scenarios/repo-steward/steward.test.mjs: add seven boundary/collection regressions.
- scenarios/repo-steward/README.md: explain string versus aggregate-byte limits.

## Native result and exported source

| Evidence | Verified result |
| --- | --- |
| Exported commit | 3aff250c118c1e24daebc39e7c8655049a344fb5 |
| Base / only parent | 39632b957819012721c90902925d8fa7a9c7e873 |
| Native automated checks | 2 of 2 passed; focused regressions 7 of 7 |
| Source tree | Exactly 3 intended paths changed; other 733 entries and all modes preserved |
| Provider evidence | 492-byte original retained evidence verified; excluded from exported tree |
| Exported artifact | 95,252 bytes · SHA-256 20d42b17fd0f5f5f7a5f411008390d85e33c932c0687cf3290df8d98c1890aeb |
| Verification digest | 25004f9a6f0ebf123cd211d07a17a94a83d04f884fdea47468de62d8737c1d5d |
| Embedded Git bundle | 2,301 bytes · SHA-256 c89c74b7a31ba4ec2a490c1cca09dac678c0651d53d5b85e8be8e715bcca4fba |
| Current outcome | Awaiting actual owner approval; no publication or new score |

Recovery 408fa2c6-69d4-4f31-b050-6b2b3b097d03, run caa55ef2-f313-4867-a60f-d676676fc70d, used contract revision 5c97a645-d84e-4c37-ac89-b6bd54fd82ee / version 2. The run is verification_only, with no provider session and zero reported input/output tokens. The native test check ran in a real verifier snapshot and checked 736 source files plus the exact registered provider artifact before/after 7 focused regressions.

The original provider run 910b058f-f2f5-4b92-b437-b8207c4b62eb remains failed. Its run record and original failure-evidence rows still exactly match the retained failure capture. No earlier failure was relabeled as a pass.

The artifact was downloaded through the authorized native read path. Its size, SHA-256, media role and signature header match the native record. The server performs signed-provenance validation; this audit did not access the signing key.

The 2,301-byte Git bundle was verified and imported into a new bare repository, without checkout, hooks or candidate-code execution. It has one expected head, the exact base parent, 736 tree entries and the following three blobs. The other 733 entries are unchanged, all modes are preserved, and copilot-evidence.json is absent from the export.

| Path | Verified Git blob |
| --- | --- |
| scenarios/repo-steward/README.md | d9609c0d551a40a057246d327f764c11bddfea3b |
| scenarios/repo-steward/lib/common.mjs | f54103e779be060942868eead6d64f1210f06148 |
| scenarios/repo-steward/steward.test.mjs | f563ad9bd16a0348ea597385ad99d44dec5022da |

Audit receipt SHA-256: d27f7462d3a1f3e087f788c834d6db62a5e2b994f4e658436e62e29e1b93ac3d.

## Seven focused regressions

1. Collector preserves a complete Unicode PR body with 65,535 UTF-16 units and 65,795 UTF-8 bytes.
2. Issue body at exactly 65,536 UTF-16 units is accepted unchanged.
3. Issue body at 65,537 UTF-16 units is rejected.
4. PR body at exactly 65,536 UTF-16 units is accepted unchanged.
5. PR body at 65,537 UTF-16 units is rejected.
6. Individually valid bodies cannot exceed the aggregate 16 MiB snapshot byte limit.
7. The collector rejects cumulative response bytes beyond its 16 MiB limit.

The original-code baseline produced 3 expected assertion failures and 4 passes; the corrected candidate passed 7/7. The native recovery independently reran these seven with zero failures/skips/cancellations/todos. They are also included in the 234-test Steward contributor suite.

## Nine required contributor checks

| Check | Actual result | Wall time |
| --- | --- | ---: |
| Migration check | Pass | 0.876 s |
| Documentation contracts | Pass | 5.590 s |
| Web/tool unit tests | 1,204 passed · 44 skipped · 0 failed | 73.971 s |
| Steward tests | 234 passed · 0 skipped · 0 failed | 56.707 s |
| Rust formatting | Pass | 6.958 s |
| Rust Clippy, all targets, warnings denied | Pass | 163.600 s |
| Rust workspace tests | 565 passed · 343 ignored · 0 failed | 276.147 s |
| Web production build | Pass | 27.384 s |
| Web lint | Pass | 5.221 s |

Primary toolchain: Node 24.19.0, pnpm 11.19.0, Rust 1.98.1 and Windows x64 MSVC. Earlier Node 22 results remain compatibility evidence. All 30 root gate-log hashes were independently verified.

The corrected CLI also completed a fresh read-only maintenance cycle. A separate identical supplied-input repeat returned no-op. The selected retired rule generated zero annotations despite nine matching findings while unexpired.

## Remaining decision and limits

- The native human_approval gate still requires the actual owner decision. This packet does not submit one.
- Review publication remains pending; merge and deployment are separate.
- A fresh qualified benchmark result remains pending. No higher score or learning improvement is claimed.
- The 44 skipped JavaScript cases and 343 ignored Rust tests were not executed passes.
- Runtime evidence uses owned local development identities, not production-authentication or OS-isolation proof.
- No private GitHub body, credential, raw local log or local filesystem path is embedded in the public review material.

## Candidate review diff

The display below retains the originally reviewed candidate diff: 5798 bytes, SHA-256 661622d5c97bdb32f5cb444e7e69ac900688b98610eb9d1c3a55420ca69890a9. The native exported patch is 5996 bytes, SHA-256 649ccaa34374ced2fcc081eaca280f3ea2f3bb11e95e08b6498a830772b75f5d. Their serialization differs; the exported canonical file blobs above are identical to the reviewed candidate.

```diff
diff --git a/scenarios/repo-steward/README.md b/scenarios/repo-steward/README.md
index cc5f36e..d9609c0 100644
--- a/scenarios/repo-steward/README.md
+++ b/scenarios/repo-steward/README.md
@@ -59,6 +59,10 @@ exhausted GraphQL reserve. Two matching reads are not an atomic GitHub transacti
 A saved snapshot remains supplied data, not fresh authorization. Answers label
 their timestamp and freshness. Hosted live audits refuse stale snapshots.
 
+Issue and PR bodies use the existing 65,536 UTF-16 code-unit string limit, so a
+bounded Unicode body is not rejected for taking more UTF-8 bytes. Complete
+snapshots and cumulative collection responses retain their 16 MiB byte limits.
+
 ## Manual GitHub Actions pilot
 
 The workflow source is `.github/workflows/repo-steward.yml`. Adding that file to a
diff --git a/scenarios/repo-steward/lib/common.mjs b/scenarios/repo-steward/lib/common.mjs
index 1c80de1..f54103e 100644
--- a/scenarios/repo-steward/lib/common.mjs
+++ b/scenarios/repo-steward/lib/common.mjs
@@ -51,7 +51,8 @@ export function readJson(path, maxBytes = 16777216) {
 function array(value, name, max = 1000) { requireThat(Array.isArray(value) && value.length <= max, 'SNAPSHOT', `Invalid ${name}.`); }
 function entity(row, kind) {
   requireThat(isObject(row) && integer(row.number) && typeof row.title === 'string' && typeof row.body === 'string', 'SNAPSHOT', `Invalid ${kind}.`);
-  requireThat(Buffer.byteLength(row.body) <= 65536 && row.title.length <= 1024, 'INPUT_BOUND', `${kind} text exceeds its bound.`);
+  // Match safeData's UTF-16 string bound; aggregate snapshot bytes remain bounded.
+  requireThat(row.body.length <= 65536 && row.title.length <= 1024, 'INPUT_BOUND', `${kind} text exceeds its bound.`);
   requireThat(validTime(row.updated_at), 'SNAPSHOT', `Invalid ${kind} revision.`);
   requireThat(row.repository === undefined || sameRepo(row.repository), 'SCOPE', 'Entity is outside the approved repository.');
   requireThat(row.url === (kind === 'issue' ? issueUrl(row.number) : prUrl(row.number)), 'SCOPE', 'Entity URL does not match its identity.');
diff --git a/scenarios/repo-steward/steward.test.mjs b/scenarios/repo-steward/steward.test.mjs
index 3b376f8..f563ad9 100644
--- a/scenarios/repo-steward/steward.test.mjs
+++ b/scenarios/repo-steward/steward.test.mjs
@@ -181,6 +181,55 @@ for (const [name, mutate] of [
   ['duplicate project item', s => { s.project_items.push(structuredClone(s.project_items[0])); counts(s); }], ['oversized body', s => { s.issues[0].body = 'a'.repeat(65537); }],
 ]) test(`snapshot rejects ${name}`, () => { const snapshot = fresh(); mutate(snapshot); assert.throws(() => validateSnapshot(snapshot)); });
 
+test('Unicode body bounds: collector preserves the full bounded multibyte PR body', async () => {
+  const snapshot = fresh(), body = 'a'.repeat(65275) + 'é'.repeat(260);
+  assert.equal(body.length, 65535); assert.equal(Buffer.byteLength(body), 65795);
+  assert.equal(safeText(body, 65536), body);
+  snapshot.pull_requests[0].body = body;
+  const collected = await collectSnapshot({ reader: mockReader(snapshot), now: () => now });
+  assert.equal(collected.pull_requests[0].body, body);
+  assert.equal(collected.collection.writes, 0);
+});
+
+for (const [key, kind] of [['issues', 'issue'], ['pull_requests', 'pull request']]) {
+  test(`Unicode body bounds: ${kind} accepts 65536 UTF-16 units unchanged`, () => {
+    const snapshot = fresh(), body = 'é漢🙂'.repeat(16384);
+    assert.equal(body.length, 65536); assert.ok(Buffer.byteLength(body) > 65536);
+    snapshot[key][0].body = body;
+    assert.doesNotThrow(() => validateSnapshot(snapshot));
+    assert.equal(snapshot[key][0].body, body);
+  });
+  test(`Unicode body bounds: ${kind} validator rejects 65537 UTF-16 units`, () => {
+    const snapshot = fresh(), body = 'é'.repeat(65535) + '🙂';
+    assert.equal(body.length, 65537);
+    snapshot[key][0].body = body;
+    assert.throws(() => validateSnapshot(snapshot), { code: 'INPUT_BOUND', message: `${kind} text exceeds its bound.` });
+  });
+}
+
+test('Unicode body bounds: individually valid bodies still exceed the aggregate snapshot byte limit', () => {
+  const snapshot = fresh(), policy = loadPolicy(), body = '漢'.repeat(65536);
+  assert.equal(policy.limits.max_bytes, 16777216);
+  for (let i = 0; i < Math.ceil(policy.limits.max_bytes / Buffer.byteLength(body)); i++) {
+    snapshot.issues.push(fixtureIssue(900 + i, 'Bounded Unicode body', { body }));
+  }
+  counts(snapshot);
+  const serialized = JSON.stringify(snapshot);
+  assert.ok(snapshot.issues.length < policy.limits.max_records);
+  assert.ok(serialized.length < policy.limits.max_bytes);
+  assert.ok(Buffer.byteLength(serialized) > policy.limits.max_bytes);
+  assert.throws(() => validateSnapshot(snapshot, policy), { code: 'INPUT_BOUND', message: 'Snapshot exceeds byte bound.' });
+});
+
+test('Unicode body bounds: reader retains the aggregate UTF-8 response byte limit', async () => {
+  const policy = loadPolicy();
+  const response = JSON.stringify({ login: SCOPE.collector_login, padding: '漢'.repeat(Math.ceil(policy.limits.max_bytes / 3)) });
+  assert.ok(response.length < policy.limits.max_bytes);
+  assert.ok(Buffer.byteLength(response) > policy.limits.max_bytes);
+  const reader = createGithubReader({ policy, run: async () => response });
+  await assert.rejects(reader.account(), { code: 'INPUT_BOUND', message: 'Collection response byte bound exceeded.' });
+});
+
 test('collector completes two matching passes with no writes', async () => {
   const snapshot = await collectSnapshot({ reader: mockReader(), now: () => now });
   assert.equal(snapshot.issues.length, 12); assert.equal(snapshot.collection.writes, 0); assert.match(snapshot.coverage.consistency, /not an atomic/);
```
