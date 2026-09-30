/** Read-only projections of the existing signed artifact endpoint and schema-1 deliverables. */
export const MAX_EVIDENCE_BYTES = 16 * 1024 * 1024
export const MAX_TEXT_PREVIEW_BYTES = 128 * 1024
export const MAX_MANIFEST_FILES = 10_000
export const MANIFEST_PAGE_SIZE = 40

export type EvidenceRun = {
  id: string
  task_id: string
  source_base_commit: string | null
  workspace_base_commit: string | null
  verification_sha256: string | null
  deliverable_sha256: string | null
  artifact_id: string | null
  artifact_sha256: string | null
  artifact_media_type: string | null
  artifact_signature: string | null
}

export type EvidenceDeliverable = {
  id: string
  task_id: string
  run_id: string
  artifact_id: string
  form: 'commit_branch' | 'patch' | 'archive' | 'typed_artifact_set' | 'review_only_report'
  sha256: string
  media_type: string
  bytes: number
  provenance_signature: string
  verification_sha256: string
  base_commit: string
  head_commit: string | null
  branch: string
  retention_until: string
}

export type EvidenceSource = Readonly<{
  kind: 'provider' | 'source'
  runId: string
  taskId: string
  artifactId: string
  sha256: string
  mediaType: string
  bytes: number | null
  baseCommit: string | null
  verificationSha256: string | null
  retentionUntil: string | null
  form: EvidenceDeliverable['form'] | null
  headCommit: string | null
  branch: string | null
}>

export type EvidenceProblem = 'unavailable' | 'denied' | 'expired' | 'oversize' | 'mismatch' | 'unsupported' | 'binary'
export class EvidenceError extends Error {
  readonly problem: EvidenceProblem
  constructor(problem: EvidenceProblem) {
    super(problem)
    this.problem = problem
  }
}

export type TextPreview =
  | { state: 'text'; text: string; redactedLines: number; escapedControls: number }
  | { state: 'deleted' | 'not-included' | 'sensitive-path' | 'oversize' | 'unsupported' | 'binary' }

export type ManifestFile = Readonly<{
  path: string
  status: string
  mode: string | null
  sha256: string | null
  bytes: number | null
  mediaType: string | null
  content: string | null
}>

export type EvidenceDocument =
  | { kind: 'text'; preview: TextPreview }
  | {
    kind: 'manifest'
    files: readonly ManifestFile[]
    verifiedTree: string | null
    patch: { content: string; sha256: string } | null
  }

export type ArtifactRequest = (path: string, signal: AbortSignal) => Promise<Response>

