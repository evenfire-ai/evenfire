'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { TablePanelHeader } from '@components/TablePanelHeader'
import { IconRefresh } from '@components/icons'
import { CONTROL_ROUTES } from '@constants/routes'
import { getGovernedAdministrativeEventDetail } from '@lib/governedTrace'
import type { GovernedAdministrativeEventDetail } from '@lib/governedTrace'
import { ReleasedTraceFacts } from '../ReleasedTraceFacts'
import { displayTraceValue as display, formatTraceLabel, formatTraceTimestamp } from '../formatters'
import type { AdministrativeEventDetailProps } from './types'

function HumanIdentity({
  emptyLabel,
  identity,
}: {
  emptyLabel: string
  identity: GovernedAdministrativeEventDetail['operatorHuman']
}) {
  const label = identity.displayName || identity.subject || emptyLabel
  const statusLabel =
    identity.status === 'verified'
      ? 'Verified at ingestion'
      : identity.status === 'verified_late'
        ? 'Verified from the current directory'
        : identity.status === 'legacy'
          ? 'Legacy subject only'
          : identity.status === 'system'
            ? 'System initiated'
            : 'No authoritative identity recorded'
  const principalLabel =
    identity.principalKind === 'control_admin'
      ? 'Control UI administrator'
      : identity.principalKind === 'platform_user'
        ? 'Platform user'
        : identity.principalKind === 'system'
          ? 'System principal'
          : 'Unresolved principal'
  return (
    <span className="cu-trace-identity-value">
      {identity.principalKind === 'platform_user' && identity.userId ? (
        <Link className="cu-trace-link" href={CONTROL_ROUTES.usersAndTeams.user(identity.userId)}>
          {display(label)}
        </Link>
      ) : (
        display(label)
      )}
      <span>Status: {statusLabel}</span>
      <span>Principal: {principalLabel}</span>
      {identity.subject && identity.subject !== label ? (
        <span>Subject: {identity.subject}</span>
      ) : null}
      {identity.userId ? <span>Platform user ID: {identity.userId}</span> : null}
      {identity.principalId && identity.principalId !== identity.userId ? (
        <span>Principal ID: {identity.principalId}</span>
      ) : null}
      {identity.identityIssuer ? (
        <span>Issuer: {identity.identityIssuer}</span>
      ) : identity.status === 'legacy' || identity.status === 'verified_late' ? (
        <span>Issuer: not recorded by the legacy producer</span>
      ) : null}
    </span>
  )
}

