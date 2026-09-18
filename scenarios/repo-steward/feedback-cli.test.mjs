import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { main, parseArgs, saveNew } from './feedback.mjs';
import { fixtureSnapshot } from './fixtures/demo.mjs';

function directory(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'ecorp-feedback-cli-'));
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith('ecorp-feedback-cli-'));
    rmSync(root, { recursive: true });
  });
  return root;
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
