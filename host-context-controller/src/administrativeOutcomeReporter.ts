import { BoundedOffPathReporter } from './boundedOffPathReporter'
import { config } from './config'
import { administrativeOutcomeReporterTotal } from './metrics'
import { signInternalControlJwt } from './utils/internalControlSigner'

export type AdministrativeHostOutcomeProjection = {
  sourceEventId: string
  occurredAt: string
  hostRef: { name: string; namespace: string; generation: number }
  outcome: 'succeeded' | 'failed'
  reasonCode: string
}

export interface AdministrativeOutcomeReporter {
  enqueueHostOutcome(projection: AdministrativeHostOutcomeProjection): void
  stop(timeoutMs?: number): Promise<void>
}

export type AdministrativeOutcomeReporterDependencies = {
  baseUrl?: string
  signToken?: () => string
  fetchFn?: typeof fetch
  capacity?: number
  retryLimit?: number
  timeoutMs?: number
  random?: () => number
}

const DEFAULT_CAPACITY = 64
const DEFAULT_RETRY_LIMIT = 2
const DEFAULT_TIMEOUT_MS = 1_000
const DEFAULT_STOP_TIMEOUT_MS = 1_500

export class BoundedAdministrativeOutcomeReporter implements AdministrativeOutcomeReporter {
  private readonly queue: BoundedOffPathReporter<AdministrativeHostOutcomeProjection>
  private readonly timeoutMs: number
  private readonly baseUrl: string
  private readonly signToken: () => string
  private readonly fetchFn: typeof fetch

  constructor(deps: AdministrativeOutcomeReporterDependencies) {
    const capacity = deps.capacity ?? DEFAULT_CAPACITY
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new Error('administrative outcome reporter capacity must be a positive integer')
    }
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.baseUrl = (deps.baseUrl ?? config.controlApiBaseUrl).replace(/\/$/, '')
    this.signToken = deps.signToken ?? signInternalControlJwt
    this.fetchFn = deps.fetchFn ?? fetch
    this.queue = new BoundedOffPathReporter({
      capacity,
      retryLimit: deps.retryLimit ?? DEFAULT_RETRY_LIMIT,
      stopTimeoutMs: DEFAULT_STOP_TIMEOUT_MS,
      random: deps.random ?? Math.random,
      submit: projection => this.submit(projection),
      onEnqueued: () => administrativeOutcomeReporterTotal.inc({ result: 'enqueued' }),
      onAccepted: () => administrativeOutcomeReporterTotal.inc({ result: 'accepted' }),
      onDrop: (_projection, reason) => administrativeOutcomeReporterTotal.inc({ result: reason }),
    })
  }

  enqueueHostOutcome(projection: AdministrativeHostOutcomeProjection): void {
    this.queue.enqueue({ ...projection, hostRef: { ...projection.hostRef } })
  }

  stop(timeoutMs?: number): Promise<void> {
    return this.queue.stop(timeoutMs)
  }

  private async submit(projection: AdministrativeHostOutcomeProjection): Promise<void> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await this.fetchFn(
        `${this.baseUrl}/api/v1/internal/tracing/administrative-events`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.signToken()}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            events: [
              {
                sourceEventId: projection.sourceEventId,
                occurredAt: projection.occurredAt,
                kind: 'linked_outcome',
                reasonCode: projection.reasonCode,
                sourceStatusRef: `host:${projection.hostRef.namespace}/${projection.hostRef.name}:generation=${projection.hostRef.generation}`,
                payload: {
                  resource_class: 'Host',
                  status: projection.outcome,
                },
              },
            ],
          }),
          signal: controller.signal,
        }
      )
      if (!response.ok) {
        throw new Error(`administrative outcome submit failed with ${response.status}`)
      }
    } finally {
      clearTimeout(timeout)
    }
  }
}

export function createAdministrativeOutcomeReporter(
  enabled: boolean,
  deps: AdministrativeOutcomeReporterDependencies
): AdministrativeOutcomeReporter | undefined {
  if (!enabled) return undefined
  return new BoundedAdministrativeOutcomeReporter(deps)
}