function fail(problem: EvidenceProblem): never { throw new EvidenceError(problem) }
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function identifier(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value)
}
function digest(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}
function commit(value: unknown): value is string {
  return typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)
}
function size(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
function media(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const type = value.split(';')[0].trim().toLowerCase()
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(type) ? type : null
}
function signature(value: unknown): boolean {
  // The server verifies the HMAC; a browser never receives its signing key.
  return typeof value === 'string' && value.length > 0 && value.length <= 512
}

/** An ambiguous or partially matching record is never a substitute for the selected evidence. */
export function exactRunDeliverable<T extends EvidenceDeliverable>(
  run: EvidenceRun | undefined, deliverables: readonly T[],
): T | undefined {
  if (!run || !identifier(run.id) || !identifier(run.task_id)) return undefined
  const matches = deliverables.filter((item) => item.run_id === run.id)
  if (matches.length !== 1) return undefined
  const item = matches[0]
  const base = run.source_base_commit ?? run.workspace_base_commit
  if (!commit(base) || (run.source_base_commit && run.workspace_base_commit &&
    run.source_base_commit !== run.workspace_base_commit)) return undefined
  return item.task_id === run.task_id && item.base_commit === base &&
    digest(item.sha256) && item.sha256 === run.deliverable_sha256 &&
    digest(item.verification_sha256) && item.verification_sha256 === run.verification_sha256 &&
    identifier(item.id) && identifier(item.artifact_id) && signature(item.provenance_signature) &&
    size(item.bytes) && item.bytes > 0 && media(item.media_type) &&
    ['commit_branch', 'patch', 'archive', 'typed_artifact_set', 'review_only_report'].includes(item.form) &&
    (item.head_commit === null || (commit(item.head_commit) && item.head_commit.length === base.length)) &&
    typeof item.branch === 'string' && item.branch.length > 0 && item.branch.length <= 1024 &&
    Number.isFinite(Date.parse(item.retention_until))
    ? item : undefined
}

export function evidenceSource(run: EvidenceRun, deliverable?: EvidenceDeliverable): EvidenceSource | null {
  if (!identifier(run.id) || !identifier(run.task_id)) return null
  if (deliverable) {
    if (!exactRunDeliverable(run, [deliverable])) return null
    return Object.freeze({
      kind: 'source', runId: run.id, taskId: run.task_id, artifactId: deliverable.artifact_id,
      sha256: deliverable.sha256, mediaType: media(deliverable.media_type)!, bytes: deliverable.bytes,
      baseCommit: deliverable.base_commit, verificationSha256: deliverable.verification_sha256,
      retentionUntil: deliverable.retention_until, form: deliverable.form,
      headCommit: deliverable.head_commit, branch: deliverable.branch,
    })
  }
  if (!identifier(run.artifact_id) || !digest(run.artifact_sha256) ||
    !signature(run.artifact_signature) || !media(run.artifact_media_type)) return null
  return Object.freeze({
    kind: 'provider', runId: run.id, taskId: run.task_id, artifactId: run.artifact_id,
    sha256: run.artifact_sha256, mediaType: media(run.artifact_media_type)!, bytes: null,
    baseCommit: run.source_base_commit ?? run.workspace_base_commit, verificationSha256: run.verification_sha256,
    retentionUntil: null, form: null, headCommit: null, branch: null,
  })
}

export function evidenceExpired(source: EvidenceSource, now: number): boolean {
  return source.retentionUntil !== null && Date.parse(source.retentionUntil) <= now
}

export function evidenceArtifactPath(corpId: string, actorId: string, artifactId: string): string {
  if (![corpId, actorId, artifactId].every(identifier)) return fail('unavailable')
  return '/api/corps/' + corpId + '/artifacts/' + artifactId + '?actor_id=' + actorId
}

export async function evidenceSha256(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** Authenticate in the caller; do not follow artifact URIs, redirects, or runner-host paths. */
export async function readEvidenceBytes(
  source: EvidenceSource, corpId: string, actorId: string, request: ArtifactRequest,
  signal: AbortSignal, now: number,
): Promise<Uint8Array> {
  if (evidenceExpired(source, now)) return fail('expired')
  if (source.bytes !== null && source.bytes > MAX_EVIDENCE_BYTES) return fail('oversize')
  const response = await request(evidenceArtifactPath(corpId, actorId, source.artifactId), signal)
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) return fail('denied')
    if (response.status === 410) return fail('expired')
    return fail('unavailable')
  }
  if (response.redirected || media(response.headers.get('content-type')) !== source.mediaType) return fail('mismatch')
  const lengthHeader = response.headers.get('content-length')
  const length = lengthHeader === null ? null : /^\d+$/.test(lengthHeader) ? Number(lengthHeader) : NaN
  if (length !== null && (!size(length) || length > MAX_EVIDENCE_BYTES)) return fail('oversize')
  if (source.bytes !== null && length !== null && source.bytes !== length) return fail('mismatch')
  if (!response.body) return fail('unavailable')
  const reader = response.body.getReader(), chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      signal.throwIfAborted()
      const next = await reader.read()
      if (next.done) break
      total += next.value.byteLength
      if (total > MAX_EVIDENCE_BYTES) return fail('oversize')
      chunks.push(next.value)
    }
  } finally {
    // Cancel the stream even if it violated the bound. Never print response bodies.
    try { await reader.cancel() } catch { /* Already closed or aborted. */ }
    reader.releaseLock()
  }
  signal.throwIfAborted()
  if ((length !== null && total !== length) || (source.bytes !== null && total !== source.bytes)) return fail('mismatch')
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  if (await evidenceSha256(bytes) !== source.sha256) return fail('mismatch')
  signal.throwIfAborted()
  return bytes
}

