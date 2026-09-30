import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import {
  EvidenceError, MAX_EVIDENCE_BYTES, MAX_TEXT_PREVIEW_BYTES, MAX_MANIFEST_FILES,
  MANIFEST_PAGE_SIZE, exactRunDeliverable, evidenceSource, evidenceExpired,
  evidenceArtifactPath, evidenceSha256, readEvidenceBytes, inspectEvidenceDocument,
  inspectManifestFile, inspectManifestPatch, sensitivePreviewPath, redactEvidenceText,
  textEvidencePreview, manifestPage,
} from './sourceEvidence.ts'

// Synthetic schema-1 exporter records. Native acceptance separately covers signed storage.
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const encode = (value) => new TextEncoder().encode(value)
const base = 'a'.repeat(40), head = 'b'.repeat(40), tree = 'c'.repeat(40)
const verification = 'd'.repeat(64)
const now = Date.parse('2026-09-29T00:00:00Z')
const content = encode('<script>window.fixtureExecuted = true</script>\nhello world\n')
const patchBytes = encode('diff --git a/readme.md b/readme.md\n+hello world\n')
const file = {
  path: 'docs/readme.md', status: 'A', mode: '100644', sha256: hash(content),
  bytes: content.byteLength, media_type: 'text/plain', content_base64: Buffer.from(content).toString('base64'),
}
const deleted = {
  path: 'removed.txt', status: 'D', mode: null, sha256: null, bytes: null,
  media_type: null, content_base64: null,
}
function envelope(overrides = {}) {
  return {
    schema_version: 1, form: 'archive', base_commit: base, head_commit: head, branch: 'crony/source',
    verification_sha256: verification, verified_tree: tree,
    source_verification: {
      tree, base_commit: base, candidate_commit: base, ignored_input_sha256: hash(''),
      ignored_input_count: 0, ignored_input_bytes: 0,
    },
    patch_sha256: hash(patchBytes), patch_base64: Buffer.from(patchBytes).toString('base64'),
    git_bundle_sha256: null, git_bundle_base64: null, changes: [file, deleted], ...overrides,
  }
}
function fixture(document = envelope()) {
  const bytes = encode(JSON.stringify(document))
  const deliverable = {
    id: 'deliverable-a', task_id: 'task-a', run_id: 'run-a', artifact_id: 'source-a',
    form: 'archive', sha256: hash(bytes), media_type: 'application/vnd.ecorp.deliverable+json',
    bytes: bytes.byteLength, provenance_signature: 'server-verified-fixture-signature',
    verification_sha256: verification, base_commit: base, head_commit: head,
    branch: 'crony/source', retention_until: '2026-10-01T00:00:00Z',
  }
  const run = {
    id: 'run-a', task_id: 'task-a', source_base_commit: base, workspace_base_commit: base,
    verification_sha256: verification, deliverable_sha256: deliverable.sha256,
    artifact_id: 'provider-a', artifact_sha256: hash(content),
    artifact_media_type: 'text/plain', artifact_signature: 'server-verified-fixture-signature',
  }
  return { bytes, deliverable, run, source: evidenceSource(run, deliverable) }
}
const problem = (kind) => (error) => error instanceof EvidenceError && error.problem === kind
const parse = (document, source = fixture().source) => inspectEvidenceDocument(source, encode(JSON.stringify(document)))

test('source selection joins one exact run, task, base, artifact digest and verifier digest', () => {
  const { run, deliverable, source } = fixture()
  assert.equal(exactRunDeliverable(run, [deliverable]), deliverable)
  assert.equal(exactRunDeliverable(run, [{ ...deliverable, run_id: 'other' }, deliverable]), deliverable)
  assert.equal(exactRunDeliverable(run, [deliverable, { ...deliverable }]), undefined)
  assert.equal(exactRunDeliverable(undefined, [deliverable]), undefined)
  assert.equal(exactRunDeliverable(run, []), undefined)
  assert.equal(exactRunDeliverable({ ...run, source_base_commit: null }, [deliverable]), deliverable)
  assert.equal(exactRunDeliverable({ ...run, workspace_base_commit: null }, [deliverable]), deliverable)
  assert.equal(exactRunDeliverable(run, [{ ...deliverable, head_commit: null }]).head_commit, null)
  assert.equal(source.kind, 'source')
  assert.equal(source.retentionUntil, deliverable.retention_until)
  assert.ok(Object.isFrozen(source))
  for (const change of [
    { task_id: 'task-b' }, { base_commit: head }, { sha256: 'e'.repeat(64) },
    { verification_sha256: 'f'.repeat(64) }, { artifact_id: '../source' }, { id: '' },
    { provenance_signature: '' }, { bytes: -1 }, { bytes: 0 }, { bytes: 0.5 },
    { media_type: '' }, { form: 'unknown' }, { head_commit: 'b'.repeat(64) },
    { branch: '' }, { branch: 2 }, { retention_until: 'unparseable' },
  ]) {
    assert.equal(exactRunDeliverable(run, [{ ...deliverable, ...change }]), undefined, JSON.stringify(change))
    assert.equal(evidenceSource(run, { ...deliverable, ...change }), null)
  }
  for (const change of [
    { id: '' }, { task_id: 'x/y' }, { source_base_commit: head }, { source_base_commit: null, workspace_base_commit: null },
    { deliverable_sha256: null }, { verification_sha256: null },
  ]) assert.equal(exactRunDeliverable({ ...run, ...change }, [deliverable]), undefined)
})

