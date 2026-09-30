import { useState } from 'react'
import { manifestPage } from './sourceEvidence'
import type { EvidenceProblem, TextPreview } from './sourceEvidence'
import { useEvidenceInspection } from './useEvidenceInspection'
import type { InspectionInput } from './useEvidenceInspection'
import './EvidenceInspector.css'

const problemText: Record<EvidenceProblem, string> = {
  unavailable: 'Evidence could not be read. Confirm the connection and current access, then try again.',
  denied: 'The server denied access to this evidence.',
  expired: 'Evidence retention has expired. A new authorized result is required.',
  oversize: 'Evidence exceeds the 16 MiB inspection limit. Use the existing authorized download if available.',
  mismatch: 'Evidence does not match the selected run, recorded hash or source identity. The preview is withheld.',
  unsupported: 'This evidence format or version is not supported for inspection. Use the existing authorized download.',
  binary: 'Binary evidence has no text preview. Use the existing authorized download.',
}
const previewText = {
  deleted: 'This file was deleted. Its previous contents are not part of this deliverable.',
  'not-included': 'This report records the file but does not include its contents.',
  'sensitive-path': 'Preview withheld for a potentially sensitive path.',
  oversize: 'Text preview exceeds 128 KiB. Use the existing authorized download for the original bytes.',
  unsupported: 'This file type has no supported text preview. Use the existing authorized download.',
  binary: 'Binary or non-UTF-8 content has no text preview. Use the existing authorized download.',
}

function InertPreview({ preview, title }: { preview: TextPreview; title: string }) {
  if (preview.state !== 'text') return <p role="status">{previewText[preview.state]}</p>
  return <>
    {preview.redactedLines > 0 ? <p className="evidence-preview-notice">
      {preview.redactedLines} line{preview.redactedLines === 1 ? '' : 's'} masked as possible credentials.
      {' '}Display masking is not a full secret scan; downloaded evidence is unchanged.
    </p> : null}
    {preview.escapedControls > 0 ? <p className="evidence-preview-notice">
      {preview.escapedControls} invisible control character{preview.escapedControls === 1 ? '' : 's'} shown as escapes.
    </p> : null}
    <pre className="evidence-text-preview" role="region" aria-label={title} tabIndex={0}>{preview.text}</pre>
  </>
}

