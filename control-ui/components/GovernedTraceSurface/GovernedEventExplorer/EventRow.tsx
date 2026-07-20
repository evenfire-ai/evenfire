import Link from 'next/link'
import { CONTROL_ROUTES } from '@constants/routes'
import type { GovernedTraceEvent } from '@lib/governedTrace'
import { displayTraceValue as display, formatTraceLabel, formatTraceTimestamp } from '../formatters'

function AdministrativeRow({ event }: { event: GovernedTraceEvent }) {
  const operator = event.operatorDisplayName || event.initiatingHumanSub || event.actorSub
  const targetLabel =
    typeof event.payload.target_label === 'string' ? event.payload.target_label : null
  const targetUser = event.targetUserDisplayName || targetLabel || event.targetUserSub
  const resourceClass =
    typeof event.payload.resource_class === 'string' ? event.payload.resource_class : null
  const targetPrincipalKind =
    typeof event.payload.target_principal_kind === 'string'
      ? event.payload.target_principal_kind
      : null
  const targetPrincipalRef =
    typeof event.payload.target_principal_ref === 'string'
      ? event.payload.target_principal_ref
      : null
  const operatorProfileId =
    event.operatorPrincipalKind === 'platform_user' ? event.operatorPrincipalId : null
  const localControlUiAction =
    event.sourceKind === 'control_api_local' && event.operatorPrincipalKind === 'control_admin'
  const actingServiceOrAgent =
    event.delegatedActorSub ||
    event.actingAgentSub ||
    (localControlUiAction
      ? 'Not delegated (local Control UI action)'
      : 'No delegated actor recorded')
  const operatorStatus =
    event.operatorPrincipalKind === 'control_admin'
      ? 'Verified Control UI administrator'
      : event.operatorPrincipalKind === 'platform_user'
        ? 'Verified platform user'
        : operator
          ? 'Legacy subject attribution'
          : 'System initiated'
  return (
    <tr>
      <td data-label="Change / approval">
        <Link
          className="cu-trace-link"
          href={CONTROL_ROUTES.traces.administrativeEvent(event.eventId)}
        >
          {formatTraceLabel(event.eventType)}
        </Link>
        <div className="cu-table__cell-muted">
          {resourceClass ? formatTraceLabel(resourceClass) : event.eventId}
        </div>
      </td>
      <td data-label="Operator">
        {operatorProfileId ? (
          <Link
            className="cu-trace-link"
            href={CONTROL_ROUTES.usersAndTeams.user(operatorProfileId)}
          >
            {display(operator)}
          </Link>
        ) : (
          display(operator)
        )}
        <div className="cu-table__cell-muted">{operatorStatus}</div>
      </td>
      <td data-label="Acting service / agent">
        <div>{actingServiceOrAgent}</div>
        <div className="cu-table__cell-muted">
          {display(event.sourceService || event.serviceSub || event.serviceOrAgentSub)}
        </div>
      </td>
      <td data-label="Target">
        <div>
          {formatTraceLabel(event.targetType)} · {display(event.targetRef)}
        </div>
        {event.targetUserId ? (
          <Link
            className="cu-trace-link cu-table__cell-muted"
            href={CONTROL_ROUTES.usersAndTeams.user(event.targetUserId)}
          >
            {display(targetUser)}
          </Link>
        ) : targetUser ? (
          <div className="cu-table__cell-muted">{display(targetUser)} · subject attribution</div>
        ) : event.teamId ? (
          <Link
            className="cu-trace-link cu-table__cell-muted"
            href={CONTROL_ROUTES.usersAndTeams.team(event.teamId)}
          >
            Target team · {display(event.targetTeamDisplayName || event.teamId)}
          </Link>
        ) : targetPrincipalRef ? (
          <div className="cu-table__cell-muted">
            Target {formatTraceLabel(targetPrincipalKind || 'service')} ·{' '}
            {display(targetPrincipalRef)}
          </div>
        ) : (
          <div className="cu-table__cell-muted">Service or resource-level change</div>
        )}
      </td>
      <td data-label="Outcome">
        <span className="cu-trace-state" data-state={event.outcome ?? 'unknown'}>
          {formatTraceLabel(event.outcome)}
        </span>
      </td>
      <td data-label="Occurred">{formatTraceTimestamp(event.occurredAt)}</td>
    </tr>
  )
}

function InfrastructureRow({ event }: { event: GovernedTraceEvent }) {
  const workloadLabel = event.workloadRef || event.targetRef || 'Unscoped workload'
  return (
    <tr>
      <td data-label="Workload / event">
        <Link
          className="cu-trace-link"
          href={CONTROL_ROUTES.traces.infrastructureEvent(event.eventId)}
        >
          {workloadLabel}
        </Link>
        <div className="cu-table__cell-muted">
          {display(event.workloadKind || event.targetType)} · {event.eventId}
        </div>
      </td>
      <td data-label="Telemetry">
        <div>{display(event.telemetryType || event.eventType)}</div>
        {event.reasonCode ? <div className="cu-table__cell-muted">{event.reasonCode}</div> : null}
      </td>
      <td data-label="Controller">
        <div>{display(event.controller)}</div>
        <div className="cu-table__cell-muted">
          {display(event.sourceService || event.serviceOrAgentSub)}
        </div>
      </td>
      <td data-label="Scope">
        <div>{display(event.clusterName)}</div>
        <div className="cu-table__cell-muted">{display(event.namespace)}</div>
      </td>
      <td data-label="Outcome">
        <span className="cu-trace-state" data-state={event.outcome ?? 'unknown'}>
          {display(event.outcome)}
        </span>
      </td>
      <td data-label="Occurred">{formatTraceTimestamp(event.occurredAt)}</td>
    </tr>
  )
}

export function GovernedEventRow({
  event,
  family,
}: {
  event: GovernedTraceEvent
  family: 'administrative' | 'infrastructure_telemetry'
}) {
  return family === 'administrative' ? (
    <AdministrativeRow event={event} />
  ) : (
    <InfrastructureRow event={event} />
  )
}