test('provider output remains a separate descriptor and never follows a supplied URI', () => {
  const { run } = fixture()
  const source = evidenceSource({ ...run, artifact_uri: 'file:///runner/secrets' })
  assert.equal(source.kind, 'provider')
  assert.equal(source.artifactId, 'provider-a')
  assert.equal(source.form, null)
  assert.equal(source.bytes, null)
  assert.equal(source.retentionUntil, null)
  assert.equal(evidenceExpired(source, now), false)
  for (const change of [
    { id: '' }, { task_id: '' }, { artifact_id: null }, { artifact_sha256: 'bad' },
    { artifact_signature: '' }, { artifact_signature: 2 }, { artifact_media_type: null },
    { artifact_media_type: 'text plain' },
  ]) assert.equal(evidenceSource({ ...run, ...change }), null)
  assert.equal(evidenceSource({ ...run, artifact_media_type: 'TEXT/PLAIN; charset=utf-8' }).mediaType, 'text/plain')
  assert.equal(evidenceArtifactPath('corp-a', 'actor-a', source.artifactId),
    '/api/corps/corp-a/artifacts/provider-a?actor_id=actor-a')
  for (const unsafe of ['', '../x', 'x?admin=true', 'https://example.invalid', 'x/y', 'x'.repeat(129)]) {
    for (let index = 0; index < 3; index++) {
      const values = ['corp', 'actor', 'artifact']; values[index] = unsafe
      assert.throws(() => evidenceArtifactPath(...values), problem('unavailable'))
    }
  }
})

test('streaming read checks trusted length, media and SHA-256 before returning any content', async () => {
  const { source, bytes } = fixture()
  const controller = new AbortController(), calls = []
  const request = async (path, signal) => {
    calls.push({ path, signal })
    return new Response(new ReadableStream({
      start(stream) { stream.enqueue(bytes.slice(0, 20)); stream.enqueue(bytes.slice(20)); stream.close() },
    }), { headers: { 'content-type': source.mediaType + '; charset=utf-8', 'content-length': String(bytes.byteLength) } })
  }
  const actual = await readEvidenceBytes(source, 'corp-a', 'actor-a', request, controller.signal, now)
  assert.deepEqual(actual, bytes)
  assert.equal(await evidenceSha256(bytes), source.sha256)
  assert.equal(calls[0].path, '/api/corps/corp-a/artifacts/source-a?actor_id=actor-a')
  assert.equal(calls[0].signal, controller.signal)
  const provider = evidenceSource(fixture().run)
  const output = await readEvidenceBytes(provider, 'corp-a', 'actor-a',
    async () => new Response(content, { headers: { 'content-type': 'text/plain' } }), controller.signal, now)
  assert.deepEqual(output, content)
})

test('expired and known oversize receipts fail before a request', async () => {
  const source = fixture().source
  let calls = 0
  const request = async () => { calls++; throw new Error('unexpected request') }
  for (const [receipt, expected] of [
    [{ ...source, retentionUntil: new Date(now).toISOString() }, 'expired'],
    [{ ...source, bytes: MAX_EVIDENCE_BYTES + 1 }, 'oversize'],
  ]) await assert.rejects(readEvidenceBytes(receipt, 'corp', 'actor', request, new AbortController().signal, now), problem(expected))
  assert.equal(calls, 0)
  assert.equal(evidenceExpired(source, Date.parse(source.retentionUntil) - 1), false)
  assert.equal(evidenceExpired(source, Date.parse(source.retentionUntil)), true)
})

