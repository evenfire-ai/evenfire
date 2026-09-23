import { BoundedOffPathReporter } from './boundedOffPathReporter'
import { config } from './config'
import { administrativeOutcomeReporterTotal } from './metrics'
import { throwForFailedSubmit } from './reporterHttpFailure'
import { signInternalControlJwt } from './utils/internalControlSigner'

export type AdministrativeHostOutcomeProjection = {
  sourceEventId: string
  occurredAt: string
  /**
   * `uid` is required: a Host deleted and recreated under the same name
   * restarts at generation 1, so namespace/name/generation alone can name two
   * different objects. control-api resolves the binding against the live
   * object's metadata.uid and refuses the reference without it (#694).
   */
  hostRef: { name: string; namespace: string; generation: number; uid: string }
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

export class BoundedAdministrativeOutcomeReporter implements AdministrativeOutcomeReporter {
  private readonly queue: BoundedOffPathReporter<AdministrativeHostOutcomeProjection>
  private readonly timeoutMs: number
  private readonly baseUrl: string
  private readonly signToken: () => string
  private readonly fetchFn: typeof fetch
  private readonly dedupeCapacity: number
  // The reconciler re-observes the same outcome on every pass (3-4 fleet
  // passes per 5 minutes) and its sourceEventId is deterministic, so each
  // fact is sent once per process (#327). A key stays here while it is queued,
  // in flight, accepted or rejected as terminal; only a drop removes it.
  // Iteration order is least recently seen first, which is the eviction
  // order. Past `dedupeCapacity` distinct keys per pass, the oldest are
  // evicted and resent; control-api answers those resends as replays.
  private readonly seen = new Set<string>()

  constructor(deps: AdministrativeOutcomeReporterDependencies) {
    const capacity = deps.capacity ?? DEFAULT_CAPACITY
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new Error('administrative outcome reporter capacity must be a positive integer')
    }
    const dedupeCapacity = deps.dedupeCapacity ?? DEFAULT_DEDUPE_CAPACITY
    // Up to `capacity` keys are buffered plus one in flight. A smaller set
    // would evict a key that is still queued, and the next pass would queue
    // it a second time.
    if (!Number.isSafeInteger(dedupeCapacity) || dedupeCapacity <= capacity) {
      throw new Error(
        'administrative outcome reporter dedupeCapacity must be an integer greater than capacity'
      )
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
      onAccepted: () => administrativeOutcomeReporterTotal.inc({ result: 'accepted' }),
      onTerminal: (_projection, result) => administrativeOutcomeReporterTotal.inc({ result }),
      onDrop: (projection, reason) => {
        // A dropped outcome was never delivered; forgetting it lets the next
        // reconcile pass enqueue it again, so no outcome is lost.
        this.seen.delete(projection.sourceEventId)
        administrativeOutcomeReporterTotal.inc({ result: reason })
      },
    })
  }

  /**
   * Deduplicates on the `sourceEventId` this reporter is handed, which it
   * treats as opaque. Its caller builds it without the `reasonCode`
   * (hostReconciler.ts, `enqueueAdministrativeOutcome`), so for one operation,
   * generation, Host uid and outcome the first failure wins and later ones are
   * deduplicated. That matches the server, which hashes the `reasonCode` into
   * the stored row: a second `failed` with another reason under the same key
   * would come back 409 and never be stored either. The per-reason detail is
   * not lost — `controller_error` keeps it in full, with a unique occurrence id
   * per event (#696).
   *
   * `seen` is a bounded LRU, so "the first one wins" holds only while the key
   * is still resident. A key evicted under load is enqueued again and refused
   * by the server as a 409 instead, which this reporter treats as terminal.
   */
  enqueueHostOutcome(projection: AdministrativeHostOutcomeProjection): void {
    const { sourceEventId } = projection
    if (this.seen.delete(sourceEventId)) {
      // Re-inserted as most recently seen, so a key observed on every pass is
      // not evicted behind keys observed once.
      this.seen.add(sourceEventId)
      administrativeOutcomeReporterTotal.inc({ result: 'deduplicated' })
      return
    }
    if (this.seen.size >= this.dedupeCapacity) {
      const oldest = this.seen.values().next().value
      if (oldest !== undefined) this.seen.delete(oldest)
    }
    this.seen.add(sourceEventId)
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
                // Parsed by STATUS_REF in
                // control-api/src/services/tracing/adminOperationBindingResolver.ts.
                // The two packages cannot import each other, so each side pins
                // the same example string in its tests (#694).
                sourceStatusRef: `host:${projection.hostRef.namespace}/${projection.hostRef.name}:generation=${projection.hostRef.generation}:uid=${projection.hostRef.uid}`,
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
