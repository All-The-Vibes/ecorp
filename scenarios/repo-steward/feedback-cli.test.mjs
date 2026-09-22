import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { main, parseArgs, readReview, saveNew } from './feedback.mjs';
import { fixtureSnapshot } from './fixtures/demo.mjs';
import { audit } from './lib/steward.mjs';
import { createFeedbackCorpus, createFeedbackEvidence, proposeFeedback } from './lib/feedback.mjs';

function directory(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'ecorp-feedback-cli-'));
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith('ecorp-feedback-cli-'));
    rmSync(root, { recursive: true });
  });
  return root;
}

function reviewFixture(t) {
  const root = directory(t), now = new Date('2026-09-18T12:00:00Z');
  const snapshot = fixtureSnapshot(now), report = audit(snapshot, { now, source: 'synthetic-fixture' });
  const finding = report.findings.find(item => item.rule === 'WORKSTREAM_UNTAGGED');
  const proposed = proposeFeedback({ corpus: createFeedbackCorpus({ scope: snapshot.scope, now }),
    rule: finding.rule, guidance: { text: 'Inspect the source before proposing advisory changes.', route: 'inspect-evidence' },
    evidence: [createFeedbackEvidence({ snapshot, findingId: finding.id, now, source: 'synthetic-fixture' })],
    expiresAt: new Date(now.getTime() + 3600000).toISOString(), now });
  const corpus = path.join(root, 'corpus.json'), input = path.join(root, 'input.json');
  const parent = path.join(root, 'reviews'), output = path.join(root, 'updated.json');
  mkdirSync(parent);
  const review = path.join(parent, 'review.bin'), bytes = Buffer.from('reviewed exact bytes\r\n\0');
  writeFileSync(review, bytes);
  writeFileSync(corpus, JSON.stringify(proposed.corpus));
  writeFileSync(input, JSON.stringify({ candidateId: proposed.record.id, expectedCandidateDigest: proposed.recordDigest,
    decision: 'reject', reviewEvidence: { reason: 'Synthetic local review retains advisory scope.' } }));
  const before = readFileSync(corpus);
  return { root, parent, review, bytes, output,
    invoke: () => main(['review', '--corpus', corpus, '--input', input, '--review-file', review, '--out', output], { now }),
    unchanged: () => { assert.deepEqual(readFileSync(corpus), before); assert.equal(existsSync(output), false); } };
}

function interceptFs(t, method, intercept) {
  const original = fs[method];
  t.mock.method(fs, method, (...args) => intercept(original, args));
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
}

function openedReview(t, review) {
  let descriptor;
  interceptFs(t, 'openSync', (open, args) => {
    const fd = open(...args);
    if (args[0] === review) descriptor = fd;
    return fd;
  });
  return () => {
    assert.equal(typeof descriptor, 'number');
    assert.throws(() => fs.fstatSync(descriptor), { code: 'EBADF' });
  };
}

test('feedback CLI rejects unsupported, missing and duplicate transition arguments', () => {
  for (const args of [[], ['activate'], ['init', '--snapshot', 'a.json'],
    ['init', '--snapshot', 'a.json', '--out', 'b.json', '--max-active', '33'],
    ['evidence', '--snapshot', 'a.json', '--finding', 'F-a', '--out', 'b.json', '--out', 'c.json'],
    ['review', '--corpus', 'a.json', '--input', 'b.json', '--out', 'c.json'],
    ['retire', '--corpus', 'a.json', '--input', 'b.json', '--out', 'c.json', '--execute', 'true']]) {
    assert.throws(() => parseArgs(args), error => error.code === 'ARGUMENT');
  }
});

test('new-file corpus output preserves the previous version and refuses overwrite', t => {
  const root = directory(t), file = path.join(root, 'corpus.json');
  saveNew(file, { first: true });
  const before = readFileSync(file);
  assert.throws(() => saveNew(file, { replacement: true }), error => error.code === 'EEXIST');
  assert.deepEqual(readFileSync(file), before);
});