test('artifact failures expose stable categories without reading error bodies', async () => {
  const { source } = fixture()
  for (const [status, expected] of [[401, 'denied'], [403, 'denied'], [410, 'expired'], [404, 'unavailable'], [500, 'unavailable']]) {
    const response = new Response('untrusted server diagnostic', { status })
    await assert.rejects(readEvidenceBytes(source, 'corp', 'actor', async () => response,
      new AbortController().signal, now), problem(expected))
    assert.equal(response.bodyUsed, false)
  }
})

test('redirect, media, length and digest mismatches fail closed', async () => {
  const { source, bytes } = fixture()
  const response = (body = bytes, headers = {}) => new Response(body, {
    headers: { 'content-type': source.mediaType, ...headers },
  })
  const redirected = response()
  Object.defineProperty(redirected, 'redirected', { value: true })
  for (const [value, expected] of [
    [redirected, 'mismatch'],
    [response(bytes, { 'content-type': 'text/html' }), 'mismatch'],
    [response(bytes, { 'content-length': String(bytes.length + 1) }), 'mismatch'],
    [response(bytes, { 'content-length': '-1' }), 'oversize'],
    [response(bytes, { 'content-length': 'NaN' }), 'oversize'],
    [response(bytes, { 'content-length': String(MAX_EVIDENCE_BYTES + 1) }), 'oversize'],
    [response(null), 'unavailable'],
    [response(bytes.slice(1)), 'mismatch'],
    [response(bytes.map((byte, index) => index === 5 ? byte ^ 1 : byte)), 'mismatch'],
  ]) await assert.rejects(readEvidenceBytes(source, 'corp', 'actor', async () => value,
    new AbortController().signal, now), problem(expected))
  const provider = evidenceSource(fixture().run)
  await assert.rejects(readEvidenceBytes(provider, 'corp', 'actor',
    async () => new Response(content, { headers: { 'content-type': 'text/plain', 'content-length': String(content.length + 1) } }),
    new AbortController().signal, now), problem('mismatch'))
})

test('a streamed oversize artifact is cancelled without displaying a prefix', async () => {
  const source = evidenceSource(fixture().run)
  let cancelled = false, step = 0
  const stream = new ReadableStream({
    pull(controller) {
      step++
      controller.enqueue(new Uint8Array(step === 1 ? MAX_EVIDENCE_BYTES : 1))
    },
    cancel() { cancelled = true },
  })
  await assert.rejects(readEvidenceBytes(source, 'corp', 'actor',
    async () => new Response(stream, { headers: { 'content-type': 'text/plain' } }),
    new AbortController().signal, now), problem('oversize'))
  assert.equal(cancelled, true)
})

test('abort and stream errors remain failures even when cancellation also throws', async () => {
  const { source, bytes } = fixture()
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(readEvidenceBytes(source, 'corp', 'actor',
    async () => new Response(bytes, { headers: { 'content-type': source.mediaType } }),
    controller.signal, now), { name: 'AbortError' })
  let released = false
  const failure = new Error('transport failed')
  const response = { ok: true, headers: new Headers({ 'content-type': source.mediaType }), body: {
    getReader: () => ({
      read: async () => { throw failure }, cancel: async () => { throw new Error('already closed') },
      releaseLock: () => { released = true },
    }),
  } }
  await assert.rejects(readEvidenceBytes(source, 'corp', 'actor', async () => response,
    new AbortController().signal, now), (error) => error === failure)
  assert.equal(released, true)
})

test('schema-1 manifests retain canonical identity, deleted records and exact source selection', async () => {
  const { source, bytes } = fixture()
  const result = inspectEvidenceDocument(source, bytes)
  assert.equal(result.kind, 'manifest')
  assert.equal(result.verifiedTree, tree)
  assert.equal(result.files.length, 2)
  assert.ok(Object.isFrozen(result.files[0]))
  assert.equal((await inspectManifestFile(result.files[0])).text, new TextDecoder().decode(content))
  assert.deepEqual(await inspectManifestFile(result.files[1]), { state: 'deleted' })
  assert.equal((await inspectManifestPatch(result.patch)).text, new TextDecoder().decode(patchBytes))
  const legacy = envelope()
  delete legacy.verified_tree; delete legacy.source_verification
  assert.equal(parse(legacy).verifiedTree, null, 'legacy absence must not invent canonical verification')
  assert.equal(parse(envelope({ patch_base64: null })).patch, null)
  assert.equal(inspectEvidenceDocument({ ...source, kind: 'provider', mediaType: 'text/html' }, content).kind, 'text')
  assert.equal(inspectEvidenceDocument({ ...source, form: 'patch', mediaType: 'text/x-diff' }, patchBytes).kind, 'text')
})