function InspectionView(input: InspectionInput) {
  const { source } = input
  const inspection = useEvidenceInspection(input)
  const [query, setQuery] = useState('')
  const [pageNumber, setPageNumber] = useState(0)
  const label = source?.kind === 'source' ? 'source changes' : 'provider output'
  const document = inspection.state.status === 'ready' ? inspection.state.document : null
  const page = document?.kind === 'manifest' ? manifestPage(document.files, query, pageNumber) : null
  const titleId = 'inspect-' + (source?.kind ?? 'unknown') + '-' + (source?.artifactId ?? 'missing')
  return <section className="evidence-inspector" id={titleId} aria-label={'Inspect ' + label}
    data-testid={'inspect-' + (source?.kind ?? 'unknown')} data-inspection-state={inspection.state.status}
    data-run-id={source?.runId} data-artifact-id={source?.artifactId} data-artifact-sha256={source?.sha256}>
    <div className="evidence-inspector-actions">
      <button type="button" className="button button-secondary" onClick={inspection.open}
        disabled={inspection.state.status === 'loading' || inspection.state.status === 'disabled' ||
          (inspection.state.status === 'error' && inspection.state.problem === 'expired')}>
        {document ? 'Reload ' : 'Inspect '}{label}
      </button>
      {inspection.state.status !== 'idle' && inspection.state.status !== 'disabled' ? (
        <button type="button" className="button button-secondary" onClick={inspection.close}>
          {inspection.state.status === 'loading' ? 'Cancel inspection' : 'Close inspection'}
        </button>
      ) : null}
    </div>
    {inspection.state.status === 'disabled' ? <p role="status">
      Inspection is unavailable until current access and connection are confirmed.
    </p> : null}
    {inspection.state.status === 'loading' ? <p role="status">Reading and checking the selected evidence…</p> : null}
    {inspection.state.status === 'error' ? <p role="alert">{problemText[inspection.state.problem]}</p> : null}
    {document && source ? <>
      <p role="status">Artifact SHA-256 matches this selected run. Inspection does not record an outcome decision.</p>
      <details className="evidence-identity">
        <summary>Exact evidence identity</summary>
        <dl>
          <div><dt>Run</dt><dd>{source.runId}</dd></div>
          <div><dt>Task</dt><dd>{source.taskId}</dd></div>
          <div><dt>Artifact</dt><dd>{source.artifactId}</dd></div>
          <div><dt>Artifact SHA-256</dt><dd>{source.sha256}</dd></div>
          <div><dt>Verification SHA-256</dt><dd>{source.verificationSha256 ?? 'Not recorded'}</dd></div>
          <div><dt>Base commit</dt><dd>{source.baseCommit ?? 'Not recorded'}</dd></div>
          {source.kind === 'source' ? <>
            <div><dt>Head commit</dt><dd>{source.headCommit ?? 'No committed head recorded'}</dd></div>
            <div><dt>Branch</dt><dd>{source.branch}</dd></div>
            <div><dt>Retention ends</dt><dd>{source.retentionUntil}</dd></div>
          </> : null}
          {document.kind === 'manifest' ? <div><dt>Verified source tree</dt>
            <dd>{document.verifiedTree ?? 'Canonical source identity was not recorded in this historical deliverable.'}</dd>
          </div> : null}
        </dl>
      </details>
      {document.kind === 'text' ? <InertPreview preview={document.preview} title={'Selected ' + label} /> : null}
      {document.kind === 'manifest' && page ? <>
        <div className="evidence-manifest-heading">
          <strong>{document.files.length.toLocaleString()} changed file{document.files.length === 1 ? '' : 's'}</strong>
          {document.patch ? <button type="button" className="button button-secondary"
            onClick={() => inspection.inspect()}>Inspect source diff</button>
            : <p>Diff contents were not included with this report.</p>}
        </div>
        <label className="evidence-manifest-search">Search changed files
          <input type="search" value={query} maxLength={256}
            onChange={(event) => { setQuery(event.target.value); setPageNumber(0) }} />
        </label>
        <p role="status">{page.matches.toLocaleString()} matching file{page.matches === 1 ? '' : 's'} · Page {page.page + 1} of {page.pages}</p>
        <ul className="evidence-manifest" aria-label="Changed files">
          {page.files.map((file) => <li key={file.path}>
            <button type="button" className="evidence-file" onClick={() => inspection.inspect(file)}
              aria-pressed={inspection.preview?.selection.title === file.path}>
              <span className="evidence-file-status" aria-label={'Change status ' + file.status}>{file.status}</span>
              <span className="evidence-file-path">{file.path}</span>
              <span className="evidence-file-bytes">{file.bytes === null ? 'Deleted' : file.bytes.toLocaleString() + ' bytes'}</span>
            </button>
          </li>)}
        </ul>
        <nav className="evidence-inspector-actions" aria-label="Changed file pages">
          <button type="button" className="button button-secondary" disabled={page.page === 0}
            onClick={() => setPageNumber(page.page - 1)}>Previous files</button>
          <button type="button" className="button button-secondary" disabled={page.page + 1 >= page.pages}
            onClick={() => setPageNumber(page.page + 1)}>Next files</button>
        </nav>
        {inspection.preview ? <div className="evidence-file-preview">
          <h4>{inspection.preview.selection.title}</h4>
          {'file' in inspection.preview.selection.target ? <p className="evidence-file-hash">
            SHA-256: {inspection.preview.selection.target.file.sha256 ?? 'No contents for a deleted file'}
          </p> : <p className="evidence-file-hash">SHA-256: {inspection.preview.selection.target.patch.sha256}</p>}
          {inspection.preview.status === 'loading' ? <p role="status">Checking preview bytes…</p>
            : inspection.preview.status === 'error' ? <p role="alert">{problemText[inspection.preview.problem]}</p>
              : <InertPreview preview={inspection.preview.preview} title={inspection.preview.selection.title} />}
        </div> : null}
      </> : null}
    </> : null}
  </section>
}

export function EvidenceInspector(input: InspectionInput) {
  // Remounting also discards the in-memory document when viewer, access or source changes.
  return <InspectionView key={JSON.stringify([input.viewer, input.source, input.available])} {...input} />
}
