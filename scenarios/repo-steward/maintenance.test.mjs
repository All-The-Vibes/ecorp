import test from 'node:test';
import assert from 'node:assert/strict';
import { main, parseArgs } from './maintenance.mjs';
import { MAX_ATTEMPTS } from './lib/recurring-audit.mjs';

const commit = 'a'.repeat(40);
const once = ['once', '--state-dir', 'state', '--source-commit', commit, '--snapshot', 'input.json'];
const watch = ['watch', ...once.slice(1), '--cycles', '3', '--interval-ms', '1000'];
const at = new Date('2026-09-18T06:00:00Z');

test('explicit collector profile requires a hash and cannot relabel a supplied snapshot', () => {
  const live = ['once', '--state-dir', 'state', '--source-commit', commit, '--live'];
  const profile = ['--collector-profile', 'profile.json', '--collector-profile-sha256', 'c'.repeat(64)];
  for (const args of [[...live, '--collector-profile', 'profile.json'], [...live, '--collector-profile-sha256', 'c'.repeat(64)],
    [...once, ...profile], [...live, ...profile.slice(0, -1), 'invalid']]) assert.throws(() => parseArgs(args), { code: 'ARGUMENT' });
  assert.equal(parseArgs([...live, ...profile]).collectorProfile.sha256, 'c'.repeat(64));
  assert.equal(parseArgs(['status', '--state-dir', 'state', ...profile]).collectorProfile.sha256, 'c'.repeat(64));
  assert.equal(parseArgs(['stop', '--state-dir', 'state', '--source-commit', commit, '--reason', 'End scope', ...profile]).collectorProfile.sha256, 'c'.repeat(64));
});

test('recurrence requires finite explicit bounds before reading any input', () => {
  for (const args of [[], ['watch', ...once.slice(1)], [...watch, '--cycles', '4'],
    [...once, '--live'], [...once, '--cycles', '3'], [...watch, '--duration-ms', '0'],
    watch.map(value => value === '1000' ? '0.5' : value),
    ['watch', '--state-dir', 'state', '--source-commit', commit, '--live', '--cycles', '2', '--interval-ms', '1000'],
    ['status', '--state-dir', 'state', '--snapshot', 'input.json'],
    ['stop', '--state-dir', 'state', '--source-commit', commit],
    [...once, '--command', 'arbitrary-shell']]) {
    assert.throws(() => parseArgs(args), error => error.code === 'ARGUMENT');
  }
  assert.equal(parseArgs(watch).cycles, 3);
  assert.equal(parseArgs(once).cycles, 1);
});

test('finite recurrence reloads snapshot and feedback on every cycle', async () => {
  const snapshots = [], inputs = [], pauses = [];
  const result = await main([...watch, '--corpus', 'feedback.json'], {
    now: () => at, state: () => null,
    load: filename => { inputs.push(filename); return { revision: inputs.length }; },
    cycle: async options => { snapshots.push(options); return { status: snapshots.length === 1 ? 'recorded' : 'no-op', newFindings: [], resolvedFindingIds: [] }; },
    sleep: async ms => { pauses.push(ms); },
    collect: () => { throw new Error('Unexpected network collection'); },
  });
  assert.equal(result.completed_cycles, 3);
  assert.equal(result.exit_reason, 'cycle-limit');
  assert.equal(inputs.length, 6);
  assert.deepEqual(snapshots.map(value => value.snapshot.revision), [1, 3, 5]);
  assert.ok(snapshots.every(value => value.sourceCommit === commit && value.source === 'provided-snapshot'));
  assert.deepEqual(pauses, [1000, 1000]);
  assert.equal(JSON.stringify(result).includes('revision'), false);
});

test('paused and stopped records prevent collection and input reads', async () => {
  for (const status of ['paused', 'stopped']) {
    let reads = 0;
    const result = await main(once, { now: () => at, state: () => ({ status, sourceCommit: commit }),
      load: () => { reads++; }, collect: () => { reads++; }, cycle: () => { throw new Error('Must not execute'); } });
    assert.equal(reads, 0);
    assert.equal(result.completed_cycles, 0);
    assert.equal(result.exit_reason, status);
  }
});

