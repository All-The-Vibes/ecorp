import { activityTime } from './runActivity'
import type { RunActivityPresentation } from './runActivity'

/** Shares existing result-card/disclosure styling; no commands, timers or data reads. */
export function RunActivityDetails({ view }: { view: RunActivityPresentation }) {
  return (
    <section className="run-activity-details" aria-label="Run activity and freshness" data-testid="run-activity-details" data-run-id={view.runId ?? undefined}>
      {view.notices.map((notice) => <p className="work-result-notice run-activity-notice" key={notice}>{notice}</p>)}
      <dl className="work-result-facts">
        {view.facts.map((fact) => <div key={fact.label}>
          <dt>{fact.label}</dt><dd>{fact.value}{fact.detail ? <small>{fact.detail}</small> : null}</dd>
        </div>)}
      </dl>
      <p className="work-result-notice run-activity-latest">
        <strong>Last run event: </strong>{view.latest ? <>
          {view.latest.label} · <time dateTime={view.latest.at}>{activityTime(view.latest.at)}</time>
        </> : 'Not available in this snapshot.'}
      </p>
      <details className="work-result-details">
        <summary>Recent activity and execution context</summary>
        <div>
          <p>Up to five supported events from the selected run’s snapshot. This is not its complete history; provider text and tool arguments are not shown.</p>
          {view.timeline.length ? <ol className="run-activity-timeline">
            {view.timeline.map((event) => <li key={event.id}>
              <time dateTime={event.at}>{activityTime(event.at)}</time><span>{event.label}</span>
            </li>)}
          </ol> : <p>No supported activity events are available in this snapshot.</p>}
          <dl className="run-activity-context">
            {view.context.map((fact) => <div key={fact.label}><dt>{fact.label}</dt><dd>{fact.value}</dd></div>)}
          </dl>
        </div>
      </details>
    </section>
  )
}