function decoded(content: string): Uint8Array {
  // Avoid a repeated-quartet regexp: valid large previews can exhaust regexp stacks.
  if (content.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(content)) return fail('mismatch')
  let binary: string
  try { binary = atob(content) } catch { return fail('mismatch') }
  // Reject noncanonical padding bits instead of silently accepting another encoding.
  if (btoa(binary) !== content) return fail('mismatch')
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

function relativePath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 &&
    // Reject controls deliberately; manifest paths must stay legible and inert.
    // oxlint-disable-next-line no-control-regex
    !/[:\\\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(value) &&
    value.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..')
}

/** Additional display masking, not a replacement for the exporter's sensitive-path policy. */
export function sensitivePreviewPath(path: string): boolean {
  return /(?:^|\/)(?:\.env[^/]*|\.git|\.ssh|\.aws|\.azure|\.kube|\.docker|\.gnupg|\.codex|\.claude|\.config|\.git-credentials|\.npmrc|\.netrc|credentials(?:\.[^/]*)?|secrets(?:\.[^/]*)?|id_rsa|id_ed25519)(?:\/|$)/i.test(path) ||
    /\.(?:pem|key|p12|pfx)$/i.test(path)
}

/** Mask likely credential lines and make invisible controls visible. Original downloads are unchanged. */
export function redactEvidenceText(text: string): Extract<TextPreview, { state: 'text' }> {
  let privateKey = false, redactedLines = 0, escapedControls = 0
  const safe = text.split('\n').map((line) => {
    const start = /-----BEGIN (?:[A-Z ]*PRIVATE KEY|OPENSSH PRIVATE KEY)-----/.test(line)
    const end = /-----END (?:[A-Z ]*PRIVATE KEY|OPENSSH PRIVATE KEY)-----/.test(line)
    const secret = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|authorization|credential|secret|token)["'\s]*[:=]/i.test(line) ||
      /\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_.=-]+/i.test(line) ||
      /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]+)/.test(line) ||
      /\b[a-z][a-z0-9+.-]{0,31}:\/\/[^/\s:@]+:[^/\s@]+@/i.test(line)
    const hide = privateKey || start || end || secret
    privateKey = (privateKey || start) && !end
    if (hide) { redactedLines++; return '[redacted: possible credential material]' }
    // Show otherwise invisible controls as text instead of letting them alter the display.
    // oxlint-disable-next-line no-control-regex
    return line.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, (character) => {
      escapedControls++
      return '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0')
    })
  }).join('\n')
  return { state: 'text', text: safe, redactedLines, escapedControls }
}