test('exhausted persisted attempts reject before snapshot, feedback or live collection', async () => {
  const live = ['watch', '--state-dir', 'state', '--source-commit', commit, '--live', '--cycles', '2', '--interval-ms', '60000'];
  for (const args of [[...once, '--corpus', 'feedback.json'], live]) {
    let reads = 0, cycles = 0;
    await assert.rejects(main(args, {
      now: () => at, state: () => ({ status: 'running', sourceCommit: commit, attempts: MAX_ATTEMPTS }),
      load: () => { reads++; return {}; }, collect: () => { reads++; return {}; },
      cycle: () => { cycles++; return { status: 'recorded' }; }, sleep: async () => {},
    }), { code: 'ATTEMPT_BOUND' });
    assert.equal(reads, 0); assert.equal(cycles, 0);
  }
});

test('watch admits the final allowed attempt and then stops before collecting another snapshot', async () => {
  let attempts = MAX_ATTEMPTS - 1, reads = 0, cycles = 0;
  await assert.rejects(main(watch, {
    now: () => at, state: () => ({ status: 'running', sourceCommit: commit, attempts }),
    load: () => { reads++; return {}; },
    cycle: () => { attempts++; cycles++; return { status: 'recorded' }; }, sleep: async () => {},
  }), { code: 'ATTEMPT_BOUND' });
  assert.equal(attempts, MAX_ATTEMPTS); assert.equal(reads, 1); assert.equal(cycles, 1);
});

test('source mismatch refuses before reading snapshot or feedback', async () => {
  await assert.rejects(main(once, { now: () => at,
    state: () => ({ status: 'running', sourceCommit: 'b'.repeat(40) }),
    load: () => { throw new Error('Must not read'); } }), error => error.code === 'SOURCE_DRIFT');
});

test('a failed cycle stops recurrence without retrying or losing the failure', async () => {
  let calls = 0;
  const failure = Object.assign(new Error('retained failure'), { code: 'STALE_SNAPSHOT' });
  await assert.rejects(main(watch, { now: () => at, state: () => null, load: () => ({}),
    cycle: () => { calls++; throw failure; }, sleep: () => { throw new Error('Must not retry'); } }), error => error === failure);
  assert.equal(calls, 1);
});

test('duration bounds stop admission after collection without writing a late result', async () => {
  let clock = at.getTime(), calls = 0;
  const result = await main([...watch, '--duration-ms', '1000'], { now: () => new Date(clock), state: () => null,
    load: () => { clock += 1001; return {}; }, cycle: () => { calls++; } });
  assert.equal(calls, 0);
  assert.equal(result.exit_reason, 'duration-limit');
});

test('interruption during an interval exits without another audit', async () => {
  const interruption = new AbortController();
  let calls = 0;
  const result = await main(watch, { now: () => at, state: () => null, load: () => ({}), signal: interruption.signal,
    cycle: () => { calls++; return { status: 'recorded' }; },
    sleep: () => { interruption.abort(); throw Object.assign(new Error('stop'), { name: 'AbortError' }); } });
  assert.equal(calls, 1);
  assert.equal(result.exit_reason, 'interrupted');
});

test('control commands delegate exact action, source and reason without collecting', async () => {
  for (const action of ['pause', 'resume', 'stop']) {
    let actual;
    const result = await main([action, '--state-dir', 'state', '--source-commit', commit, '--reason', 'local operation'], {
      now: () => at, control: input => { actual = input; return { status: { pause: 'paused', resume: 'running', stop: 'stopped' }[action] }; },
      load: () => { throw new Error('Unexpected read'); }, collect: () => { throw new Error('Unexpected collection'); },
    });
    assert.equal(actual.action, action);
    assert.equal(actual.sourceCommit, commit);
    assert.equal(actual.reason, 'local operation');
    assert.equal(result.remote_mutations, 0);
  }
});

test('status exposes bounded metadata and no retained finding text', async () => {
  const result = await main(['status', '--state-dir', 'state'], {
    state: () => ({ status: 'running', sourceCommit: commit, attempts: 2, checkpoint: { private_text: 'do not emit' } }),
  });
  assert.equal(result.attempts, 2);
  assert.equal(result.source_commit, commit);
  assert.equal(JSON.stringify(result).includes('do not emit'), false);
});