test('initializing a corpus binds the validated input scope without changing its snapshot', t => {
  const root = directory(t), input = path.join(root, 'snapshot.json'), out = path.join(root, 'corpus.json');
  writeFileSync(input, JSON.stringify(fixtureSnapshot()));
  const before = readFileSync(input);
  const result = main(['init', '--snapshot', input, '--out', out]);
  assert.equal(result.mode, 'advisory-only');
  assert.equal(result.authenticated_reviewer_identity, false);
  assert.equal(result.remote_mutations, 0);
  assert.match(result.output_digest, /^[a-f0-9]{64}$/);
  assert.deepEqual(readFileSync(input), before);
  assert.equal(JSON.parse(readFileSync(out)).scope.repository, 'All-The-Vibes/ecorp');
});

test('partial snapshot cannot create a corpus file', t => {
  const root = directory(t), input = path.join(root, 'snapshot.json'), out = path.join(root, 'corpus.json');
  const snapshot = fixtureSnapshot();
  snapshot.coverage.complete = false;
  writeFileSync(input, JSON.stringify(snapshot));
  assert.throws(() => main(['init', '--snapshot', input, '--out', out]), error => error.code === 'INCOMPLETE');
  assert.throws(() => readFileSync(out), error => error.code === 'ENOENT');
});

test('redirected output parent is refused without writing through it', t => {
  const root = directory(t), actual = path.join(root, 'actual'), redirected = path.join(root, 'redirected');
  mkdirSync(actual);
  symlinkSync(actual, redirected, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => saveNew(path.join(redirected, 'corpus.json'), {}), error => error.code === 'OUTPUT');
  assert.equal(existsSync(path.join(actual, 'corpus.json')), false);
});

test('review evidence must be a file and cannot use a directory as a digest source', t => {
  const root = directory(t), snapshot = path.join(root, 'snapshot.json'), corpus = path.join(root, 'corpus.json');
  const input = path.join(root, 'review.json'), output = path.join(root, 'updated.json');
  writeFileSync(snapshot, JSON.stringify(fixtureSnapshot()));
  main(['init', '--snapshot', snapshot, '--out', corpus]);
  writeFileSync(input, '{}');
  const before = readFileSync(corpus);
  assert.throws(() => main(['review', '--corpus', corpus, '--input', input, '--review-file', root, '--out', output]), error => error.code === 'REVIEW_BOUND');
  assert.deepEqual(readFileSync(corpus), before);
  assert.equal(existsSync(output), false);
});

test('review CLI records the exact binary digest and closes its descriptor', t => {
  const fixture = reviewFixture(t), closed = openedReview(t, fixture.review);
  const result = fixture.invoke();
  assert.equal(result.record_status, 'retired');
  const updated = JSON.parse(readFileSync(fixture.output));
  assert.equal(updated.records[0].review.evidence_sha256, createHash('sha256').update(fixture.bytes).digest('hex'));
  closed();
});

test('same-size review replacement between metadata check and open cannot update a corpus', t => {
  const fixture = reviewFixture(t), closed = openedReview(t, fixture.review);
  let replaced = false;
  interceptFs(t, 'lstatSync', (stat, args) => {
    const result = stat(...args);
    if (args[0] === fixture.review && !replaced) {
      replaced = true;
      renameSync(fixture.review, path.join(fixture.root, 'original.bin'));
      writeFileSync(fixture.review, Buffer.alloc(fixture.bytes.length, 0x78));
    }
    return result;
  });
  assert.throws(fixture.invoke, { code: 'REVIEW_CHANGED' });
  assert.equal(replaced, true);
  fixture.unchanged();
  closed();
});