export function textEvidencePreview(bytes: Uint8Array, mediaType: string): TextPreview {
  if (bytes.byteLength > MAX_TEXT_PREVIEW_BYTES) return { state: 'oversize' }
  if (!/^(?:text\/|application\/(?:json|xml|javascript|[a-z0-9!#$&^_.+-]+\+json)$|image\/svg\+xml$)/.test(mediaType)) {
    return { state: mediaType.startsWith('image/') || ['application/pdf', 'application/octet-stream'].includes(mediaType) ? 'binary' : 'unsupported' }
  }
  let text: string
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { return { state: 'binary' } }
  if (text.includes('\0')) return { state: 'binary' }
  return redactEvidenceText(text)
}

function canonicalTree(document: Record<string, unknown>, source: EvidenceSource): string | null {
  const identity = document.source_verification
  if (identity === undefined && document.verified_tree === undefined) return null
  if (!record(identity) ||
    Object.keys(identity).sort().join('|') !== 'base_commit|candidate_commit|ignored_input_bytes|ignored_input_count|ignored_input_sha256|tree' ||
    !commit(identity.tree) || identity.tree !== document.verified_tree ||
    identity.base_commit !== source.baseCommit || !commit(identity.candidate_commit) ||
    identity.tree.length !== source.baseCommit?.length || identity.tree.length !== identity.candidate_commit.length ||
    !digest(identity.ignored_input_sha256) || !size(identity.ignored_input_count) || identity.ignored_input_count > 100_000 ||
    !size(identity.ignored_input_bytes) || identity.ignored_input_bytes > 4 * 1024 * 1024 * 1024) return fail('mismatch')
  return identity.tree
}

/** Parse only the runner's existing envelope. Bundles and archive paths are never executed or extracted. */
export function inspectEvidenceDocument(source: EvidenceSource, bytes: Uint8Array): EvidenceDocument {
  if (bytes.byteLength > MAX_EVIDENCE_BYTES) return fail('oversize')
  if (source.kind === 'provider' || source.form === 'patch') {
    return { kind: 'text', preview: textEvidencePreview(bytes, source.mediaType) }
  }
  if (source.mediaType !== 'application/vnd.ecorp.deliverable+json') return fail('unsupported')
  let document: unknown
  try { document = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch { return fail('mismatch') }
  if (!record(document)) return fail('mismatch')
  if (document.schema_version !== 1) return fail('unsupported')
  if (document.form !== source.form || document.base_commit !== source.baseCommit ||
    document.head_commit !== source.headCommit || document.branch !== source.branch ||
    document.verification_sha256 !== source.verificationSha256 || !Array.isArray(document.changes)) return fail('mismatch')
  if (document.changes.length > MAX_MANIFEST_FILES) return fail('oversize')
  const tree = canonicalTree(document, source), paths = new Set<string>()
  const files = document.changes.map((entry): ManifestFile => {
    if (!record(entry) || !relativePath(entry.path) || paths.has(entry.path) ||
      typeof entry.status !== 'string' || !/^(?:[AMDTUXB]|[RC]\d{0,3})$/.test(entry.status)) return fail('mismatch')
    paths.add(entry.path)
    if (entry.status === 'D') {
      if ([entry.mode, entry.sha256, entry.bytes, entry.media_type, entry.content_base64].some((value) => value !== null)) return fail('mismatch')
    } else if (!['100644', '100755'].includes(entry.mode as string) || !digest(entry.sha256) ||
      !size(entry.bytes) || !media(entry.media_type) ||
      (entry.content_base64 !== null && typeof entry.content_base64 !== 'string')) return fail('mismatch')
    return Object.freeze({
      path: entry.path, status: entry.status, mode: entry.mode as string | null,
      sha256: entry.sha256 as string | null, bytes: entry.bytes as number | null,
      mediaType: media(entry.media_type), content: entry.content_base64 as string | null,
    })
  })
  if (!digest(document.patch_sha256) ||
    (document.patch_base64 !== null && typeof document.patch_base64 !== 'string')) return fail('mismatch')
  return {
    kind: 'manifest', files, verifiedTree: tree,
    patch: document.patch_base64 === null ? null : { content: document.patch_base64 as string, sha256: document.patch_sha256 },
  }
}

export async function inspectManifestFile(file: ManifestFile): Promise<TextPreview> {
  if (file.status === 'D') return { state: 'deleted' }
  if (sensitivePreviewPath(file.path)) return { state: 'sensitive-path' }
  if (file.content === null) return { state: 'not-included' }
  if (file.bytes! > MAX_TEXT_PREVIEW_BYTES) return { state: 'oversize' }
  // Bound the encoded string before decoding even if an envelope lies about its byte count.
  if (file.content.length > Math.ceil(MAX_TEXT_PREVIEW_BYTES / 3) * 4) return fail('mismatch')
  const bytes = decoded(file.content)
  if (bytes.byteLength !== file.bytes || await evidenceSha256(bytes) !== file.sha256) return fail('mismatch')
  return textEvidencePreview(bytes, file.mediaType!)
}

export async function inspectManifestPatch(patch: { content: string; sha256: string }): Promise<TextPreview> {
  if (patch.content.length > Math.ceil(MAX_TEXT_PREVIEW_BYTES / 3) * 4) return { state: 'oversize' }
  const bytes = decoded(patch.content)
  if (await evidenceSha256(bytes) !== patch.sha256) return fail('mismatch')
  return textEvidencePreview(bytes, 'text/x-diff')
}

export function manifestPage(files: readonly ManifestFile[], query: string, requestedPage: number) {
  const search = query.slice(0, 256).trim().toLowerCase()
  const matches = files.filter((file) => file.path.toLowerCase().includes(search))
  const pages = Math.max(1, Math.ceil(matches.length / MANIFEST_PAGE_SIZE))
  const page = Number.isSafeInteger(requestedPage) ? Math.max(0, Math.min(pages - 1, requestedPage)) : 0
  return { files: matches.slice(page * MANIFEST_PAGE_SIZE, (page + 1) * MANIFEST_PAGE_SIZE), page, pages, matches: matches.length }
}