test('version, malformed JSON, partial canonical identity and source joins cannot fall back to another run', () => {
  const source = fixture().source
  for (const value of [null, [], 'text', {}, { ...envelope(), schema_version: 2 }]) {
    assert.throws(() => parse(value), problem(value && typeof value === 'object' && !Array.isArray(value) ? 'unsupported' : 'mismatch'))
  }
  for (const value of ['{', '\ufffd', 'true']) assert.throws(() => inspectEvidenceDocument(source, encode(value)), problem('mismatch'))
  assert.throws(() => inspectEvidenceDocument(source, new Uint8Array([255])), problem('mismatch'))
  assert.throws(() => inspectEvidenceDocument(source, new Uint8Array(MAX_EVIDENCE_BYTES + 1)), problem('oversize'))
  assert.throws(() => inspectEvidenceDocument({ ...source, mediaType: 'application/zip' }, encode('{}')), problem('unsupported'))
  for (const change of [
    { form: 'commit_branch' }, { base_commit: head }, { head_commit: null }, { branch: 'other' },
    { verification_sha256: '0'.repeat(64) }, { changes: null }, { patch_sha256: 'bad' },
    { patch_base64: 42 }, { verified_tree: undefined }, { source_verification: undefined },
    { source_verification: null }, { verified_tree: head },
  ]) assert.throws(() => parse(envelope(change)), problem('mismatch'), JSON.stringify(change))
  for (const change of [
    { tree: 'C'.repeat(40) }, { base_commit: head }, { candidate_commit: 'bad' },
    { candidate_commit: 'c'.repeat(64) }, { ignored_input_sha256: '' }, { ignored_input_count: 100001 },
    { ignored_input_count: 0.1 }, { ignored_input_bytes: 4 * 1024 ** 3 + 1 }, { extra: true },
  ]) assert.throws(() => parse(envelope({ source_verification: { ...envelope().source_verification, ...change } })), problem('mismatch'))
})

test('manifest paths, file types, sizes and duplicates are bounded without reading a host path', () => {
  for (const path of ['', '../secret', '/absolute', 'C:/secret', 'a\\b', 'a//b', './a', 'a/\u202eb', 'a\0b', 'x'.repeat(4097)]) {
    assert.throws(() => parse(envelope({ changes: [{ ...file, path }] })), problem('mismatch'))
  }
  for (const entry of [null, [], { ...file, status: 'ZZ' }, { ...file, mode: '120000' },
    { ...file, mode: 100644 }, { ...file, sha256: null }, { ...file, bytes: -1 },
    { ...file, media_type: 'bad' }, { ...file, content_base64: 1 }, { ...deleted, bytes: 0 }]) {
    assert.throws(() => parse(envelope({ changes: [entry] })), problem('mismatch'))
  }
  assert.throws(() => parse(envelope({ changes: [file, { ...file }] })), problem('mismatch'))
  assert.throws(() => parse(envelope({ changes: Array(MAX_MANIFEST_FILES + 1).fill(file) })), problem('oversize'))
  assert.equal(parse(envelope({ changes: [{ ...file, mode: '100755', status: 'R100' }] })).files[0].mode, '100755')
})

test('large manifests remain searchable through bounded pages without truncating the count', () => {
  const changes = Array.from({ length: MAX_MANIFEST_FILES }, (_, index) => ({ ...file, path: 'src/file-' + index + '.txt' }))
  const { files } = parse(envelope({ changes }))
  let page = manifestPage(files, '', 0)
  assert.equal(page.files.length, MANIFEST_PAGE_SIZE)
  assert.equal(page.matches, MAX_MANIFEST_FILES)
  assert.equal(page.pages, MAX_MANIFEST_FILES / MANIFEST_PAGE_SIZE)
  assert.equal(manifestPage(files, '', 9999).page, page.pages - 1)
  assert.equal(manifestPage(files, '', -1).page, 0)
  assert.equal(manifestPage(files, '', NaN).page, 0)
  page = manifestPage(files, ' SRC/FILE-9999.TXT ', 6)
  assert.equal(page.matches, 1)
  assert.equal(page.page, 0)
  assert.equal(page.files[0].path, 'src/file-9999.txt')
  assert.deepEqual(manifestPage(files, 'absent', 3), { files: [], matches: 0, page: 0, pages: 1 })
  assert.equal(manifestPage([], 'a'.repeat(300), 0).files.length, 0)
})

