import { useCallback, useLayoutEffect, useState } from 'react'
import {
  BUDGET_SNAPSHOT_FRESH_MS, budgetAuthority, budgetDestinationAvailable, buildBudgetOverview,
  formatBudgetMoney, formatBudgetTokens,
} from './budgetOverview'
import type { BudgetDestination, BudgetRow, BudgetSnapshot, BudgetSnapshotStamp, BudgetViewer } from './budgetOverview'
import './BudgetOverviewPanel.css'

type Props = {
  snapshot: BudgetSnapshot
  viewer: BudgetViewer
  stamp: BudgetSnapshotStamp
  onRefresh: () => void
  onOpen: (target: BudgetDestination) => void
}

function AuthorityValues({ label, value, costLabel }: {
  label: string; value: BudgetRow['original']; costLabel: string
}) {
  return <div><dt>{label}</dt><dd><strong>{formatBudgetTokens(value.tokens)}</strong>
    <span>{formatBudgetMoney(value.cost)} <small>{costLabel}</small></span></dd></div>
}

export function BudgetOverviewPanel({ snapshot, viewer, stamp, onRefresh, onOpen }: Props) {
  const [now, updateClock] = useState(Date.now)
  useLayoutEffect(() => {
    const current = Date.now()
    // Sample before paint so a new receipt is not compared with the prior
    // receipt's clock. Future timestamps still fail against the actual clock.
    // oxlint-disable-next-line react/set-state-in-effect
    updateClock(current)
    const delay = Date.parse(stamp.receivedAt ?? '') + BUDGET_SNAPSHOT_FRESH_MS - current
    const expiry = Number.isFinite(delay) && delay > 0
      ? window.setTimeout(() => updateClock(Date.now()), delay + 1) : undefined
    return () => { window.clearTimeout(expiry) }
  }, [stamp.receivedAt])
  const overview = buildBudgetOverview(snapshot, viewer, stamp, now)
  const totals = overview.totals
  const pending = overview.rows.flatMap((row) => row.pending.map((revision) => ({ row, revision })))
  const suspended = overview.rows.filter((row) => row.suspendedRunIds.length)
  const unpriced = overview.rows.reduce((total, row) => total + row.unpricedRuns, 0)
  const unreported = overview.rows.reduce((total, row) => total + row.unreportedRuns, 0)
  const incomplete = overview.rows.some((row) => row.missingHistory || row.invalidUsage) || overview.unattributedRuns > 0
  const missingDecisions = overview.rows.filter((row) => row.currentDecisionMissing).length
  const open = useCallback((target: BudgetDestination) => {
    if (budgetDestinationAvailable(buildBudgetOverview(snapshot, viewer, stamp, Date.now()), target)) onOpen(target)
    else onRefresh()
  }, [snapshot, viewer, stamp, onOpen, onRefresh])

  return <section className="budget-overview panel" aria-labelledby="budget-overview-title" data-testid="budget-overview">
    <header className="budget-overview-heading">
      <div><span className="section-code">Across authorized work</span><h2 id="budget-overview-title">Spend &amp; budget headroom</h2></div>
      <button type="button" className="button button-secondary" onClick={onRefresh}>Refresh budgets</button>
    </header>
    {overview.state !== 'current' ? <p className="budget-overview-notice" role="status">{overview.reason}</p> : <>
      <p className="budget-overview-scope">
        Snapshot-limited totals · {snapshot.corp.name} · {overview.rows.length} authorized missions.<br />
        No time filter; includes completed work returned in this snapshot. Received <time dateTime={stamp.receivedAt!}>{new Date(stamp.receivedAt!).toLocaleString()}</time> (browser time).
        {' '}Refresh after 60 seconds or when access changes.
      </p>
      <p className="budget-overview-boundary">Each mission keeps its own ceiling. These totals are not a shared pool or permission to spend.</p>
      {totals ? <dl className="budget-overview-metrics" data-testid="budget-overview-totals">
        <AuthorityValues label="Original authority" value={totals.original} costLabel="authorized" />
        <AuthorityValues label="Current authority" value={totals.current} costLabel="authorized" />
        <AuthorityValues label="Recorded consumption" value={totals.consumed} costLabel="reported cost" />
        <AuthorityValues label="Ledger remainder" value={totals.remaining} costLabel="after reported cost" />
      </dl> : null}
      <p className="budget-overview-notice" data-testid="budget-cost-provenance">
        Measured and estimated cost are unavailable: the ledger does not record pricing provenance.
        {' '}{unpriced} runs have unpriced token usage; {unreported} have no recorded usage or price.
        {' '}Zero reported cost is not evidence of free work. The dollar remainder may overstate headroom when costs are missing.
      </p>
      {incomplete ? <p className="budget-overview-notice" role="status">
        Some usage or run history is missing or invalid. Withheld totals and remainders are unavailable, not zero.
        {overview.unattributedRuns > 0 ? ` ${overview.unattributedRuns} returned runs could not be attributed to an authorized mission.` : ''}
      </p> : null}
      {missingDecisions > 0 ? <p className="budget-overview-notice">{missingDecisions} revised mission ceilings have no matching approval receipt in this snapshot. Inspect their budget records before making a decision.</p> : null}
      <div className="budget-overview-attention" aria-label="Budget decisions and recovery">
        <strong>{pending.length} budget requests need a decision · {suspended.length} missions have recorded suspensions</strong>
        {pending.length ? <ul>{pending.map(({ row, revision }) => {
          const requested = budgetAuthority(revision.proposed_budget_tokens, revision.proposed_budget_cost_microusd)
          return <li key={revision.id}>
          <button type="button" onClick={() => open({ kind: 'revision', missionId: row.mission.id, revisionId: revision.id })}>
            {row.mission.title} · inspect pending revision {revision.version}
          </button>
          <span>Requested: {formatBudgetTokens(requested.tokens)} · {formatBudgetMoney(requested.cost)}. Not yet authorized.</span>
        </li>})}</ul> : <p>No pending budget requests in this snapshot.</p>}
        <p>Auditor-led extension and audit status are unavailable in the current server. Existing manual revision and recovery records remain the source of authority.</p>
      </div>
      {overview.rows.length ? <details className="budget-overview-missions">
        <summary>Inspect {overview.rows.length} mission budgets</summary>
        <ul>{overview.rows.map((row) => <li key={row.mission.id} data-budget-overview-mission={row.mission.id}>
          <header><div><h3>{row.mission.title}</h3><span>{row.mission.status.replaceAll('_', ' ')}</span></div>
            <button type="button" className="button button-secondary" onClick={() => open({ kind: 'budget', missionId: row.mission.id })}>Open mission budget</button>
          </header>
          <dl className="budget-overview-metrics">
            <AuthorityValues label="Original" value={row.original} costLabel="authorized" />
            <AuthorityValues label="Current" value={row.current} costLabel="authorized" />
            <AuthorityValues label="Consumed" value={row.consumed} costLabel="reported cost" />
            <AuthorityValues label="Remaining" value={row.remaining} costLabel="after reported cost" />
          </dl>
          <p>{row.runCount} unique runs · {row.workerCount} participating agents · {row.resumedRunCount} resumed runs.
            {' '}Retries, worker and auditor usage are counted once from persisted run totals.</p>
          <p>{row.reportedCostRuns} runs report a positive cost · {row.unpricedRuns} unpriced · {row.unreportedRuns} without reported usage.</p>
          {row.missingHistory || row.invalidUsage ? <p className="budget-overview-notice">Usage history is incomplete or invalid; the recorded subtotal is not proof of total consumption.</p> : null}
          {row.currentDecisionMissing ? <p className="budget-overview-notice">The server reports a revised ceiling, but its matching approval receipt is unavailable in this snapshot.</p> : null}
          <div className="budget-overview-links">
            {row.revisions.map((revision) => <button type="button" key={revision.id}
              onClick={() => open({ kind: 'revision', missionId: row.mission.id, revisionId: revision.id })}>
              Revision {revision.version} · {revision.status}
            </button>)}
            {row.suspendedRunIds.map((runId) => <button type="button" key={runId}
              onClick={() => open({ kind: 'suspension', missionId: row.mission.id, runId })}>
              Inspect suspension {runId.slice(0, 8)} &amp; existing recovery controls
            </button>)}
          </div>
        </li>)}</ul>
      </details> : <p>No missions are available in this authorized snapshot.</p>}
    </>}
  </section>
}
