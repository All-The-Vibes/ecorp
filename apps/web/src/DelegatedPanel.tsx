import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import './DelegatedPanel.css'

export type DelegatedPanelProps = {
  corpId: string
  roomId: string
  actorId: string
  api: <T>(path: string, init?: RequestInit) => Promise<T>
  serverUrl: string
  onRefresh: () => void
}

type Status = 'waiting_for_authentication' | 'authenticating' | 'authorized'
  | 'completed' | 'cancelled' | 'expired' | 'failed'
type Operation = {
  id: string
  mission_id: string
  task_id: string
  run_id: string
  status: Status
  expires_at: string
  private_preview?: { sha256: string; verified: boolean; subject_preserved: boolean }
  released: boolean
}
type DelegatedState = {
  provider: 'entra' | 'keycloak-test'
  enabled: boolean
  operations: Operation[]
}
type Job = { mission_id: string; task_id: string }
type OwnedJob = Job & { popup: Window | null; attempted: boolean }

const labels: Record<Status, string> = {
  waiting_for_authentication: 'Waiting for authentication',
  authenticating: 'Authenticating',
  authorized: 'Authorized',
  completed: 'Completed',
  cancelled: 'Cancelled',
  expired: 'Expired',
  failed: 'Failed',
}
const terminal = (operation: Operation) =>
  ['completed', 'cancelled', 'expired', 'failed'].includes(operation.status)
const elapsed = (operation: Operation) =>
  !Number.isFinite(Date.parse(operation.expires_at)) || Date.parse(operation.expires_at) <= Date.now()
const needsSignIn = (operation: Operation) =>
  ['waiting_for_authentication', 'authenticating'].includes(operation.status) && !elapsed(operation)

function browserTicket(value: string, serverUrl: string) {
  const server = new URL(serverUrl, window.location.href)
  const url = new URL(value, server)
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== server.origin
    || url.username || url.password || url.search || url.hash
    || !/^\/api\/delegated\/browser\/[A-Za-z0-9_-]+$/.test(url.pathname)) {
    throw new Error('Invalid delegated browser ticket.')
  }
  return url.href
}

export function DelegatedPanel(props: DelegatedPanelProps) {
  // Remount even on A -> B -> A: an earlier human's in-flight requests stay fenced.
  return <ScopedDelegatedPanel
    key={JSON.stringify([props.corpId, props.roomId, props.actorId, props.serverUrl])}
    {...props}
  />
}

