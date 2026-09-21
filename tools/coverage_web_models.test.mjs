import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import { verifyLcov } from './coverage_web_models.mjs'

const root = path.resolve('fixture-repository')
const files = ['apps/web/src/a.ts', 'apps/web/src/b.ts']
function record(file, hits = 2) {
  return `SF:${file}\nFN:1,example\nFNDA:${hits ? 1 : 0},example\nFNF:1\nFNH:${hits ? 1 : 0}\nDA:1,${hits ? 1 : 0}\nDA:2,${hits === 2 ? 1 : 0}\nLF:2\nLH:${hits}\nBRDA:1,0,0,${hits ? 1 : '-'}\nBRF:1\nBRH:${hits ? 1 : 0}\nend_of_record\n`
}

test('uninvoked production modules remain in the coverage denominator with zero hits', () => {
  const result = verifyLcov(record(files[0]) + record(files[1], 0), files, root)
  assert.deepEqual(result.totals.lines, { found: 4, hit: 2, percent: 50 })
  assert.deepEqual(result.totals.functions, { found: 2, hit: 1, percent: 50 })
  assert.deepEqual(result.totals.branches, { found: 2, hit: 1, percent: 50 })
  assert.deepEqual(result.files[1].uncoveredLines, [1, 2])
  assert.deepEqual(result.files[1].uncoveredFunctions, ['example'])
})

test('missing production files cannot produce a passing partial coverage result', () => {
  assert.throws(() => verifyLcov(record(files[0]), files, root), /denominator/)
})

test('duplicate and out-of-scope files cannot inflate the denominator', () => {
  assert.throws(() => verifyLcov(record(files[0]) + record(files[0]), files, root), /denominator/)
  assert.throws(() => verifyLcov(record(files[0]) + record('tools/test.test.mjs'), files, root), /denominator/)
  assert.throws(() => verifyLcov(record(files[0]) + record('../other/b.ts'), files, root), /denominator/)
})

test('missing, duplicate and impossible native counts are rejected', () => {
  const valid = record(files[0]) + record(files[1])
  assert.throws(() => verifyLcov(valid.replace('LF:2\n', ''), files, root), /missing or inconsistent/)
  assert.throws(() => verifyLcov(valid.replace('LH:2', 'LH:3'), files, root), /missing or inconsistent/)
  assert.throws(() => verifyLcov(valid.replace('LF:2', 'LF:2\nLF:2'), files, root), /repeats/)
})

test('truncated records are never accepted as completed coverage evidence', () => {
  assert.throws(() => verifyLcov(record(files[0]).replace('end_of_record', ''), [files[0]], root), /not terminated/)
})

test('zero available branches are reported as not applicable instead of fabricated 100 percent', () => {
  const input = record(files[0]).replace('BRF:1\nBRH:1', 'BRF:0\nBRH:0')
  assert.equal(verifyLcov(input, [files[0]], root).totals.branches.percent, null)
})
