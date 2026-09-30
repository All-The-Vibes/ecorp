import { useCallback, useLayoutEffect, useState } from 'react'
import { BUDGET_SNAPSHOT_FRESH_MS } from './budgetOverview'
import type { BudgetSnapshotStamp, BudgetViewer } from './budgetOverview'
import { buildExecutiveOverview, executiveDestinationAvailable, executiveStatus } from './executiveOverview'
import type { ExecutiveDestination, ExecutiveMission, ExecutiveSnapshot } from './executiveOverview'
import type { RunActivityInput } from './runActivity'
import type { MissionOriginApi } from './missionOriginContext'
import { useMissionResultContext } from './useMissionResultContext'
import { missionResultPresentation } from './missionResultContext'
import { PublishedResultCard } from './PublishedResultCard'
import './ExecutiveDashboard.css'

type Props = {
  snapshot: ExecutiveSnapshot
  viewer: BudgetViewer & { role: string }
  stamp: BudgetSnapshotStamp
  runners: RunActivityInput['runners']
  api: MissionOriginApi
  onRefresh: () => void
  onOpen: (target: ExecutiveDestination) => void
  onWorkspace: (workspace: 'factory' | 'activity') => void
}

function ExecutiveResult({ row, viewer, api, onOpen }: {
  row: ExecutiveMission; viewer: Props['viewer']; api: MissionOriginApi; onOpen: Props['onOpen']
}) {
  const item = row.item
  const read = useMissionResultContext({
    corpId: viewer.corpId, actorId: viewer.actorId, actorRole: viewer.role,
    missionId: row.mission.id, roomId: row.mission.room_id,
    workItemId: item?.id, sourceRepository: item ? `${item.source_repository_owner}/${item.source_repository_name}` : null,
    revision: `${item?.version ?? ''}:${row.publicationRevision}`, api,
  })
  if (!item) return <p className="executive-limit">No uniquely attributed intake result is available here. Open the exact mission to inspect its evidence; no pull request link has been inferred.</p>
  const result = missionResultPresentation(read.scope, read.current)
  const deliveredRun = row.runs.find((run) => run.id === result.resultRunId)
  return <div className="executive-result">
    <PublishedResultCard result={result} onRefresh={read.refresh} />
    {deliveredRun ? <button type="button" className="button button-secondary"
      onClick={() => onOpen({ kind: 'run', id: deliveredRun.id, missionId: row.mission.id })}>Open delivered evidence in Operations</button>
      : result.resultRunId ? <p className="executive-limit">The delivered run is outside this snapshot. Its exact evidence cannot be opened here; no newer run has been substituted.</p> : null}
  </div>
}