test('file and diff previews verify bytes and canonical base64 before rendering', { timeout: 15_000 }, async () => {
  const entry = parse(envelope()).files[0]
  for (const content of ['%%%%', 'YQ=', 'YQ===AAA', 'Zh==', 'Y Q=', '====']) {
    await assert.rejects(inspectManifestFile({ ...entry, content }), problem('mismatch'), content)
  }
  await assert.rejects(inspectManifestFile({ ...entry, bytes: entry.bytes + 1 }), problem('mismatch'))
  await assert.rejects(inspectManifestFile({ ...entry, sha256: '0'.repeat(64) }), problem('mismatch'))
  await assert.rejects(inspectManifestFile({ ...entry, content: 'A'.repeat(4 * Math.ceil(MAX_TEXT_PREVIEW_BYTES / 3) + 4) }), problem('mismatch'))
  await assert.rejects(inspectManifestPatch({ content: file.content_base64, sha256: '0'.repeat(64) }), problem('mismatch'))
  const large = encode('x'.repeat(MAX_TEXT_PREVIEW_BYTES)), encoded = Buffer.from(large).toString('base64')
  const preview = await inspectManifestFile({ ...entry, bytes: large.length, content: encoded, sha256: hash(large) })
  assert.equal(preview.state, 'text')
  assert.equal(preview.text.length, MAX_TEXT_PREVIEW_BYTES, 'a valid upper-bound preview must not overflow a regexp stack')
  assert.equal((await inspectManifestPatch({ content: encoded, sha256: hash(large) })).state, 'text')
  assert.equal((await inspectManifestPatch({ content: encoded + 'AAAA', sha256: hash(large) })).state, 'oversize')
  assert.equal((await inspectManifestPatch({ content: '', sha256: hash('') })).text, '')
})

test('non-previewable files keep explicit states without extracting archives or bundles', async () => {
  const entry = parse(envelope()).files[0]
  assert.deepEqual(await inspectManifestFile({ ...entry, content: null }), { state: 'not-included' })
  assert.deepEqual(await inspectManifestFile({ ...entry, path: '.env.local' }), { state: 'sensitive-path' })
  assert.deepEqual(await inspectManifestFile({ ...entry, bytes: MAX_TEXT_PREVIEW_BYTES + 1 }), { state: 'oversize' })
  assert.deepEqual(textEvidencePreview(new Uint8Array(MAX_TEXT_PREVIEW_BYTES + 1), 'text/plain'), { state: 'oversize' })
  for (const media of ['image/png', 'application/pdf', 'application/octet-stream']) {
    assert.deepEqual(textEvidencePreview(content, media), { state: 'binary' })
  }
  assert.deepEqual(textEvidencePreview(content, 'application/zip'), { state: 'unsupported' })
  assert.deepEqual(textEvidencePreview(new Uint8Array([0]), 'text/plain'), { state: 'binary' })
  assert.deepEqual(textEvidencePreview(new Uint8Array([255]), 'text/plain'), { state: 'binary' })
  for (const media of ['text/html', 'application/json', 'application/vnd.fixture+json', 'image/svg+xml']) {
    assert.equal(textEvidencePreview(content, media).text, new TextDecoder().decode(content), 'markup stays data for React text rendering')
  }
})

test('preview masking covers likely credentials, private keys and invisible controls without changing hashes', () => {
  const untrusted = [
    'ordinary source', 'const token = "fixture";', 'Authorization: Bearer fixture-value',
    'https://fixture:fixture@example.invalid/path',
    'ghp_' + 'x'.repeat(24), '-----BEGIN PRIVATE KEY-----', 'fixture-key-body', '-----END PRIVATE KEY-----',
    'visible\u001b[31m\u202eend', 'after key block',
  ].join('\n')
  const originalHash = hash(untrusted), result = redactEvidenceText(untrusted)
  assert.equal(result.redactedLines, 7)
  assert.equal(result.escapedControls, 2)
  assert.match(result.text, /ordinary source/)
  assert.match(result.text, /\\u001b\[31m\\u202eend/)
  assert.match(result.text, /after key block/)
  assert.doesNotMatch(result.text, /fixture-key-body|Bearer|fixture-value/)
  assert.equal(hash(untrusted), originalHash, 'display masking must not mutate downloaded evidence')
  for (const path of ['.env', '.env.example', '.git/config', 'a/.aws/config', '.netrc', 'credentials.json', 'a/secrets.yaml', 'a/private.pem']) {
    assert.equal(sensitivePreviewPath(path), true, path)
  }
  for (const path of ['src/sourceEvidence.ts', 'docs/security.md', 'a/credentialsGuide.md']) assert.equal(sensitivePreviewPath(path), false)
})
