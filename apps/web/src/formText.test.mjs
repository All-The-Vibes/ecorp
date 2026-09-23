import assert from 'node:assert/strict'
import test from 'node:test'
import { commaOrLines, nonEmptyLines } from './formText.ts'

test('line normalization preserves argument boundaries, literal punctuation, and duplicate values', () => {
  assert.deepEqual(nonEmptyLines('  first value  \r\n\n--flag=a,b\n echo one; two \n'), ['first value', '--flag=a,b', 'echo one; two'])
  assert.deepEqual(nonEmptyLines('same\nsame'), ['same', 'same'])
  assert.deepEqual(nonEmptyLines(' \r\n \n '), [])
})

test('role entry supports commas and CRLF without silently deduplicating or authorizing roles', () => {
  assert.deepEqual(commaOrLines('owner, admin\r\n manager\nmember,,owner'), ['owner', 'admin', 'manager', 'member', 'owner'])
  assert.deepEqual(commaOrLines('owner, guest'), ['owner', 'guest'])
  assert.deepEqual(commaOrLines(' ,\r\n '), [])
})
