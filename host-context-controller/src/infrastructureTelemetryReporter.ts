import { createHash } from 'crypto'
import { BoundedOffPathReporter, type BoundedReporterDropReason } from './boundedOffPathReporter'
import { config } from './config'
import {
  infrastructureTelemetryDroppedTotal,
  infrastructureTelemetryEnqueuedTotal,
  infrastructureTelemetryFlushesTotal,
  infrastructureTelemetryGapsTotal,
  infrastructureTelemetryRetriesTotal,
} from './metrics'
import { signInternalControlJwt } from './utils/internalControlSigner'

export type HccHealthTransitionProjection = {
  sourceEventId: string
  occurredAt: string
  hostLookupReference: { name: string; namespace: string; generation?: number }
  payload: { transition: string; state: string }
}

export type HccInfrastructureTelemetryType =
  | 'health_transition'
  | 'lifecycle_transition'
  | 'reconcile_outcome'
  | 'controller_error'

export type HccInfrastructureTelemetryPayload = {
  reason_code?: string
  error_class?: string
  phase?: string
  state?: string
  status?: string
  transition?: string
  resource_class?: string
  summary?: string
  detail_ref?: string
  attempt?: number
  count?: number
  gfs_subject?: string
  gfs_outcome?: 'minted' | 'rotated' | 'reused' | 'failed'
  gfs_old_host_uid?: string
  gfs_new_host_uid?: string
}

type HccInfrastructureTelemetryProjectionBase = {
  occurredAt: string
  hostLookupReference: { name: string; namespace: string; generation?: number }
  payload?: HccInfrastructureTelemetryPayload
}

type HccReconcileOutcomeProjection = HccInfrastructureTelemetryProjectionBase & {
  telemetryType: 'reconcile_outcome'
  sourceEventId?: never
}

type HccOccurrenceProjection = HccInfrastructureTelemetryProjectionBase & {
  telemetryType: Exclude<HccInfrastructureTelemetryType, 'reconcile_outcome'>
  sourceEventId: string
}

export type HccInfrastructureTelemetryProjection =
  | HccReconcileOutcomeProjection
  | HccOccurrenceProjection

export function hccReconcileOutcomeSourceId(projection: HccReconcileOutcomeProjection): string {
  const payload = projection.payload ?? {}
  const canonical = [
    projection.hostLookupReference.namespace,
    projection.hostLookupReference.name,
    projection.hostLookupReference.generation ?? 0,
    payload.reason_code ?? null,
    payload.error_class ?? null,
    payload.phase ?? null,
    payload.state ?? null,
    payload.status ?? null,
    payload.transition ?? null,
    payload.resource_class ?? null,
    payload.summary ?? null,
    payload.detail_ref ?? null,
    payload.attempt ?? null,
    payload.count ?? null,
    payload.gfs_subject ?? null,
    payload.gfs_outcome ?? null,
    payload.gfs_old_host_uid ?? null,
    payload.gfs_new_host_uid ?? null,
  ]
  return `hcc-reconcile-outcome-v2:${createHash('sha256').update(JSON.stringify(canonical)).digest('hex')}`
}

export interface InfrastructureTelemetryReporter {
  enqueueHealthTransition(projection: HccHealthTransitionProjection): void
  enqueue(projection: HccInfrastructureTelemetryProjection): void
  stop(timeoutMs?: number): Promise<void>
}

type ReporterDependencies = {
  baseUrl?: string
  signToken?: () => string
  fetchFn?: typeof fetch
  capacity?: number
  retryLimit?: number
  timeoutMs?: number
  random?: () => number
  deriveReconcileSourceEventId?: (projection: HccReconcileOutcomeProjection) => string
}

type BufferedProjection = HccInfrastructureTelemetryProjection & {
  resolvedSourceEventId?: string
}

const DEFAULT_CAPACITY = 64
const DEFAULT_RETRY_LIMIT = 2
const DEFAULT_TIMEOUT_MS = 1_000
const DEFAULT_STOP_TIMEOUT_MS = 1_500