export function AdministrativeEventDetail({ eventId }: AdministrativeEventDetailProps) {
  const [detail, setDetail] = useState<GovernedAdministrativeEventDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshEpoch, setRefreshEpoch] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    void getGovernedAdministrativeEventDetail(eventId, controller.signal)
      .then(setDetail)
      .catch(readError => {
        if (!controller.signal.aborted) {
          setError(
            readError instanceof Error
              ? readError.message
              : 'Unable to read this administrative event.'
          )
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [eventId, refreshEpoch])

  const localControlUiAction =
    detail?.evidenceProducer.sourceKind === 'control_api_local' &&
    detail.operatorHuman.principalKind === 'control_admin'
  const targetClass =
    typeof detail?.safeFields.resource_class === 'string' ? detail.safeFields.resource_class : null
  const permissionStatus =
    typeof detail?.safeFields.status === 'string' ? detail.safeFields.status : null
  const targetCount = typeof detail?.safeFields.count === 'number' ? detail.safeFields.count : null
  const targetPrincipalKind =
    typeof detail?.safeFields.target_principal_kind === 'string'
      ? detail.safeFields.target_principal_kind
      : null
  const targetPrincipalRef =
    typeof detail?.safeFields.target_principal_ref === 'string'
      ? detail.safeFields.target_principal_ref
      : null
  const detailRef =
    typeof detail?.safeFields.detail_ref === 'string' ? detail.safeFields.detail_ref : null
  const permissionSet = detailRef?.startsWith('gfs_permissions/')
    ? detailRef.slice('gfs_permissions/'.length).split('.').filter(Boolean)
    : []
  const hasTargetHuman = Boolean(detail?.targetHuman.principalId || detail?.targetHuman.subject)
  const decisionActorMatchesOperator = Boolean(
    detail?.authorization.decisionActorSub &&
    (detail.authorization.decisionActorSub === detail.operatorHuman.principalId ||
      detail.authorization.decisionActorSub === detail.operatorHuman.subject)
  )
  const operatorLabel =
    detail?.operatorHuman.displayName ||
    detail?.operatorHuman.subject ||
    detail?.operatorHuman.principalId ||
    'Operator'
  const decisionActorLabel =
    decisionActorMatchesOperator && detail?.authorization.decisionActorSub
      ? `${operatorLabel} · ${detail.authorization.decisionActorSub}`
      : detail?.authorization.decisionActorSub

  return (
    <section className="cu-trace-layout">
      <div className="cu-card cu-card--viewport-fill cu-trace-detail">
        <TablePanelHeader
          actions={
            <button
              aria-label={
                loading ? 'Refreshing administrative event' : 'Refresh administrative event'
              }
              className="cu-trace-refresh"
              disabled={loading}
              onClick={() => setRefreshEpoch(current => current + 1)}
              title="Refresh"
              type="button"
            >
              <IconRefresh className={loading ? 'cu-spin' : undefined} height={18} width={18} />
            </button>
          }
          subtitle={`Governed event ${eventId}`}
          title="Administrative provenance"
        />
        {error ? (
          <div className="cu-banner cu-banner--error" role="alert">
            {error}
          </div>
        ) : null}
        {loading && !detail ? (
          <div className="cu-empty">Loading administrative provenance...</div>
        ) : detail ? (
          <div className="cu-trace-detail__body">
            <section className="cu-trace-detail-section" aria-labelledby="admin-provenance-chain">
              <div className="cu-trace-detail-section__head">
                <h2 id="admin-provenance-chain">Provenance chain</h2>
                <span>{formatTraceTimestamp(detail.occurredAt)}</span>
              </div>
              <ol className="cu-trace-provenance-chain">
                <li>
                  <span>Operator human</span>
                  <strong>
                    <HumanIdentity emptyLabel="System initiated" identity={detail.operatorHuman} />
                  </strong>
                </li>
                <li>
                  <span>Delegated actor</span>
                  <strong>
                    {detail.delegatedActor?.subject ??
                      (localControlUiAction
                        ? 'Not delegated (local Control UI action)'
                        : 'No delegated actor recorded')}
                  </strong>
                </li>
                <li>
                  <span>Evidence producer</span>
                  <strong>
                    {display(
                      detail.evidenceProducer.sourceService || detail.evidenceProducer.serviceSub
                    )}
                    <span>Kind: {display(detail.evidenceProducer.sourceKind)}</span>
                    <span>Service subject: {display(detail.evidenceProducer.serviceSub)}</span>
                  </strong>
                </li>
                <li>
                  <span>Authority</span>
                  <strong>Control API</strong>
                </li>
                <li>
                  <span>Target</span>
                  <strong>
                    {formatTraceLabel(detail.targetResource.type)} ·{' '}
                    {display(detail.targetResource.ref)}
                  </strong>
                </li>
              </ol>
            </section>

            <section className="cu-trace-detail-section" aria-labelledby="admin-event-facts">
              <div className="cu-trace-detail-section__head">
                <h2 id="admin-event-facts">Event and authorization</h2>
                <span className="cu-trace-state" data-state={detail.outcome ?? 'unknown'}>
                  {display(detail.outcome)}
                </span>
              </div>
              <dl className="cu-trace-facts">
                <div>
                  <dt>Action</dt>
                  <dd>{formatTraceLabel(detail.action)}</dd>
                </div>
                {targetClass ? (
                  <div>
                    <dt>Permission / approval class</dt>
                    <dd>{formatTraceLabel(targetClass)}</dd>
                  </div>
                ) : null}
                {permissionStatus ? (
                  <div>
                    <dt>Permission state</dt>
                    <dd>{formatTraceLabel(permissionStatus)}</dd>
                  </div>
                ) : null}
                {permissionSet.length ? (
                  <div>
                    <dt>Affected permissions</dt>
                    <dd>{permissionSet.map(formatTraceLabel).join(', ')}</dd>
                  </div>
                ) : null}
                <div>
                  <dt>Event ID</dt>
                  <dd className="cu-trace-monospace">{detail.eventId}</dd>
                </div>
                <div>
                  <dt>Occurred / ingested</dt>
                  <dd>
                    {formatTraceTimestamp(detail.occurredAt)} /{' '}
                    {formatTraceTimestamp(detail.ingestedAt)}
                  </dd>
                </div>
                <div>
                  <dt>Protected audience</dt>
                  <dd>
                    {detail.authorization.resourceAud ??
                      (localControlUiAction
                        ? 'Not recorded by legacy producer'
                        : 'No protected audience recorded')}
                  </dd>
                </div>
                <div>
                  <dt>Effective scopes</dt>
                  <dd>
                    {detail.authorization.effectiveScopes.join(', ') ||
                      (localControlUiAction
                        ? 'No delegated scopes (administrator role)'
                        : 'No effective scopes recorded')}
                  </dd>
                </div>
                <div>
                  <dt>Authorization decision</dt>
                  <dd>
                    {detail.authorization.decision ??
                      (localControlUiAction
                        ? 'Not recorded by legacy producer'
                        : 'No decision recorded')}
                  </dd>
                </div>
                <div>
                  <dt>Decision actor</dt>
                  <dd>
                    {decisionActorLabel ??
                      (localControlUiAction
                        ? 'Not recorded by legacy producer'
                        : 'No decision actor recorded')}
                  </dd>
                </div>
                {detail.authorization.approvalRequestId ||
                detail.authorization.decision === 'require_approval' ? (
                  <div>
                    <dt>Approval request</dt>
                    <dd className="cu-trace-monospace">
                      {detail.authorization.approvalRequestId ?? 'Correlation not recorded'}
                    </dd>
                  </div>
                ) : null}
                <div>
                  <dt>Token exchange reference</dt>
                  <dd>
                    {detail.authorization.tokenExchangeId ??
                      (localControlUiAction
                        ? 'Not used (local Control UI session)'
                        : 'No token exchange recorded')}
                  </dd>
                </div>
                {detail.authorization.requestId || detail.authorization.operationId ? (
                  <div>
                    <dt>Request / operation correlation</dt>
                    <dd>
                      {detail.authorization.requestId
                        ? `Request ${detail.authorization.requestId}`
                        : 'No request ID recorded'}
                      {detail.authorization.operationId
                        ? ` · Operation ${detail.authorization.operationId}`
                        : ''}
                    </dd>
                  </div>
                ) : null}
                {detail.authorization.relatedRunId ? (
                  <div>
                    <dt>Related governed run</dt>
                    <dd>{detail.authorization.relatedRunId}</dd>
                  </div>
                ) : null}
              </dl>
            </section>

            <ReleasedTraceFacts
              facts={{
                environment: detail.context.environment,
                namespace: detail.context.namespace,
                deployment_ref: detail.context.deploymentRef,
                team_id: detail.context.teamId,
                team_name: detail.context.teamDisplayName,
                source_audit_ref: detail.provenance.sourceAuditRef,
                source_adapter_kind: detail.provenance.sourceAdapterKind,
                source_adapter_version: detail.provenance.sourceAdapterVersion,
                code_digest: detail.provenance.codeDigest,
                config_digest: detail.provenance.configDigest,
                policy_digest: detail.provenance.policyDigest,
                authorization_ref: detail.provenance.authorizationRef,
                effect_ref: detail.provenance.effectRef,
                pre_state_digest: detail.provenance.preStateDigest,
                post_state_digest: detail.provenance.postStateDigest,
                payload_sha256: detail.provenance.payloadSha256,
              }}
              headingId="admin-stored-context-provenance"
              title="Stored context and provenance"
            />

            <section className="cu-trace-detail-section" aria-labelledby="admin-target-human">
              <div className="cu-trace-detail-section__head">
                <h2 id="admin-target-human">
                  {detail.context.teamId
                    ? 'Target team'
                    : hasTargetHuman
                      ? 'Target platform user'
                      : targetPrincipalRef
                        ? 'Target principal'
                        : 'Target platform user'}
                </h2>
              </div>
              {hasTargetHuman ? (
                <HumanIdentity emptyLabel="No platform user target" identity={detail.targetHuman} />
              ) : (
                <div className="cu-empty">
                  {detail.context.teamId ? (
                    <>
                      Target team:{' '}
                      <Link
                        className="cu-trace-link"
                        href={CONTROL_ROUTES.usersAndTeams.team(detail.context.teamId)}
                      >
                        {detail.context.teamDisplayName || detail.context.teamId}
                      </Link>
                      . This event records the team principal; it does not infer individual members
                      that were not stored with the event.
                    </>
                  ) : targetPrincipalRef ? (
                    <>
                      Target {formatTraceLabel(targetPrincipalKind || 'service')}:{' '}
                      <span className="cu-trace-monospace">{targetPrincipalRef}</span>
                    </>
                  ) : targetClass === 'platform_user' && targetCount && targetCount > 1 ? (
                    `${targetCount} platform users were affected; this bulk event has no singular target identity.`
                  ) : targetClass === 'team' ? (
                    `This action targets ${targetCount ?? 0} team${targetCount === 1 ? '' : 's'}, not a platform user.`
                  ) : (
                    'This is a service or resource-level change with no platform user target.'
                  )}
                </div>
              )}
            </section>
            <ReleasedTraceFacts facts={detail.safeFields} headingId="admin-released-event-facts" />
          </div>
        ) : !loading ? (
          <div className="cu-empty">This administrative event is unavailable.</div>
        ) : null}
      </div>
    </section>
  )
}