test('review parent swapped for a symlink or junction before open is rejected', t => {
  const fixture = reviewFixture(t), alternate = path.join(fixture.root, 'alternate');
  mkdirSync(alternate);
  writeFileSync(path.join(alternate, 'review.bin'), Buffer.alloc(fixture.bytes.length, 0x78));
  const closed = openedReview(t, fixture.review);
  let redirected = false;
  interceptFs(t, 'lstatSync', (stat, args) => {
    const result = stat(...args);
    if (args[0] === fixture.review && !redirected) {
      redirected = true;
      renameSync(fixture.parent, path.join(fixture.root, 'original-directory'));
      symlinkSync(alternate, fixture.parent, process.platform === 'win32' ? 'junction' : 'dir');
    }
    return result;
  });
  assert.throws(fixture.invoke, { code: 'REVIEW_CHANGED' });
  assert.equal(redirected, true);
  fixture.unchanged();
  closed();
});

test('same-size pathname replacement after descriptor read is rejected', t => {
  const fixture = reviewFixture(t), closed = openedReview(t, fixture.review);
  let replaced = false;
  interceptFs(t, 'readSync', (read, args) => {
    const count = read(...args);
    if (!replaced) {
      replaced = true;
      renameSync(fixture.review, path.join(fixture.root, 'opened-original.bin'));
      writeFileSync(fixture.review, Buffer.alloc(fixture.bytes.length, 0x78));
    }
    return count;
  });
  assert.throws(fixture.invoke, { code: 'REVIEW_CHANGED' });
  assert.equal(replaced, true);
  fixture.unchanged();
  closed();
});

test('same-size in-place review rewrite cannot hide behind a restored modification time', t => {
  const fixture = reviewFixture(t), oldTime = new Date('2000-01-01T00:00:00Z');
  utimesSync(fixture.review, oldTime, oldTime);
  const originalChangeTime = fs.statSync(fixture.review, { bigint: true }).ctimeNs;
  const closed = openedReview(t, fixture.review);
  let rewritten = false;
  interceptFs(t, 'readSync', (read, args) => {
    const count = read(...args);
    if (!rewritten) {
      rewritten = true;
      writeFileSync(fixture.review, Buffer.alloc(fixture.bytes.length, 0x78));
      // Establish a distinct native change timestamp even on coarse clocks,
      // while restoring mtime; the test does not assume one write spans a tick.
      const deadline = Date.now() + 1000;
      let changed;
      do {
        utimesSync(fixture.review, oldTime, oldTime);
        changed = fs.statSync(fixture.review, { bigint: true }).ctimeNs !== originalChangeTime;
      } while (!changed && Date.now() < deadline);
      assert.equal(changed, true);
    }
    return count;
  });
  assert.throws(fixture.invoke, { code: 'REVIEW_CHANGED' });
  assert.equal(rewritten, true);
  fixture.unchanged();
  closed();
});

test('review growth after open stays within its original byte bound and is rejected', t => {
  const fixture = reviewFixture(t), closed = openedReview(t, fixture.review);
  let readBytes = 0, grew = false;
  interceptFs(t, 'readSync', (read, args) => {
    if (!grew) { grew = true; appendFileSync(fixture.review, Buffer.alloc(131072, 0x78)); }
    const count = read(...args);
    readBytes += count;
    return count;
  });
  assert.throws(fixture.invoke, { code: 'REVIEW_CHANGED' });
  assert.equal(grew, true);
  assert.equal(readBytes, fixture.bytes.length + 1);
  fixture.unchanged();
  closed();
});

test('bounded review reads handle partial reads and reject empty or oversized files', t => {
  const root = directory(t), review = path.join(root, 'review.bin'), bytes = Buffer.alloc(65536, 0x6b);
  writeFileSync(review, bytes);
  interceptFs(t, 'readSync', (read, args) => { args[3] = Math.min(args[3], 4096); return read(...args); });
  assert.equal(readReview(review), createHash('sha256').update(bytes).digest('hex'));
  for (const length of [0, 65537]) {
    writeFileSync(review, Buffer.alloc(length));
    assert.throws(() => readReview(review), { code: 'REVIEW_BOUND' });
  }
});