/** Off-path reporter: enqueue is synchronous and does no I/O or serialization. */
export class BoundedInfrastructureTelemetryReporter implements InfrastructureTelemetryReporter {
  private readonly queue: BoundedOffPathReporter<BufferedProjection>
  private readonly timeoutMs: number
  private readonly baseUrl: string
  private readonly signToken: () => string
  private readonly fetchFn: typeof fetch
  private readonly deriveReconcileSourceEventId: (
    projection: HccReconcileOutcomeProjection
  ) => string

  constructor(deps: ReporterDependencies = {}) {
    const capacity = deps.capacity ?? DEFAULT_CAPACITY
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new Error('infrastructure telemetry reporter capacity must be a positive integer')
    }
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.baseUrl = (deps.baseUrl ?? config.controlApiBaseUrl).replace(/\/$/, '')
    this.signToken = deps.signToken ?? signInternalControlJwt
    this.fetchFn = deps.fetchFn ?? fetch
    this.deriveReconcileSourceEventId =
      deps.deriveReconcileSourceEventId ?? hccReconcileOutcomeSourceId
    this.queue = new BoundedOffPathReporter({
      capacity,
      retryLimit: deps.retryLimit ?? DEFAULT_RETRY_LIMIT,
      stopTimeoutMs: DEFAULT_STOP_TIMEOUT_MS,
      random: deps.random ?? Math.random,
      submit: projection => this.submit(projection),
      onEnqueued: projection =>
        infrastructureTelemetryEnqueuedTotal.inc({ telemetry_type: projection.telemetryType }),
      onAccepted: () => infrastructureTelemetryFlushesTotal.inc({ result: 'accepted' }),
      onRetry: projection =>
        infrastructureTelemetryRetriesTotal.inc({ telemetry_type: projection.telemetryType }),
      onDrop: (projection, reason) => this.recordDrop(projection.telemetryType, reason),
    })
  }

  enqueueHealthTransition(projection: HccHealthTransitionProjection): void {
    this.enqueue({ ...projection, telemetryType: 'health_transition' })
  }

  enqueue(projection: HccInfrastructureTelemetryProjection): void {
    this.queue.enqueue({
      ...projection,
      hostLookupReference: { ...projection.hostLookupReference },
      ...(projection.payload ? { payload: { ...projection.payload } } : {}),
    })
  }

  private recordDrop(
    telemetryType: HccInfrastructureTelemetryType,
    reason: BoundedReporterDropReason
  ): void {
    if (reason === 'retry_exhausted' || reason === 'shutdown_submit_failed') {
      infrastructureTelemetryFlushesTotal.inc({ result: 'exhausted' })
    }
    infrastructureTelemetryDroppedTotal.inc({ telemetry_type: telemetryType, reason })
    infrastructureTelemetryGapsTotal.inc({ telemetry_type: telemetryType, reason })
  }

  stop(timeoutMs?: number): Promise<void> {
    return this.queue.stop(timeoutMs)
  }

  private async submit(projection: BufferedProjection): Promise<void> {
    if (projection.telemetryType === 'reconcile_outcome' && !projection.resolvedSourceEventId) {
      projection.resolvedSourceEventId = this.deriveReconcileSourceEventId(projection)
    }
    const sourceEventId =
      projection.telemetryType === 'reconcile_outcome'
        ? projection.resolvedSourceEventId
        : projection.sourceEventId
    if (!sourceEventId) throw new Error('reconcile source identity was not resolved')
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await this.fetchFn(
        `${this.baseUrl}/api/v1/internal/tracing/infrastructure-telemetry-events`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.signToken()}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            events: [
              {
                sourceEventId,
                occurredAt: projection.occurredAt,
                telemetryType: projection.telemetryType,
                hostLookupReference: projection.hostLookupReference,
                ...(projection.payload ? { payload: projection.payload } : {}),
              },
            ],
          }),
          signal: controller.signal,
        }
      )
      if (!response.ok) throw new Error(`telemetry submit failed with ${response.status}`)
    } finally {
      clearTimeout(timeout)
    }
  }
}

export function createInfrastructureTelemetryReporter(
  enabled: boolean,
  deps: ReporterDependencies
): InfrastructureTelemetryReporter | undefined {
  if (!enabled) return undefined
  return new BoundedInfrastructureTelemetryReporter(deps)
}