/** Presentation only: the existing scoped readers and Operations controls own authority. */
export function ExecutiveDashboard({ snapshot, viewer, stamp, runners, api, onRefresh, onOpen, onWorkspace }: Props) {
  const [now, updateClock] = useState(Date.now)
  useLayoutEffect(() => {
    const current = Date.now()
    // Synchronize receipt freshness before paint without trusting its timestamp
    // as the clock. Navigation independently checks time at activation.
    // oxlint-disable-next-line react/set-state-in-effect
    updateClock(current)
    const delay = Date.parse(stamp.receivedAt ?? '') + BUDGET_SNAPSHOT_FRESH_MS - current
    const expiry = Number.isFinite(delay) && delay > 0
      ? window.setTimeout(() => updateClock(Date.now()), delay + 1) : undefined
    return () => { window.clearTimeout(expiry) }
  }, [stamp.receivedAt])
  const overview = buildExecutiveOverview(snapshot, viewer, stamp, runners, now)
  const open = useCallback((target: ExecutiveDestination) => {
    if (executiveDestinationAvailable(buildExecutiveOverview(snapshot, viewer, stamp, runners, Date.now()), target)) onOpen(target)
    else onRefresh()
  }, [snapshot, viewer, stamp, runners, onOpen, onRefresh])
  return <section id="executive" tabIndex={-1} className="executive-dashboard" aria-labelledby="executive-title">
    <header className="executive-heading">
      <div><span className="section-code">Executive view</span><h2 id="executive-title">Outcomes &amp; decisions</h2></div>
      <button type="button" className="button button-secondary" onClick={onRefresh}>Refresh work</button>
    </header>
    <p>Review the recorded outcomes, decisions and evidence for work you can access. Operational actions remain in the existing workspaces.</p>
    {overview.state !== 'current' ? <p className="executive-notice" role="status">
      Current work is unavailable. {overview.reason} Decisions, progress and cost cannot be confirmed; the runner can continue independently.
    </p> : <>
      <p className="executive-limit">Authorized snapshot · {overview.missions.length} returned missions. Task counts describe returned records, not a completion estimate. Earlier work may require history.</p>
      {overview.notices.length ? <div className="executive-notice" role="status">
        {overview.notices.map((notice, index) => <p key={index}>{notice}</p>)}
        <button type="button" className="button button-secondary" onClick={() => onWorkspace('factory')}>Inspect Factory in Operations</button>
      </div> : null}
      <section className="executive-attention panel" aria-labelledby="executive-attention-title">
        <h3 id="executive-attention-title">Needs attention</h3>
        {overview.missions.some((row) => row.alerts.length) ? <ul>
          {overview.missions.flatMap((row) => row.alerts.map((alert) => <li key={`${row.mission.id}:${alert.key}`}>
            <strong>{row.mission.title} · {alert.title}</strong><p>{alert.detail}</p>
            <button type="button" className="button button-secondary" onClick={() => open(alert.target)}>Inspect in Operations</button>
          </li>))}
        </ul> : <p>No decision or blocker is reported in the returned records. Missing historical data and unreported cost are not a clean bill of health.</p>}
      </section>
      <div className="executive-missions">
        {overview.missions.map((row) => <article className="executive-mission panel" key={row.mission.id}>
          <header><div><span className="section-code">Mission outcome</span><h3>{row.mission.title}</h3></div>
            <span className="executive-status">Recorded: {executiveStatus(row.mission.status)}</span></header>
          <p>{row.mission.description}</p>
          <dl className="executive-facts">
            <div><dt>Task progress</dt><dd>{row.taskCounts.length ? row.taskCounts.map(({ status, count }) => `${count} ${executiveStatus(status)}`).join(' · ') : 'Unavailable'}</dd></div>
            <div><dt>Responsible team</dt><dd>{row.team.length ? row.team.join(', ') : 'Unavailable'}{row.teamIncomplete ? ' · Some assignments are unconfirmed' : ''}</dd></div>
            <div><dt>Run activity</dt><dd>{row.activity.status}</dd></div>
          </dl>
          <p>{row.activity.summary}</p>
          <div className="executive-actions">
            <button type="button" className="button button-primary" onClick={() => open({ kind: 'mission', id: row.mission.id, missionId: row.mission.id })}>Open mission in Operations</button>
            {row.activityRun ? <button type="button" className="button button-secondary"
              onClick={() => open({ kind: 'run', id: row.activityRun!.id, missionId: row.mission.id })}>Inspect exact run</button> : null}
            {row.activityRun?.artifact_id ? <button type="button" className="button button-secondary"
              onClick={() => open({ kind: 'artifact', id: row.activityRun!.artifact_id!, missionId: row.mission.id })}>Inspect exact artifact</button> : null}
          </div>
          <ExecutiveResult row={row} viewer={viewer} api={api} onOpen={open} />
        </article>)}
      </div>
      {!overview.missions.length ? <p>No missions were returned for this authorized view. This does not establish that the Corp has no historical work.</p> : null}
    </>}
    <button type="button" className="button button-secondary" onClick={() => onWorkspace('activity')}>Browse authorized history in Operations</button>
  </section>
}
