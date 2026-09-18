import test from 'node:test';
import assert from 'node:assert/strict';
import { bearer, authorize, bindSubject, consumeTransaction } from '../security.mjs';

test('requires a single correctly formed bearer credential', () => {
  for (const value of [undefined, '', 'Basic secret', 'Bearer', 'Bearer a b', 'Bearer a, Bearer b']) {
    assert.throws(() => bearer(value), { status: 401 });
  }
  assert.equal(bearer('Bearer abc.def.ghi'), 'abc.def.ghi');
});

test('reader identity is provisioned, not first-login trust', () => {
  assert.equal(authorize({ sub: 'reader-id' }, 'reader-id', 'GET'), true);
  assert.throws(() => authorize({ sub: 'other-id' }, 'reader-id', 'GET'), { status: 403 });
  assert.throws(() => authorize({}, 'reader-id', 'GET'), { status: 403 });
  assert.throws(() => authorize({ sub: 'reader-id' }, '', 'GET'), { status: 403 });
});

test('even the provisioned reader cannot write', () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    assert.throws(() => authorize({ sub: 'reader-id' }, 'reader-id', method), { status: 403 });
  }
});

test('exchanged subject must equal validated input subject', () => {
  assert.equal(bindSubject({ sub: 'one' }, { sub: 'one' }), true);
  assert.throws(() => bindSubject({ sub: 'one' }, { sub: 'two' }), { status: 403 });
  assert.throws(() => bindSubject({}, {}), { status: 403 });
});

test('browser transaction is bounded, state-bound, and single use', () => {
  const transactions = new Map([['cookie', { state: 'state', expires: 200 }]]);
  assert.throws(() => consumeTransaction(transactions, 'cookie', 'wrong', 100), { status: 400 });
  assert.equal(transactions.size, 0);
  transactions.set('cookie', { state: 'state', expires: 200 });
  assert.equal(consumeTransaction(transactions, 'cookie', 'state', 100).state, 'state');
  assert.throws(() => consumeTransaction(transactions, 'cookie', 'state', 100), { status: 400 });
  transactions.set('cookie', { state: 'state', expires: 99 });
  assert.throws(() => consumeTransaction(transactions, 'cookie', 'state', 100), { status: 400 });
});
