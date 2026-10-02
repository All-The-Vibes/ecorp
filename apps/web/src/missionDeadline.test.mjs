import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import {
  emptyMissionDeadlineDraft, isMissionDeadlinePolicy, readMissionDeadlineDraft,
  sameDeadlineInstant, sameMissionDeadline, taskDeadlineAt,
} from './missionDeadline.ts'

const now = Date.parse('2026-10-02T12:00:00Z')
const cutoff = now + 600_000
const local = (instant) => {
  const date = new Date(instant)
  const two = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}T${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`
}
const draft = (changes = {}) => ({ ...emptyMissionDeadlineDraft(), deadlineLocal: local(cutoff), ...changes })
const policy = { deadline_at: '2026-10-02T12:10:00Z', reserve: { seconds: 120, task_keys: ['implementation', 'review'] } }

test('an empty draft supplies no default duration or reserve and returns fresh editable state', () => {
  const first = emptyMissionDeadlineDraft()
  first.reserveSeconds = '120'
  assert.equal(emptyMissionDeadlineDraft().reserveSeconds, '')
  assert.deepEqual(readMissionDeadlineDraft(emptyMissionDeadlineDraft(), now), {
    policy: null, error: null, admissionClosesAt: null,
  })
})

test('the selected local wall time becomes one absolute cutoff without a reserve', () => {
  assert.deepEqual(readMissionDeadlineDraft(draft(), now), {
    policy: { deadline_at: new Date(cutoff).toISOString() }, error: null, admissionClosesAt: cutoff,
  })
})

test('calendar overflow and incomplete or timezone-bearing local input are rejected', () => {
  for (const deadlineLocal of ['2026-02-30T12:00', '2026-13-01T12:00', '2026-10-02T24:01',
    '0000-01-01T12:00', '2026-10-02', '2026-10-02T12:10:00Z']) {
    const result = readMissionDeadlineDraft(draft({ deadlineLocal }), 0)
    assert.match(result.error, /valid local date/)
    assert.equal(result.policy, null)
  }
})

test('a DST gap is rejected and the displayed local zone determines the absolute instant', () => {
  const module = new URL('./missionDeadline.ts', import.meta.url).href
  const script = `import { readMissionDeadlineDraft as read } from ${JSON.stringify(module)};
    const draft = (deadlineLocal) => ({ deadlineLocal, reserveSeconds: '', reserveTaskKeys: '' });
    console.log(JSON.stringify([
      read(draft('2026-03-08T02:30:00'), 0),
      read(draft('2026-03-08T03:30:00'), 0),
      read(draft('0099-10-02T12:00:00'), -8640000000000000)
    ]));`
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, TZ: 'America/New_York' }, encoding: 'utf8', timeout: 30_000,
  })
  assert.equal(child.status, 0, child.stderr)
  const [gap, valid, oldYear] = JSON.parse(child.stdout)
  assert.equal(gap.policy, null)
  assert.match(gap.error, /daylight-saving/)
  assert.equal(valid.policy.deadline_at, '2026-03-08T07:30:00.000Z')
  assert.match(oldYear.policy.deadline_at, /^0099-/)
})

test('deadline and earlier-stage cutoff are rechecked at submission time', () => {
  assert.match(readMissionDeadlineDraft(draft(), cutoff).error, /future/)
  const reserve = draft({ reserveSeconds: '120', reserveTaskKeys: 'implementation\nreview' })
  assert.equal(readMissionDeadlineDraft(reserve, cutoff - 120_001).error, null)
  assert.match(readMissionDeadlineDraft(reserve, cutoff - 120_000).error, /leave time/)
  assert.equal(readMissionDeadlineDraft(reserve, cutoff + 1).policy, null)
})

test('a reserve requires explicit seconds and distinct task keys without changing the shared deadline', () => {
  const result = readMissionDeadlineDraft(draft({ reserveSeconds: '120', reserveTaskKeys: ' implementation \r\n\nreview ' }), now)
  assert.equal(result.error, null)
  assert.deepEqual(result.policy, { ...policy, deadline_at: new Date(cutoff).toISOString() })
  assert.equal(result.admissionClosesAt, cutoff - 120_000)
  assert.equal(taskDeadlineAt(result.policy, 'research'), '2026-10-02T12:08:00.000Z')
  assert.equal(taskDeadlineAt(result.policy, 'implementation'), '2026-10-02T12:10:00.000Z')
  assert.equal(taskDeadlineAt(result.policy, 'review'), '2026-10-02T12:10:00.000Z')
})

test('partial, duplicate, fractional, overflowing and already-consumed reserves are rejected', () => {
  const cases = [
    { deadlineLocal: '', reserveSeconds: '120', reserveTaskKeys: 'review' },
    { reserveSeconds: '120' }, { reserveTaskKeys: 'review' },
    ...['0', '-1', '1.5', '1e2', '9007199254740991', '600', '601'].map((reserveSeconds) => ({ reserveSeconds, reserveTaskKeys: 'review' })),
    { reserveSeconds: '120', reserveTaskKeys: 'review\n review' },
    { reserveSeconds: '120', reserveTaskKeys: Array.from({ length: 9 }, (_, index) => `task-${index}`).join('\n') },
  ]
  for (const change of cases) {
    const result = readMissionDeadlineDraft(draft(change), now)
    assert.ok(result.error, JSON.stringify(change))
    assert.equal(result.policy, null)
  }
})

test('deadline echoes compare absolute instants and retain sub-millisecond precision', () => {
  assert.equal(sameMissionDeadline(policy, { ...policy, deadline_at: '2026-10-02T07:10:00.000-05:00' }), true)
  assert.equal(sameDeadlineInstant('2026-10-02T12:10:00.000000001Z', policy.deadline_at), false)
  assert.equal(sameDeadlineInstant('2026-10-02T12:10:00.123456789Z', '2026-10-02T07:10:00.123456789-05:00'), true)
  const precise = { ...policy, deadline_at: '2026-10-02T07:10:00.123456789-05:00' }
  assert.equal(taskDeadlineAt(precise, 'research'), '2026-10-02T12:08:00.123456789Z')
  assert.equal(taskDeadlineAt(precise, 'review'), '2026-10-02T12:10:00.123456789Z')
  assert.equal(sameMissionDeadline(undefined, null), true)
  for (const echoed of [undefined, null, { deadline_at: policy.deadline_at },
    { ...policy, deadline_at: '2026-10-02T12:10:01Z' },
    { ...policy, reserve: { ...policy.reserve, seconds: 121 } },
    { ...policy, reserve: { ...policy.reserve, task_keys: ['review', 'implementation'] } },
    { ...policy, reserve: { ...policy.reserve, task_keys: ['other'] } }]) {
    assert.equal(sameMissionDeadline(policy, echoed), false)
  }
})

test('malformed saved policies remain unknown, while expired policies remain readable', () => {
  assert.equal(isMissionDeadlinePolicy(policy), true)
  assert.equal(isMissionDeadlinePolicy({ deadline_at: '2000-01-01T00:00:00Z' }), true)
  for (const value of [null, {}, { deadline_at: 'tomorrow' }, { deadline_at: '2026-02-30T12:00:00Z' },
    { deadline_at: '2026-10-02T12:10:00' }, { ...policy, duration: 600 },
    { ...policy, reserve: null }, { ...policy, reserve: { seconds: 1.5, task_keys: ['review'] } },
    { ...policy, reserve: { seconds: 120, task_keys: ['review', 'review'] } }]) {
    assert.equal(isMissionDeadlinePolicy(value), false, JSON.stringify(value))
  }
})
