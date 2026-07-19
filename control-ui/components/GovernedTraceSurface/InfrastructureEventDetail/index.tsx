'use client'

import { useEffect, useState } from 'react'
import { TablePanelHeader } from '@components/TablePanelHeader'
import { IconRefresh } from '@components/icons'
import { getGovernedInfrastructureEventDetail } from '@lib/governedTrace'
import type { GovernedInfrastructureEventDetail } from '@lib/governedTrace'
import { ReleasedTraceFacts } from '../ReleasedTraceFacts'
import { displayTraceValue as display, formatTraceTimestamp } from '../formatters'
import type { InfrastructureEventDetailProps } from './types'

export function InfrastructureEventDetail({ eventId }: InfrastructureEventDetailProps) {
  const [detail, setDetail] = useState<GovernedInfrastructureEventDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshEpoch, setRefreshEpoch] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    void getGovernedInfrastructureEventDetail(eventId, controller.signal)
      .then(setDetail)
      .catch(readError => {
        if (!controller.signal.aborted) {
          setError(
            readError instanceof Error
              ? readError.message
              : 'Unable to read this infrastructure event.'
          )
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [eventId, refreshEpoch])

  const hasSourceAdapter = Boolean(
    detail?.source.sourceAdapterKind || detail?.source.sourceAdapterVersion
  )
  const hasCorrelation = Boolean(
    detail?.correlation.operationId ||
    detail?.correlation.runId ||
    detail?.correlation.authorizationRef ||
    detail?.correlation.effectRef
  )

  return (
    <section className="cu-trace-layout">
      <div className="cu-card cu-card--viewport-fill cu-trace-detail">
        <TablePanelHeader
          actions={
            <button
              aria-label={
                loading ? 'Refreshing infrastructure event' : 'Refresh infrastructure event'
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
          title="Infrastructure telemetry detail"
        />
        {error ? (
          <div className="cu-banner cu-banner--error" role="alert">
            {error}
          </div>
        ) : null}
        {loading && !detail ? (
          <div className="cu-empty">Loading infrastructure telemetry...</div>
        ) : detail ? (
          <div className="cu-trace-detail__body">
            <dl aria-label="Infrastructure event summary" className="cu-trace-summary" role="group">
              <div>
                <dt>Telemetry</dt>
                <dd>{detail.telemetryType}</dd>
              </div>
              <div>
                <dt>Outcome</dt>
                <dd>{display(detail.outcome)}</dd>
              </div>
              {detail.reasonCode ? (
                <div>
                  <dt>Reason</dt>
                  <dd>{detail.reasonCode}</dd>
                </div>
              ) : null}
              <div>
                <dt>Trigger</dt>
                <dd>{display(detail.triggerKind)}</dd>
              </div>
              <div>
                <dt>Occurred</dt>
                <dd>{formatTraceTimestamp(detail.occurredAt)}</dd>
              </div>
            </dl>

            <section className="cu-trace-detail-section" aria-labelledby="infra-source-scope">
              <div className="cu-trace-detail-section__head">
                <h2 id="infra-source-scope">Source and object scope</h2>
              </div>
              <dl className="cu-trace-facts">
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
                  <dt>Source kind</dt>
                  <dd>{display(detail.source.sourceKind)}</dd>
                </div>
                <div>
                  <dt>Source service</dt>
                  <dd>{display(detail.source.sourceService)}</dd>
                </div>
                <div>
                  <dt>Controller</dt>
                  <dd>{display(detail.source.controller)}</dd>
                </div>
                <div>
                  <dt>Source occurrence</dt>
                  <dd className="cu-trace-monospace">
                    {display(detail.source.sourceOccurrenceId)}
                  </dd>
                </div>
                {hasSourceAdapter ? (
                  <div>
                    <dt>Source adapter</dt>
                    <dd>
                      {detail.source.sourceAdapterKind ?? 'Kind not recorded'} /{' '}
                      {detail.source.sourceAdapterVersion ?? 'Version not recorded'}
                    </dd>
                  </div>
                ) : null}
                <div>
                  <dt>Environment</dt>
                  <dd>{display(detail.scope.environment)}</dd>
                </div>
                <div>
                  <dt>Cluster / namespace</dt>
                  <dd>
                    {display(detail.scope.clusterName)} / {display(detail.scope.namespace)}
                  </dd>
                </div>
                <div>
                  <dt>Workload</dt>
                  <dd>
                    {display(detail.scope.workloadKind)} / {display(detail.scope.workloadRef)}
                  </dd>
                </div>
                <div>
                  <dt>Kubernetes object reference</dt>
                  <dd>
                    {display(detail.scope.kubernetesKind)} / {display(detail.scope.kubernetesName)}{' '}
                    / {detail.scope.kubernetesUid ?? 'UID not captured by legacy sampler'}
                  </dd>
                </div>
                <div>
                  <dt>Metadata generation</dt>
                  <dd>
                    {detail.scope.metadataGeneration ?? 'Generation not captured by legacy sampler'}
                  </dd>
                </div>
              </dl>
            </section>

            {hasCorrelation ? (
              <section className="cu-trace-detail-section" aria-labelledby="infra-correlation">
                <div className="cu-trace-detail-section__head">
                  <h2 id="infra-correlation">Stored correlation</h2>
                </div>
                <dl className="cu-trace-facts">
                  {detail.correlation.runId ? (
                    <div>
                      <dt>Related governed run</dt>
                      <dd>{detail.correlation.runId}</dd>
                    </div>
                  ) : null}
                  {detail.correlation.operationId ? (
                    <div>
                      <dt>Related operation</dt>
                      <dd>{detail.correlation.operationId}</dd>
                    </div>
                  ) : null}
                  {detail.correlation.authorizationRef ? (
                    <div>
                      <dt>Authorization reference</dt>
                      <dd>{detail.correlation.authorizationRef}</dd>
                    </div>
                  ) : null}
                  {detail.correlation.effectRef ? (
                    <div>
                      <dt>Effect reference</dt>
                      <dd>{detail.correlation.effectRef}</dd>
                    </div>
                  ) : null}
                </dl>
              </section>
            ) : null}
            {detail.telemetryType === 'capacity_sample' ? (
              <div className="cu-table__cell-muted">
                This event samples Deployment capacity and resource requests. Measured CPU and
                memory usage requires a separate usage sample and is not inferred here.
              </div>
            ) : null}
            <ReleasedTraceFacts
              facts={{
                ...detail.safeFields,
                interval_start: detail.interval.start,
                interval_end: detail.interval.end,
                desired_replicas: detail.capacity.desiredReplicas,
                observed_replicas: detail.capacity.observedReplicas,
                ready_replicas: detail.capacity.readyReplicas,
                cpu_request_cores: detail.capacity.cpuRequestCores,
                cpu_limit_cores: detail.capacity.cpuLimitCores,
                memory_request_bytes: detail.capacity.memoryRequestBytes,
                memory_limit_bytes: detail.capacity.memoryLimitBytes,
                cpu_usage_core_seconds: detail.usage.cpuUsageCoreSeconds,
                memory_usage_byte_seconds: detail.usage.memoryUsageByteSeconds,
              }}
              headingId="infra-capacity-usage-facts"
              title="Capacity and sampling inputs"
            />
            <ReleasedTraceFacts
              facts={{
                code_digest: detail.integrity.codeDigest,
                config_digest: detail.integrity.configDigest,
                policy_digest: detail.integrity.policyDigest,
                pre_state_digest: detail.integrity.preStateDigest,
                post_state_digest: detail.integrity.postStateDigest,
                payload_sha256: detail.integrity.payloadSha256,
              }}
              headingId="infra-integrity-facts"
              title="Stored integrity evidence"
            />
          </div>
        ) : !loading ? (
          <div className="cu-empty">This infrastructure event is unavailable.</div>
        ) : null}
      </div>
    </section>
  )
}
