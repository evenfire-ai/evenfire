import Link from 'next/link'
import { TableHeaderRow } from '@components/TableHeaderRow'
import { CONTROL_ROUTES } from '@constants/routes'
import type { GovernedTraceSessionDetail } from '@lib/governedTrace'
import { displayTraceValue as display, formatTraceTimestamp } from '../formatters'
import { SESSION_RUN_COLUMNS } from './constants'

function observedDuration(first: string, last: string): string {
  const duration = new Date(last).getTime() - new Date(first).getTime()
  if (!Number.isFinite(duration) || duration < 0) return 'Invalid persisted timestamps'
  if (duration < 60_000) return `${(duration / 1000).toFixed(1)}s`
  return `${(duration / 60_000).toFixed(1)}m`
}

export function SessionIdentity({ detail }: { detail: GovernedTraceSessionDetail }) {
  const { summary } = detail
  const humanLabel =
    summary.human.displayName || summary.human.subject || 'Attribution not recorded'
  const agentLabel =
    summary.agent.displayName || summary.agent.subject || 'Agent identity not recorded'
  const humanStatus =
    summary.human.status === 'unavailable'
      ? 'not recorded'
      : summary.human.status.replaceAll('_', ' ')
  const agentStatus = summary.agent.status === 'unavailable' ? 'not recorded' : summary.agent.status
  return (
    <>
      <div className="cu-trace-detail-identity">
        <dl>
          <div>
            <dt>Session ID</dt>
            <dd className="cu-trace-monospace">{summary.sessionId}</dd>
          </div>
          <div>
            <dt>MCP host</dt>
            <dd>{summary.hostRef}</dd>
          </div>
          <div>
            <dt>Human</dt>
            <dd>
              {summary.human.userId ? (
                <Link
                  className="cu-trace-link"
                  href={CONTROL_ROUTES.usersAndTeams.user(summary.human.userId)}
                >
                  {display(humanLabel)}
                </Link>
              ) : (
                display(humanLabel)
              )}
              <span>Status: {humanStatus}</span>
              {summary.human.subject && summary.human.subject !== humanLabel ? (
                <span>Subject: {summary.human.subject}</span>
              ) : null}
              {summary.human.userId ? <span>Platform user ID: {summary.human.userId}</span> : null}
              {summary.human.identityIssuer ? (
                <span>Issuer: {summary.human.identityIssuer}</span>
              ) : null}
              {summary.human.status === 'unavailable' ? (
                <span>No authoritative run binding was persisted for this session.</span>
              ) : null}
            </dd>
          </div>
          <div>
            <dt>Acting agent</dt>
            <dd>
              {display(agentLabel)}
              <span>Status: {agentStatus}</span>
              {summary.agent.subject && summary.agent.subject !== agentLabel ? (
                <span>Subject: {summary.agent.subject}</span>
              ) : null}
            </dd>
          </div>
          <div>
            <dt>Origins</dt>
            <dd>{summary.origins.join(', ') || 'No origin recorded'}</dd>
          </div>
          <div>
            <dt>Observed activity</dt>
            <dd>
              {formatTraceTimestamp(summary.firstOccurredAt)} to{' '}
              {formatTraceTimestamp(summary.lastOccurredAt)}
            </dd>
          </div>
        </dl>
      </div>
      <dl aria-label="Session metrics" className="cu-trace-summary" role="group">
        <div>
          <dt>Observed duration</dt>
          <dd>{observedDuration(summary.firstOccurredAt, summary.lastOccurredAt)}</dd>
        </div>
        <div>
          <dt>Runs / events</dt>
          <dd>
            {summary.runCount} / {summary.eventCount}
          </dd>
        </div>
        <div>
          <dt>Tool calls</dt>
          <dd>{summary.tools.totalCalls}</dd>
        </div>
        <div>
          <dt>Approval outcomes</dt>
          <dd>
            {summary.approvals.approved} approved · {summary.approvals.denied} denied
          </dd>
        </div>
      </dl>
      <section className="cu-trace-detail-section" aria-labelledby="trace-session-runs">
        <div className="cu-trace-detail-section__head">
          <h2 id="trace-session-runs">Runs</h2>
          <span>{detail.runs.length} loaded</span>
        </div>
        <div className="cu-table-wrap">
          <table className="cu-table cu-table--header-band cu-trace-detail-table">
            <thead>
              <TableHeaderRow columns={SESSION_RUN_COLUMNS} />
            </thead>
            <tbody>
              {detail.runs.map(run => (
                <tr key={run.runId}>
                  <td data-label="Run" className="cu-trace-monospace">
                    {run.runId}
                  </td>
                  <td data-label="First observed">
                    {formatTraceTimestamp(run.startedAt)}
                    <div className="cu-table__cell-muted">{run.origin.replaceAll('_', ' ')}</div>
                  </td>
                  <td data-label="Last observed">
                    {run.endedAt ? formatTraceTimestamp(run.endedAt) : 'Open'}
                  </td>
                  <td data-label="Outcome">{display(run.outcome)}</td>
                  <td data-label="Events">{run.eventCount}</td>
                </tr>
              ))}
              {!detail.runs.length ? (
                <tr>
                  <td className="cu-empty" colSpan={SESSION_RUN_COLUMNS.length}>
                    No governed runs are available for this session.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
    </>
  )
}
