import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import type { WorkLink } from './workflowContext'
import {
  causalHistoryFilters, emptyHistoryFilters, HISTORY_ENTITY_STATUSES, HISTORY_KINDS,
  HISTORY_PAGE_SIZE, historyEntryLink, historyPosition, normalizeHistoryFilters, requestHistoryPage,
} from './history'
import type { HistoryFilters, HistoryKind, HistoryLoad, HistoryPosition } from './history'
import './HistoryPanel.css'

type Choice = { id: string; name: string }
type Props = {
  corpId: string
  corpName: string
  actorId: string
  actorName: string
  rooms: readonly Choice[]
  actors: readonly Choice[]
  initialKind?: HistoryKind
  revision: string
  connected: boolean
  api: <T>(path: string, init?: RequestInit) => Promise<T>
  onNavigate: (link: WorkLink) => void
}
type PageStart = { cursor: string | null; after: HistoryPosition | null }
const FIRST_PAGE: PageStart = { cursor: null, after: null }
const nameFor = (choices: readonly Choice[], id: string | null) =>
  id === null ? 'Any' : choices.find((choice) => choice.id === id)?.name ?? id
const date = (value: string) => new Date(value).toLocaleString()

export function HistoryPanel({
  corpId, corpName, actorId, actorName, rooms, actors, initialKind = 'event',
  revision, connected, api, onNavigate,
}: Props) {
  const [draft, setDraft] = useState<HistoryFilters>(() => emptyHistoryFilters(initialKind))
  const [applied, setApplied] = useState<HistoryFilters>(() => emptyHistoryFilters(initialKind))
  const [trail, setTrail] = useState<PageStart[]>([FIRST_PAGE])
  const [refresh, setRefresh] = useState(0)
  const [load, setLoad] = useState<HistoryLoad | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  const results = useRef<HTMLHeadingElement>(null)
  const focusResults = useRef(false)
  const start = trail[trail.length - 1]
  const request = useMemo(() => ({
    corpId, actorId, filters: applied, cursor: start.cursor, after: start.after,
    pageSize: HISTORY_PAGE_SIZE,
  }), [corpId, actorId, applied, start])
  // The authorization revision changes with viewer/room access. Invalidate
  // immediately, without restarting a search for every streamed runner event.
  const key = JSON.stringify([request, refresh, revision, connected])
  const current = load?.key === key ? load : null
  const page = current?.status === 'ready' ? current.page : null
  useEffect(() => requestHistoryPage(request, key, api, setLoad), [request, key, api])
  useEffect(() => {
    if (current?.status === 'loading' || !current || !focusResults.current) return
    focusResults.current = false
    results.current?.focus()
  }, [current])
  const apply = (filters: HistoryFilters, message = '') => {
    const normalized = normalizeHistoryFilters(filters)
    if (!normalized) {
      setFormError('Use valid IDs, a supported status and at most 160 search characters without control characters.')
      return
    }
    setFormError(null)
    setDraft(normalized)
    setApplied(normalized)
    setTrail([FIRST_PAGE])
    setRefresh((value) => value + 1)
    setNotice(message)
    focusResults.current = true
  }
  const submit = (event: FormEvent) => { event.preventDefault(); apply(draft) }
  return (
    <section className="history-browser" aria-label="Searchable work history" data-testid="history-browser">
      <p className="history-scope">
        Corp: <strong>{corpName}</strong> · Viewer: <strong>{actorName}</strong>.
        Only records currently authorized for this viewer are returned.
      </p>
      <form className="history-filters" onSubmit={submit}>
        <label>Record type
          <select value={draft.kind} onChange={(event) => setDraft({
            ...draft, kind: event.target.value as HistoryKind, status: null, record_id: null,
          })}>
            {HISTORY_KINDS.map((kind) => <option key={kind} value={kind}>{kind[0].toUpperCase() + kind.slice(1)} history</option>)}
          </select>
        </label>
        <label>Search titles, IDs or status
          <input type="search" maxLength={320} value={draft.search}
            onChange={(event) => setDraft({ ...draft, search: event.target.value })}
            placeholder="Literal text; payloads are never searched" />
        </label>
        <label>Room
          <select value={draft.room_id ?? ''} onChange={(event) => setDraft({ ...draft, room_id: event.target.value || null })}>
            <option value="">All authorized rooms</option>
            {draft.room_id && !rooms.some((room) => room.id === draft.room_id)
              ? <option value={draft.room_id}>Unavailable room</option> : null}
            {rooms.map((room) => <option key={room.id} value={room.id}>{room.name}</option>)}
          </select>
        </label>
        <label>Attributed actor
          <select value={draft.attributed_actor_id ?? ''}
            onChange={(event) => setDraft({ ...draft, attributed_actor_id: event.target.value || null })}>
            <option value="">Any recorded actor</option>
            {draft.attributed_actor_id && !actors.some((actor) => actor.id === draft.attributed_actor_id)
              ? <option value={draft.attributed_actor_id}>Unavailable actor</option> : null}
            {actors.map((actor) => <option key={actor.id} value={actor.id}>{actor.name}</option>)}
          </select>
        </label>
        <label>{draft.kind === 'event' ? 'Event type' : 'Status'}
          {draft.kind === 'event' ? (
            <input value={draft.status ?? ''} maxLength={96} placeholder="Any; e.g. run.started"
              onChange={(event) => setDraft({ ...draft, status: event.target.value || null })} />
          ) : (
            <select value={draft.status ?? ''} onChange={(event) => setDraft({ ...draft, status: event.target.value || null })}>
              <option value="">Any status</option>
              {HISTORY_ENTITY_STATUSES[draft.kind].map((status) => <option key={status} value={status}>{status.replaceAll('_', ' ')}</option>)}
            </select>
          )}
        </label>
        <label>Mission ID (optional)
          <input value={draft.mission_id ?? ''} maxLength={36} placeholder="Exact mission UUID"
            onChange={(event) => setDraft({ ...draft, mission_id: event.target.value || null })} />
        </label>
        <div className="history-controls">
          <button className="button button-primary" type="submit">Apply filters</button>
          <button className="button button-secondary" type="button"
            onClick={() => apply(emptyHistoryFilters(applied.kind))}>Clear filters</button>
        </div>
      </form>
      {formError ? <p role="alert">{formError}</p> : null}
      <div className="history-applied" data-testid="history-applied">
        <strong>Applied filters</strong>
        <dl>
          <div><dt>Kind</dt><dd>{applied.kind}</dd></div>
          <div><dt>Search</dt><dd>{applied.search || 'Any'}</dd></div>
          <div><dt>Room</dt><dd>{nameFor(rooms, applied.room_id)}</dd></div>
          <div><dt>Actor</dt><dd>{nameFor(actors, applied.attributed_actor_id)}</dd></div>
          <div><dt>Status / event type</dt><dd>{applied.status ?? 'Any'}</dd></div>
          <div><dt>Mission</dt><dd>{applied.mission_id ?? 'Any'}</dd></div>
          {applied.record_id ? <div><dt>Exact event</dt><dd>{applied.record_id}</dd></div> : null}
        </dl>
      </div>
      <p className="history-limit" data-testid="history-limits">
        This is a live, paged view, not a complete export or a count of all work.
        {applied.kind === 'event'
          ? ' Events are ordered by journal sequence, descending; gaps do not imply missing authorized records.'
          : ' Records are ordered by creation time, then ID, descending.'}
        {' '}New commits, changing status or access can change earlier pages. Refresh from the beginning for late records.
        Summaries exclude raw payloads; actor attribution does not establish approval or accepted completion.
      </p>
      {!connected ? <p role="status">Live updates are disconnected or stale. Each history request still checks current access; refresh to retry.</p> : null}
      {notice ? <p role="status">{notice}</p> : null}
      <div className="history-results-heading">
        <h3 ref={results} tabIndex={-1}>History results · page {trail.length}</h3>
        <button className="button button-secondary" type="button"
          onClick={() => apply(applied, 'Search refreshed from the first page.')}>Refresh history</button>
      </div>
      {!current || current.status === 'loading' ? <p role="status" aria-live="polite">Loading authorized history…</p> : null}
      {current?.status === 'error' ? <p role="alert">{current.message}</p> : null}
      {page ? (
        <>
          <p role="status">{page.entries.length} record{page.entries.length === 1 ? '' : 's'} on this page.
            {' '}Search started <time dateTime={page.observed_at}>{date(page.observed_at)}</time>.
          </p>
          {page.entries.length === 0 ? <p className="empty-state">No authorized records match the applied filters. This is not a statement about hidden or retained history.</p> : null}
          <ol className="history-entries" data-testid="history-entries">
            {page.entries.map((record) => {
              const link = historyEntryLink(record)
              return (
                <li key={record.id} data-history-id={record.id} data-history-kind={record.kind}>
                  <article>
                    <div className="history-entry-heading">
                      <h4>{record.title || 'Untitled ' + record.kind}</h4>
                      <span className="history-record-status">{record.status.replaceAll('_', ' ')}</span>
                    </div>
                    <p>{record.summary}</p>
                    <p className="history-attribution">
                      {record.actor_name ?? (record.actor_id ? 'Recorded actor' : 'No recorded actor')}
                      {record.actor_id ? ' · ' + record.actor_id : ''}
                      {' · '}<time dateTime={record.created_at}>{date(record.created_at)}</time>
                    </p>
                    <details>
                      <summary>Record details</summary>
                      <dl>
                        <div><dt>ID</dt><dd>{record.id}</dd></div>
                        {record.seq ? <div><dt>Journal sequence</dt><dd>{record.seq}</dd></div> : null}
                        <div><dt>Room</dt><dd>{record.room_id ? nameFor(rooms, record.room_id) : 'Corp record'}</dd></div>
                        {record.mission_id ? <div><dt>Mission</dt><dd>{record.mission_id}</dd></div> : null}
                        {record.task_id ? <div><dt>Task</dt><dd>{record.task_id}</dd></div> : null}
                        {record.run_id ? <div><dt>Run</dt><dd>{record.run_id}</dd></div> : null}
                      </dl>
                    </details>
                    <div className="history-controls">
                      {link ? <button className="button button-secondary" type="button"
                        onClick={() => onNavigate(link)}>Open exact {link.kind}</button>
                        : <span>No authorized work link recorded.</span>}
                      {record.cause_id ? <button className="button button-secondary" type="button"
                        onClick={() => apply(causalHistoryFilters(record.cause_id!),
                          'Opened the exact causal event. Other filters were cleared; the server rechecks access.')}>Open causal event</button> : null}
                    </div>
                  </article>
                </li>
              )
            })}
          </ol>
        </>
      ) : null}
      <nav className="history-controls" aria-label="History pages">
        <button className="button button-secondary" type="button" disabled={trail.length === 1 || !page}
          onClick={() => { setTrail(trail.slice(0, -1)); focusResults.current = true }}>Previous page</button>
        <button className="button button-secondary" type="button" disabled={!page?.next_cursor}
          onClick={() => {
            if (!page?.next_cursor || !page.entries.length) return
            setTrail([...trail, { cursor: page.next_cursor, after: historyPosition(page.entries[page.entries.length - 1]) }])
            focusResults.current = true
          }}>Next page</button>
        {page && !page.next_cursor ? <span>End of the currently available matching pages. Refresh for changes.</span> : null}
      </nav>
    </section>
  )
}
