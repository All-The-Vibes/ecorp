import assert from 'node:assert/strict'
import test from 'node:test'
import { authorityBinding, authorityEndpoint, validAuthorityId } from './factoryAuthority.ts'

const id = '00000000-0000-4000-8000-000000000161'
const corp = { id: 'corp', claim_authority_id: id }
test('authority endpoint never displays credentials, query or fragment', () => {
  assert.equal(authorityEndpoint('https://user:secret@example.com/path?token=secret#secret'), 'https://example.com')
  assert.equal(authorityEndpoint('file:///private'), 'Unavailable')
  assert.equal(authorityEndpoint('not a url'), 'Unavailable')
})
test('missing, nil, malformed and mismatched authority stays unverified', () => {
  for (const value of [undefined, null, '', 42, '00000000-0000-0000-0000-000000000000']) assert.equal(validAuthorityId(value), false)
  assert.match(authorityBinding({ id: 'corp' }, id), /unavailable/)
  assert.match(authorityBinding(corp, undefined), /Unpinned/)
  assert.match(authorityBinding(corp, undefined, false), /No work item selected/)
  assert.match(authorityBinding(corp, null), /mismatch/)
  assert.match(authorityBinding(corp, '00000000-0000-4000-8000-000000000162'), /mismatch/)
  assert.match(authorityBinding(corp, id), /pinned to this Corp/)
})
