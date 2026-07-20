'use client'

import Link from 'next/link'
import { IconCopy } from '@components/icons'
import { CONTROL_ROUTES } from '@constants/routes'
import type { GovernedTraceSessionSummaryV1 } from '@lib/governedTrace'
import { displayTraceValue as display, formatTraceTimestamp } from '../formatters'

function identityLabel(
  displayName: string | null,
  subject: string | null,
  missingLabel: string
): string {
  return displayName?.trim() || subject?.trim() || missingLabel
}

function tokenCount(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value)
}

export function SessionRow({
  copied,
  onCopy,
  session,
}: {
  copied: boolean
  onCopy: () => void
  session: GovernedTraceSessionSummaryV1
}) {
  const sessionHref = CONTROL_ROUTES.traces.session(session.hostRef, session.sessionId)
  const humanLabel = identityLabel(
    session.human.displayName,
    session.human.subject,
    'Attribution not recorded'
  )
  const agentLabel = identityLabel(
    session.agent.displayName,
    session.agent.subject,
    'Agent identity not recorded'
  )
  const humanStatus =
    session.human.status === 'unavailable'
      ? 'not recorded'
      : session.human.status.replaceAll('_', ' ')
  const agentStatus = session.agent.status === 'unavailable' ? 'not recorded' : session.agent.status
  const tokenCoverage =
    session.tokenUsage.coverage === 'unavailable'
      ? 'no central usage events'
      : session.tokenUsage.coverage.replaceAll('_', ' ')

  return (
    <tr>
      <td data-label="Session">
        <div className="cu-trace-session-cell">
          <Link className="cu-trace-link cu-trace-session-id" href={sessionHref}>
            {session.sessionId}
          </Link>
          <button
            aria-label={`Copy session ID ${session.sessionId}`}
            className="cu-trace-copy"
            onClick={onCopy}
            title="Copy session ID"
            type="button"
          >
            <IconCopy height={14} width={14} />
          </button>
        </div>
        <div>{session.hostRef}</div>
        <div className="cu-table__cell-muted">
          {session.origins.join(', ') || 'No origin recorded'}
        </div>
        {copied ? <span className="cu-trace-copy-state">Copied</span> : null}
      </td>
      <td data-label="Human">
        {session.human.userId ? (
          <Link
            className="cu-trace-link"
            href={CONTROL_ROUTES.usersAndTeams.user(session.human.userId)}
          >
            {humanLabel}
          </Link>
        ) : (
          humanLabel
        )}
        <div className="cu-table__cell-muted">{humanStatus}</div>
        {session.human.identityIssuer ? (
          <div className="cu-table__cell-muted">{session.human.identityIssuer}</div>
        ) : null}
      </td>
      <td data-label="Agent">
        <div>{agentLabel}</div>
        <div className="cu-table__cell-muted">{agentStatus}</div>
      </td>
      <td data-label="Activity">
        <div>{formatTraceTimestamp(session.lastOccurredAt)}</div>
        <div className="cu-table__cell-muted">
          {session.runCount} runs · {session.eventCount} events
        </div>
        <span className="cu-trace-state" data-state={session.latestRunOutcome ?? 'unknown'}>
          {display(session.latestRunOutcome)}
        </span>
      </td>
      <td data-label="Tools">
        <div>{session.tools.totalCalls} calls</div>
        <div className="cu-table__cell-muted">{session.tools.distinctTools} distinct</div>
      </td>
      <td data-label="Tokens">
        <div>{tokenCount(session.tokenUsage.totalTokens)}</div>
        <div className="cu-table__cell-muted">Input + output</div>
        <div className="cu-table__cell-muted">
          {session.tokenUsage.meteredCalls} calls · {tokenCoverage}
        </div>
      </td>
      <td data-label="Approvals">
        <div className="cu-trace-approval-counts">
          <span>{session.approvals.requested} requested</span>
          <span>{session.approvals.approved} approved</span>
          <span>{session.approvals.denied} denied</span>
        </div>
        <div className="cu-table__cell-muted">
          Prompt history: {session.approvals.promptHistory}
        </div>
      </td>
    </tr>
  )
}
