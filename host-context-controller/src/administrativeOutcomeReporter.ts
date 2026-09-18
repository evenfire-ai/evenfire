import { BoundedOffPathReporter } from './boundedOffPathReporter'
import { config } from './config'
import { administrativeOutcomeReporterTotal } from './metrics'
import { throwForFailedSubmit } from './reporterHttpFailure'
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
  dedupeCapacity?: number
}

const DEFAULT_CAPACITY = 64
const DEFAULT_RETRY_LIMIT = 2
const DEFAULT_TIMEOUT_MS = 1_000
const DEFAULT_STOP_TIMEOUT_MS = 1_500
const DEFAULT_DEDUPE_CAPACITY = 1_024

/**
 * pending: queued or in flight. accepted: control-api stored or replayed it.
 * terminal: control-api rejected it deterministically (conflict or unsafe input).
 */
type SubmissionState = 'pending' | 'accepted' | 'terminal'

export class BoundedAdministrativeOutcomeReporter implements AdministrativeOutcomeReporter {
  private readonly queue: BoundedOffPathReporter<AdministrativeHostOutcomeProjection>
  private readonly timeoutMs: number
  private readonly baseUrl: string
  private readonly signToken: () => string
  private readonly fetchFn: typeof fetch
  private readonly dedupeCapacity: number
  // The reconciler re-observes the same outcome on every pass (3-4 fleet
  // passes per 5 minutes) and its sourceEventId is deterministic, so each
  // fact is sent once per process (#327). Insertion order doubles as the
  // eviction order.
  private readonly submissions = new Map<string, SubmissionState>()

  constructor(deps: AdministrativeOutcomeReporterDependencies) {
    const capacity = deps.capacity ?? DEFAULT_CAPACITY
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new Error('administrative outcome reporter capacity must be a positive integer')
    }
    const dedupeCapacity = deps.dedupeCapacity ?? DEFAULT_DEDUPE_CAPACITY
    if (!Number.isSafeInteger(dedupeCapacity) || dedupeCapacity < 1) {
      throw new Error('administrative outcome reporter dedupeCapacity must be a positive integer')
    }
    this.dedupeCapacity = dedupeCapacity
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
      onAccepted: projection => {
        this.settle(projection.sourceEventId, 'accepted')
        administrativeOutcomeReporterTotal.inc({ result: 'accepted' })
      },
      onTerminal: (projection, result) => {
        this.settle(projection.sourceEventId, 'terminal')
        administrativeOutcomeReporterTotal.inc({ result })
      },
      onDrop: (projection, reason) => {
        // A dropped outcome was never settled; forgetting it lets the next
        // reconcile pass enqueue it again, so no outcome is lost.
        this.submissions.delete(projection.sourceEventId)
        administrativeOutcomeReporterTotal.inc({ result: reason })
      },
    })
  }

  enqueueHostOutcome(projection: AdministrativeHostOutcomeProjection): void {
    if (this.submissions.has(projection.sourceEventId)) {
      administrativeOutcomeReporterTotal.inc({ result: 'deduplicated' })
      return
    }
    this.remember(projection.sourceEventId, 'pending')
    this.queue.enqueue({ ...projection, hostRef: { ...projection.hostRef } })
  }

  private remember(sourceEventId: string, state: SubmissionState): void {
    if (this.submissions.size >= this.dedupeCapacity) {
      const oldest = this.submissions.keys().next().value
      if (oldest !== undefined) this.submissions.delete(oldest)
    }
    this.submissions.set(sourceEventId, state)
  }

  private settle(sourceEventId: string, state: 'accepted' | 'terminal'): void {
    // An entry evicted while in flight is not re-added: it would displace a
    // newer key, and a resend after eviction is accepted as a replay anyway.
    if (this.submissions.has(sourceEventId)) this.submissions.set(sourceEventId, state)
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
      await throwForFailedSubmit(response, 'administrative outcome')
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
