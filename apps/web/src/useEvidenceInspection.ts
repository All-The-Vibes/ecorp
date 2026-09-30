import { useEffect, useMemo, useState } from 'react'
import {
  EvidenceError, evidenceExpired, inspectEvidenceDocument, inspectManifestFile,
  inspectManifestPatch, readEvidenceBytes,
} from './sourceEvidence'
import type {
  ArtifactRequest, EvidenceDocument, EvidenceProblem, EvidenceSource, ManifestFile, TextPreview,
} from './sourceEvidence'

export type EvidenceViewer = {
  server: string
  corpId: string
  actorId: string
  actorRole: string
  roomId: string
  missionId: string
}
type View = { identity: string; request: ArtifactRequest }
type Load =
  | { view: View; status: 'loading' }
  | { view: View; status: 'ready'; document: EvidenceDocument }
  | { view: View; status: 'error'; problem: EvidenceProblem }
type ReadIntent = {
  view: View; source: EvidenceSource; corpId: string; actorId: string; request: ArtifactRequest
}
type Selection = {
  view: View; document: EvidenceDocument; title: string
  target: { file: ManifestFile } | { patch: { content: string; sha256: string } }
}
type Preview =
  | { selection: Selection; status: 'loading' }
  | { selection: Selection; status: 'ready'; preview: TextPreview }
  | { selection: Selection; status: 'error'; problem: EvidenceProblem }
export type InspectionInput = {
  viewer: EvidenceViewer
  source: EvidenceSource | null
  available: boolean
  request: ArtifactRequest
}

/** User-triggered reads only. Scope transitions and late responses never select new evidence. */
export function useEvidenceInspection({ viewer, source, available, request }: InspectionInput) {
  const allowed = available && ['owner', 'admin', 'manager', 'member'].includes(viewer.actorRole) &&
    [viewer.server, viewer.corpId, viewer.actorId, viewer.roomId, viewer.missionId].every(Boolean)
  const identity = JSON.stringify([viewer, source, allowed])
  // Object identity fences A -> B -> A transitions even before effect cleanup.
  const view = useMemo(() => ({ identity, request }), [identity, request])
  const [intent, setIntent] = useState<ReadIntent | null>(null)
  const [load, setLoad] = useState<Load | null>(null)
  const [selection, setSelection] = useState<Selection | null>(null)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [clock, setClock] = useState(Date.now)
  const retention = source?.retentionUntil ?? null

  useEffect(() => {
    let expiry: ReturnType<typeof setTimeout> | undefined
    const schedule = () => {
      setClock(Date.now())
      if (retention === null) return
      const remaining = Date.parse(retention) - Date.now()
      if (remaining <= 0) return
      // Browser timers cap at roughly 24 days; a longer lease needs another one-shot.
      expiry = setTimeout(schedule, Math.min(remaining, 2_147_483_647))
    }
    const synchronize = setTimeout(schedule, 0)
    return () => { clearTimeout(synchronize); clearTimeout(expiry) }
  }, [view, retention])

  useEffect(() => {
    if (!intent || intent.view !== view) return
    let active = true
    const controller = new AbortController()
    const timeout = setTimeout(() => {
      controller.abort()
      if (active) setLoad({ view, status: 'error', problem: 'unavailable' })
    }, 15_000)
    void readEvidenceBytes(intent.source, intent.corpId, intent.actorId, intent.request,
      controller.signal, Date.now()).then((bytes) => {
      if (!active || controller.signal.aborted) return
      if (evidenceExpired(intent.source, Date.now())) throw new EvidenceError('expired')
      const document = inspectEvidenceDocument(intent.source, bytes)
      setLoad({ view, status: 'ready', document })
    }).catch((error: unknown) => {
      if (active && !controller.signal.aborted) {
        setLoad({ view, status: 'error', problem: error instanceof EvidenceError ? error.problem : 'unavailable' })
      }
    }).finally(() => clearTimeout(timeout))
    return () => { active = false; controller.abort(); clearTimeout(timeout) }
  }, [intent, view])

  useEffect(() => {
    if (!selection || selection.view !== view) return
    let active = true
    const read = 'file' in selection.target
      ? inspectManifestFile(selection.target.file) : inspectManifestPatch(selection.target.patch)
    void read.then((value) => {
      if (active) setPreview({ selection, status: 'ready', preview: value })
    }).catch((error: unknown) => {
      if (active) setPreview({ selection, status: 'error', problem: error instanceof EvidenceError ? error.problem : 'unavailable' })
    })
    return () => { active = false }
  }, [selection, view])

  const expired = source !== null && evidenceExpired(source, clock)
  const current = load?.view === view ? load : null
  const state = !allowed || !source ? { status: 'disabled' as const }
    : expired ? { status: 'error' as const, problem: 'expired' as const }
      : current ?? { status: 'idle' as const }
  const document = state.status === 'ready' ? state.document : null
  const currentPreview = selection?.view === view && selection.document === document &&
    preview?.selection === selection ? preview : null
  const close = () => { setIntent(null); setLoad(null); setSelection(null); setPreview(null) }
  const open = () => {
    if (!allowed || !source) return
    setSelection(null); setPreview(null)
    if (evidenceExpired(source, Date.now())) {
      setIntent(null); setLoad({ view, status: 'error', problem: 'expired' }); return
    }
    setLoad({ view, status: 'loading' })
    setIntent({ view, source, corpId: viewer.corpId, actorId: viewer.actorId, request })
  }
  const inspect = (file?: ManifestFile) => {
    if (!source || !allowed || document?.kind !== 'manifest') return
    if (evidenceExpired(source, Date.now())) {
      setLoad({ view, status: 'error', problem: 'expired' }); return
    }
    if (file ? !document.files.includes(file) : !document.patch) return
    const next: Selection = {
      view, document, title: file ? file.path : 'Source diff',
      target: file ? { file } : { patch: document.patch! },
    }
    setSelection(next); setPreview({ selection: next, status: 'loading' })
  }
  return { state, preview: currentPreview, open, close, inspect }
}
