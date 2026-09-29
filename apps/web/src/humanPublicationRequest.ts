import type { MissionOriginApi } from './missionOriginContext.ts'
import type { MissionResultDeliverable, MissionResultScope } from './missionResultContext.ts'

export type HumanPublicationPreview = Readonly<{
  plan: Readonly<{
    source_deliverable_id: string
    target_repository: string
    base_ref: string
    branch: string
    title: string
    body: string
  }>
  commit_sha: string
  artifact_sha256: string
  verification_sha256: string
  source_revision: string
  fingerprint: string
}>

export type HumanPublicationRequestView = Readonly<{
  phase: 'idle' | 'previewing' | 'ready' | 'submitting' | 'saved' | 'unavailable' | 'unconfirmed'
  preview: HumanPublicationPreview | null
}>

export const idlePublicationRequest: HumanPublicationRequestView = Object.freeze({ phase: 'idle', preview: null })

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function line(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max &&
    value.trim() === value && [...value].every((character) => allowedCharacter(character))
}

function allowedCharacter(character: string, multiline = false): boolean {
  const code = character.charCodeAt(0)
  return (code > 0x1f && (code < 0x7f || code > 0x9f)) ||
    (multiline && [9, 10, 13].includes(code))
}

function sameHash(value: unknown, expected: string): value is string {
  return typeof value === 'string' && value.toLowerCase() === expected
}

export function readHumanPublicationPreview(
  value: unknown, scope: MissionResultScope, source: MissionResultDeliverable,
): HumanPublicationPreview {
  if (!record(value) || !record(value.plan)) throw new Error('Invalid publication preview')
  const plan = value.plan
  if (plan.source_deliverable_id !== source.id ||
    typeof plan.target_repository !== 'string' ||
    plan.target_repository.toLowerCase() !== scope.sourceRepository.toLowerCase() ||
    !line(plan.base_ref, 240) || !line(plan.branch, 500) || plan.branch === plan.base_ref ||
    !line(plan.title, 256) || typeof plan.body !== 'string' || plan.body.length === 0 ||
    new TextEncoder().encode(plan.body).byteLength > 65_536 ||
    ![...plan.body].every((character) => allowedCharacter(character, true)) ||
    !sameHash(value.commit_sha, source.head_commit) ||
    !sameHash(value.artifact_sha256, source.sha256) ||
    !sameHash(value.verification_sha256, source.verification_sha256) ||
    !line(value.source_revision, 500) || typeof value.fingerprint !== 'string' ||
    value.fingerprint.length !== 64 || /[^a-f0-9]/.test(value.fingerprint)) {
    throw new Error('Publication preview does not match the selected source')
  }
  // Preserve every exact plan field for submission, but retain no additional
  // response properties, authorization snapshots or publisher credentials.
  return Object.freeze({
    plan: Object.freeze({
      source_deliverable_id: source.id, target_repository: plan.target_repository,
      base_ref: plan.base_ref, branch: plan.branch, title: plan.title, body: plan.body,
    }),
    commit_sha: value.commit_sha, artifact_sha256: value.artifact_sha256,
    verification_sha256: value.verification_sha256,
    source_revision: value.source_revision, fingerprint: value.fingerprint,
  })
}

function assertSavedRequest(
  value: unknown, scope: MissionResultScope, source: MissionResultDeliverable, preview: HumanPublicationPreview,
) {
  if (!record(value) || !record(value.publication) || value.publisher_token !== null) {
    throw new Error('Publication request confirmation is unavailable')
  }
  const publication = value.publication
  if (!line(publication.id, 128) || publication.corp_id !== scope.corpId ||
    publication.mission_id !== scope.missionId || publication.factory_work_item_id !== scope.workItemId ||
    publication.source_deliverable_id !== source.id || publication.task_id !== source.task_id ||
    publication.run_id !== source.run_id || publication.artifact_id !== source.artifact_id ||
    publication.target_repository !== preview.plan.target_repository || publication.base_ref !== preview.plan.base_ref ||
    publication.branch !== preview.plan.branch || !sameHash(publication.commit_sha, source.head_commit) ||
    publication.title !== preview.plan.title || publication.body !== preview.plan.body ||
    !['requested', 'publishing', 'branch_pushed', 'pull_request_created', 'published'].includes(String(publication.state))) {
    throw new Error('Publication request confirmation does not match this result')
  }
}

type Timer = ReturnType<typeof globalThis.setTimeout>
type Timers = {
  setTimeout: (callback: () => void, delay: number) => Timer
  clearTimeout: (timer: Timer) => void
}
const nativeTimers: Timers = {
  setTimeout: (callback, delay) => globalThis.setTimeout(callback, delay),
  clearTimeout: (timer) => globalThis.clearTimeout(timer),
}

/** Explicit human actions only. A controller belongs to one exact view/source. */
export function humanPublicationRequest(
  scope: MissionResultScope,
  source: MissionResultDeliverable,
  api: MissionOriginApi,
  publish: (view: HumanPublicationRequestView) => void,
  onSaved: () => void,
  timers: Timers = nativeTimers,
) {
  let alive = true
  let sequence = 0
  let view = idlePublicationRequest
  let pending: { kind: 'preview' | 'request'; controller: AbortController; timer: Timer } | null = null
  const path = `/api/corps/${encodeURIComponent(scope.corpId)}/factory/work-items/${encodeURIComponent(scope.workItemId)}/publication`
  const show = (phase: HumanPublicationRequestView['phase'], preview: HumanPublicationPreview | null = null) => {
    view = Object.freeze({ phase, preview })
    publish(view)
  }
  const send = (kind: 'preview' | 'request', payload: unknown, accept: (value: unknown) => void) => {
    const current = ++sequence
    const controller = new AbortController()
    const timer = timers.setTimeout(() => {
      if (!alive || current !== sequence) return
      sequence++
      pending = null
      show(kind === 'preview' ? 'unavailable' : 'unconfirmed')
      if (kind === 'preview') controller.abort()
    }, 15_000)
    pending = { kind, controller, timer }
    // Begin an explicit request before returning to the caller. A view may
    // detach immediately afterward; that must not suppress saved intent.
    void (async () => api(`${path}/${kind}`, {
      method: 'POST', cache: 'no-store', body: JSON.stringify(payload),
      ...(kind === 'preview' ? { signal: controller.signal } : {}),
    }))().then((value) => {
      if (!alive || current !== sequence) return
      timers.clearTimeout(timer)
      pending = null
      accept(value)
    }).catch(() => {
      if (!alive || current !== sequence) return
      timers.clearTimeout(timer)
      pending = null
      // Never render native error bodies or retry an uncertain mutation.
      show(kind === 'preview' ? 'unavailable' : 'unconfirmed')
    })
  }
  publish(view)
  return {
    preview() {
      if (!alive || pending || !['idle', 'ready', 'unavailable'].includes(view.phase)) return
      show('previewing')
      send('preview', { actor_id: scope.actorId, source_deliverable_id: source.id }, (value) => {
        show('ready', readHumanPublicationPreview(value, scope, source))
      })
    },
    submit() {
      if (!alive || pending || view.phase !== 'ready' || !view.preview) return
      const preview = view.preview
      show('submitting', preview)
      send('request', { actor_id: scope.actorId, preview }, (value) => {
        assertSavedRequest(value, scope, source, preview)
        show('saved')
        onSaved()
      })
    },
    dispose() {
      alive = false
      sequence++
      if (pending) {
        timers.clearTimeout(pending.timer)
        if (pending.kind === 'preview') pending.controller.abort()
        // Detaching this view never sends a cancellation for a saved intent.
        pending = null
      }
    },
  }
}