function ScopedDelegatedPanel({ corpId, roomId, actorId, api, serverUrl, onRefresh }: DelegatedPanelProps) {
  const base = `/api/corps/${encodeURIComponent(corpId)}/delegated`
  const latest = useRef({ api, onRefresh })
  const lifecycle = useRef({ alive: false, generation: 0 })
  const current = useRef<DelegatedState | null>(null)
  const owned = useRef<OwnedJob | null>(null)
  const reserved = useRef(new Set<Window>())
  const invalidated = useRef(new Set<string>())
  const released = useRef(new Set<string>())
  const tickets = useRef(new Map<string, string>())
  const locks = useRef(new Set<string>())
  const loading = useRef<Promise<void> | null>(null)
  const [data, setData] = useState<DelegatedState | null>(null)
  const [job, setJob] = useState<Job | null>(null)
  const [busy, setBusy] = useState(new Set<string>())
  const [invalidIds, setInvalidIds] = useState(new Set<string>())
  const [releasedIds, setReleasedIds] = useState(new Set<string>())
  const [error, setError] = useState('')
  const [pollError, setPollError] = useState('')
  const [notice, setNotice] = useState('')
  const [theme, setTheme] = useState(() => {
    const param = new URLSearchParams(window.location.search).get('scoutTheme')
    return param === 'light' || param === 'dark' ? param
      : window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  })

  useLayoutEffect(() => { latest.current = { api, onRefresh } }, [api, onRefresh])
  useLayoutEffect(() => {
    const state = lifecycle.current
    const windows = reserved.current
    const cachedTickets = tickets.current
    state.alive = true
    state.generation++
    owned.current = null
    loading.current = null
    return () => {
      state.alive = false
      state.generation++
      for (const popup of windows) popup.close()
      windows.clear()
      cachedTickets.clear()
    }
  }, [])
  useEffect(() => {
    if (['light', 'dark'].includes(new URLSearchParams(window.location.search).get('scoutTheme') ?? '')) return
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const update = () => setTheme(media.matches ? 'dark' : 'light')
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])

  const isCurrent = useCallback((generation: number) =>
    lifecycle.current.alive && lifecycle.current.generation === generation, [])
  const closePopup = useCallback((popup: Window | null) => {
    if (popup && reserved.current.delete(popup)) popup.close()
  }, [])
  const reservePopup = () => {
    const popup = window.open('about:blank', '_blank')
    if (popup) {
      // Keep a handle for the ticket redirect without giving the auth page an opener.
      popup.opener = null
      reserved.current.add(popup)
    }
    return popup
  }
  const setLock = useCallback((key: string, active: boolean) => {
    if (active) locks.current.add(key)
    else locks.current.delete(key)
    setBusy(new Set(locks.current))
  }, [])
  const post = useCallback(<T,>(path: string, body: object) =>
    latest.current.api<T>(path, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor_id: actorId, ...body }),
    }), [actorId])

  const authorize = useCallback(async (operation: Operation, popup: Window | null, manual: boolean) => {
    const generation = lifecycle.current.generation
    const lock = `authorize:${operation.id}`
    if (locks.current.has(lock) || !needsSignIn(operation) || !current.current?.enabled) {
      closePopup(popup)
      setError('This job is not available for sign-in. Refresh its durable status.')
      return
    }
    setLock(lock, true)
    setError('')
    setNotice('')
    try {
      const cached = tickets.current.get(operation.id)
      const url = cached ?? browserTicket((await post<{ browser_url: string }>(
        `${base}/${encodeURIComponent(operation.id)}/authorize`, {},
      )).browser_url, serverUrl)
      if (!isCurrent(generation)) return
      const live = current.current?.operations.find((candidate) => candidate.id === operation.id)
      if (!live || !needsSignIn(live) || invalidated.current.has(operation.id) || !current.current?.enabled) {
        closePopup(popup)
        return
      }
      tickets.current.set(operation.id, url)
      if (popup && !popup.closed) {
        popup.location.replace(url)
        reserved.current.delete(popup)
        tickets.current.delete(operation.id)
        setNotice('Sign-in opened in your browser. This panel will follow the durable job status.')
      } else if (manual) {
        tickets.current.delete(operation.id)
        window.location.assign(url)
      } else {
        closePopup(popup)
        setNotice('The sign-in window was blocked or closed. Select Resume sign-in to continue.')
      }
    } catch {
      if (isCurrent(generation)) {
        closePopup(popup)
        tickets.current.delete(operation.id)
        // Do not echo provider errors or URLs: even error bodies may contain private material.
        setError('Could not open sign-in. Use Resume sign-in to try again while the job is active.')
      }
    } finally {
      if (isCurrent(generation)) setLock(lock, false)
    }
  }, [base, serverUrl, closePopup, isCurrent, post, setLock])

  const refresh = useCallback((): Promise<void> => {
    if (loading.current) return loading.current
    const generation = lifecycle.current.generation
    const request = (async () => {
      try {
        const next = await latest.current.api<DelegatedState>(
          `${base}?actor_id=${encodeURIComponent(actorId)}`,
        )
        if (!isCurrent(generation)) return
        current.current = next
        setData(next)
        setPollError('')
        for (const operation of next.operations) {
          if (terminal(operation) || elapsed(operation)) {
            invalidated.current.add(operation.id)
            tickets.current.delete(operation.id)
          }
        }
        setInvalidIds(new Set(invalidated.current))
        const assignment = owned.current
        const operation = assignment && next.operations.find((candidate) =>
          candidate.mission_id === assignment.mission_id && candidate.task_id === assignment.task_id)
        if (!next.enabled || (operation && (terminal(operation) || elapsed(operation)))) {
          closePopup(assignment?.popup ?? null)
          owned.current = null
          setJob(null)
        } else if (assignment && operation?.run_id && operation.status === 'waiting_for_authentication'
          && !assignment.attempted && !invalidated.current.has(operation.id)
          && document.visibilityState === 'visible') {
          assignment.attempted = true
          void authorize(operation, assignment.popup, false)
        }
      } catch {
        if (isCurrent(generation)) {
          setPollError('Could not refresh delegated jobs. Actions are paused until durable state is available.')
        }
      } finally {
        if (isCurrent(generation)) loading.current = null
      }
    })()
    loading.current = request
    return request
  }, [actorId, base, authorize, closePopup, isCurrent])

  useEffect(() => {
    let active = true
    let timer: number | undefined
    const poll = async () => {
      await refresh()
      if (active) timer = window.setTimeout(poll, 1500)
    }
    // Includes reloads after delegated_auth=returned, focus and bfcache restoration.
    const returned = () => { void refresh() }
    void poll()
    window.addEventListener('focus', returned)
    window.addEventListener('pageshow', returned)
    return () => {
      active = false
      window.clearTimeout(timer)
      window.removeEventListener('focus', returned)
      window.removeEventListener('pageshow', returned)
    }
  }, [refresh])

  const available = Boolean(corpId && roomId && actorId && data?.enabled && !pollError)

  async function run() {
    if (!available || locks.current.has('job') || owned.current) return
    const popup = reservePopup()
    const generation = lifecycle.current.generation
    setLock('job', true)
    setError('')
    setNotice('')
    try {
      const assignment = await post<Job>(`${base}/jobs`, { room_id: roomId })
      if (!isCurrent(generation)) return
      owned.current = { ...assignment, popup, attempted: false }
      setJob(assignment)
      latest.current.onRefresh()
      await refresh()
    } catch {
      if (isCurrent(generation)) {
        closePopup(popup)
        setError('Could not confirm job creation. Check the durable job list before starting another job.')
      }
    } finally {
      if (isCurrent(generation)) setLock('job', false)
    }
  }

  function resume(operation: Operation) {
    if (!available || invalidated.current.has(operation.id) || locks.current.has(`authorize:${operation.id}`)) return
    const assignment = owned.current
    if (assignment?.mission_id === operation.mission_id && assignment.task_id === operation.task_id) {
      assignment.attempted = true
      closePopup(assignment.popup)
    }
    void authorize(operation, reservePopup(), true)
  }

  async function act(operation: Operation, action: 'cancel' | 'release') {
    const key = `${action}:${operation.id}`
    if (locks.current.has(key)) return
    const generation = lifecycle.current.generation
    setLock(key, true)
    setError('')
    if (action === 'cancel') {
      invalidated.current.add(operation.id)
      setInvalidIds(new Set(invalidated.current))
      tickets.current.delete(operation.id)
      const assignment = owned.current
      if (assignment?.mission_id === operation.mission_id && assignment.task_id === operation.task_id) {
        closePopup(assignment.popup)
      }
    }
    try {
      await post(`${base}/${encodeURIComponent(operation.id)}/${action}`, {})
      if (!isCurrent(generation)) return
      if (action === 'release') {
        released.current.add(operation.id)
        setReleasedIds(new Set(released.current))
      }
      setNotice(action === 'release' ? 'Private receipt released.' : 'Cancellation requested.')
      latest.current.onRefresh()
      await refresh()
    } catch {
      if (isCurrent(generation)) {
        setError(action === 'release'
          ? 'Could not confirm receipt release. Refresh the durable status before trying again.'
          : 'Could not confirm cancellation. Refresh the durable status before trying again.')
      }
    } finally {
      if (isCurrent(generation)) setLock(key, false)
    }
  }

  return <section className="delegated-panel" data-theme={theme} aria-label="Protected resource jobs">
    <header className="delegated-heading">
      <h2>Protected resource jobs</h2>
      <span className="delegated-provider">
        {data?.provider === 'entra' ? 'Microsoft Entra'
          : data?.provider === 'keycloak-test' ? <>Keycloak <strong>TEST ONLY</strong></>
            : 'Provider unavailable'}
      </span>
    </header>
    <p>Run an ECorp job using your delegated identity. Sign-in happens in your browser;
      credentials never appear in this panel. A private receipt stays private until you release it.</p>
    {!data && !pollError && <p role="status">Loading delegated jobs...</p>}
    {data && !data.enabled && <p role="status">Delegated jobs are unavailable: no enabled provider is configured.</p>}
    {(!corpId || !roomId || !actorId) && <p role="alert">Select a Corp, room and human actor to run a job.</p>}
    {(error || pollError) && <p className="delegated-error" role="alert">{error || pollError}</p>}
    {notice && <p role="status">{notice}</p>}
    <div className="delegated-actions">
      <button type="button" className="delegated-primary" disabled={!available || busy.has('job') || Boolean(job)}
        onClick={() => { void run() }}>Run protected resource job</button>
      <button type="button" onClick={() => { void refresh() }}>Refresh status</button>
    </div>
    {job && <p role="status">Following mission <code>{job.mission_id}</code>, task <code>{job.task_id}</code>.
      Waiting for the runner and durable job updates.</p>}
    {data?.operations.length === 0 && <p>No delegated operations for this actor.</p>}
    <div className="delegated-operations">
      {data?.operations.map((operation) => {
        const ended = terminal(operation)
        const expired = elapsed(operation)
        const cancelled = invalidIds.has(operation.id)
        const receiptReleased = operation.released || releasedIds.has(operation.id)
        return <article className="delegated-operation" key={operation.id}>
          <header className="delegated-heading">
            <h3>Job <code>{operation.task_id}</code></h3>
            <span className={`delegated-status delegated-status-${operation.status}`}>
              {labels[operation.status]}
            </span>
          </header>
          <dl>
            <dt>Mission</dt><dd><code>{operation.mission_id}</code></dd>
            <dt>Run</dt><dd><code>{operation.run_id || 'Awaiting runner'}</code></dd>
            <dt>Expires</dt><dd>{Number.isFinite(Date.parse(operation.expires_at))
              ? <time dateTime={operation.expires_at}>{new Date(operation.expires_at).toLocaleString()}</time>
              : 'Unknown expiry; sign-in disabled'}</dd>
          </dl>
          {!ended && expired && <p>Authorization window elapsed. Waiting for the server's terminal status.</p>}
          {['cancelled', 'expired', 'failed'].includes(operation.status) &&
            <p>This operation has ended. It will not be retried automatically.</p>}
          {operation.private_preview && <div className="delegated-receipt">
            <h4>Private receipt</h4>
            <p>SHA-256: <code>{operation.private_preview.sha256}</code></p>
            <p>Verified: {operation.private_preview.verified ? 'Yes' : 'No'}.
              {' '}Subject preserved: {operation.private_preview.subject_preserved ? 'Yes' : 'No'}.</p>
          </div>}
          {receiptReleased && <p className="delegated-released">Released</p>}
          <div className="delegated-actions">
            {needsSignIn(operation) && !cancelled &&
              <button type="button" disabled={!available || busy.has(`authorize:${operation.id}`)}
                onClick={() => resume(operation)}>Resume sign-in</button>}
            {!ended && !expired &&
              <button type="button" disabled={!available || busy.has(`cancel:${operation.id}`)}
                onClick={() => { void act(operation, 'cancel') }}>Cancel job</button>}
            {operation.status === 'authorized' && operation.private_preview && !receiptReleased &&
              <button type="button" disabled={!available || busy.has(`release:${operation.id}`)}
                onClick={() => { void act(operation, 'release') }}>Release private receipt</button>}
          </div>
        </article>
      })}
    </div>
  </section>
}
