const COMMUNICATION_CHANNEL_FLEET_RETRY_DELAYS_MS = [5000, 15000, 30000, 60000, 300000] as const

export type HostFleetReconcileMode = 'full' | 'lifecycle'

export type HostFleetReconcileRequest = {
  reason: string
  mode: HostFleetReconcileMode
  ccLifecycleGeneration?: number
  inputRevision: number
}

type PendingHostFleetReconcile = HostFleetReconcileRequest & {
  promise: Promise<void>
  resolve: () => void
}

type ActiveHostFleetReconcile = HostFleetReconcileRequest & {
  promise: Promise<void>
}

export type HostFleetRequestResult = 'started' | 'coalesced' | 'trailing'

type HostFleetSchedulerDependencies = {
  perform: (request: HostFleetReconcileRequest) => Promise<void>
  recordRequest: (result: HostFleetRequestResult) => void
}

// Exported for property coverage (hostFleetScheduler.properties.test.ts): this is
// a (state, input) -> boolean precedence predicate whose invariants (reflexivity,
// mode/revision/generation precedence) must hold as the request shape evolves.
export function hostFleetRequestCovers(
  active: HostFleetReconcileRequest,
  requested: HostFleetReconcileRequest
): boolean {
  const modeCovered = active.mode === 'full' || requested.mode === 'lifecycle'
  if (!modeCovered) return false
  if (active.inputRevision !== requested.inputRevision) return false
  if (requested.ccLifecycleGeneration === undefined) return true
  return active.ccLifecycleGeneration === requested.ccLifecycleGeneration
}

// Exported for property coverage: this is the (state, input) -> state merge whose
// idempotency / commutativity / associativity / no-drop invariants must survive
// changes to the request shape (the PR added the `inputRevision` dimension).
export function mergeHostFleetRequests(
  pending: HostFleetReconcileRequest,
  requested: HostFleetReconcileRequest
): HostFleetReconcileRequest {
  const pendingGeneration = pending.ccLifecycleGeneration
  const requestedGeneration = requested.ccLifecycleGeneration
  return {
    reason: requested.reason,
    mode: pending.mode === 'full' || requested.mode === 'full' ? 'full' : 'lifecycle',
    inputRevision: Math.max(pending.inputRevision, requested.inputRevision),
    ccLifecycleGeneration:
      pendingGeneration === undefined
        ? requestedGeneration
        : requestedGeneration === undefined
          ? pendingGeneration
          : Math.max(pendingGeneration, requestedGeneration),
  }
}

/**
 * Owns temporal coordination for Host fleet convergence. Kubernetes reads and
 * mutations stay behind `perform`, so this scheduler only serializes requests,
 * coalesces a single trailing pass, and manages lifecycle retry/shutdown state.
 */
export class HostFleetScheduler {
  private ccLifecycleGeneration = 0
  private ccAppliedLifecycleGeneration = -1
  private ccFleetRetryTimer: ReturnType<typeof setTimeout> | null = null
  private ccFleetRetryAttempt = 0
  private hostFleetReconcileInFlight: ActiveHostFleetReconcile | null = null
  private hostFleetReconcilePending: PendingHostFleetReconcile | null = null
  private hostFleetInputRevision = 0
  private resolveHostFleetShutdown: () => void = () => {}
  private readonly hostFleetShutdown = new Promise<void>(resolve => {
    this.resolveHostFleetShutdown = resolve
  })
  private stopped = false

  constructor(private readonly dependencies: HostFleetSchedulerDependencies) {}

  get currentLifecycleGeneration(): number {
    return this.ccLifecycleGeneration
  }

  get appliedLifecycleGeneration(): number {
    return this.ccAppliedLifecycleGeneration
  }

  beginLifecycleTransition(): number {
    this.ccLifecycleGeneration += 1
    this.ccFleetRetryAttempt = 0
    this.clearLifecycleRetry()
    return this.ccLifecycleGeneration
  }

  bumpInputRevision(): number {
    this.hostFleetInputRevision += 1
    return this.hostFleetInputRevision
  }

  markLifecycleApplied(generation: number): void {
    if (generation !== this.ccLifecycleGeneration) return
    this.ccAppliedLifecycleGeneration = generation
    this.ccFleetRetryAttempt = 0
    this.clearLifecycleRetry()
  }

  scheduleLifecycleRetry(request: HostFleetReconcileRequest): void {
    const generation = request.ccLifecycleGeneration
    if (generation === undefined) return
    if (
      this.stopped ||
      generation !== this.ccLifecycleGeneration ||
      generation === this.ccAppliedLifecycleGeneration ||
      this.ccFleetRetryTimer
    ) {
      return
    }

    const delayIndex = Math.min(
      this.ccFleetRetryAttempt,
      COMMUNICATION_CHANNEL_FLEET_RETRY_DELAYS_MS.length - 1
    )
    const retryDelay = COMMUNICATION_CHANNEL_FLEET_RETRY_DELAYS_MS[delayIndex]
    this.ccFleetRetryAttempt += 1
    this.ccFleetRetryTimer = setTimeout(() => {
      this.ccFleetRetryTimer = null
      if (
        this.stopped ||
        generation !== this.ccLifecycleGeneration ||
        generation === this.ccAppliedLifecycleGeneration
      ) {
        return
      }
      void this.request(
        'CommunicationChannel lifecycle convergence retry',
        generation,
        request.mode
      )
    }, retryDelay)
  }

  /**
   * Cache transitions, periodic resyncs, and retries share one active pass and
   * at most one merged trailing pass. Each caller waits only for work covering
   * its request, keeping startup bounded under a sustained retry stream.
   */
  request(
    reason: string,
    ccLifecycleGeneration?: number,
    mode?: HostFleetReconcileMode
  ): Promise<void> {
    if (this.stopped) return Promise.resolve()
    const requestMode = mode ?? (ccLifecycleGeneration === undefined ? 'full' : 'lifecycle')
    if (
      ccLifecycleGeneration !== undefined &&
      (ccLifecycleGeneration !== this.ccLifecycleGeneration ||
        (requestMode === 'lifecycle' &&
          ccLifecycleGeneration === this.ccAppliedLifecycleGeneration))
    ) {
      return Promise.resolve()
    }

    const request: HostFleetReconcileRequest = {
      reason,
      mode: requestMode,
      ccLifecycleGeneration,
      inputRevision: this.hostFleetInputRevision,
    }
    const active = this.hostFleetReconcileInFlight
    if (!active) {
      this.dependencies.recordRequest('started')
      return this.waitForHostFleetOrShutdown(this.startHostFleetReconcile(request))
    }
    if (hostFleetRequestCovers(active, request)) {
      this.dependencies.recordRequest('coalesced')
      return this.waitForHostFleetOrShutdown(active.promise)
    }

    if (!this.hostFleetReconcilePending) {
      let resolve!: () => void
      const promise = new Promise<void>(resolvePromise => {
        resolve = resolvePromise
      })
      this.hostFleetReconcilePending = {
        ...request,
        promise,
        resolve,
      }
    } else {
      const merged = mergeHostFleetRequests(this.hostFleetReconcilePending, request)
      this.hostFleetReconcilePending.reason = merged.reason
      this.hostFleetReconcilePending.mode = merged.mode
      this.hostFleetReconcilePending.ccLifecycleGeneration = merged.ccLifecycleGeneration
      this.hostFleetReconcilePending.inputRevision = merged.inputRevision
    }
    this.dependencies.recordRequest('coalesced')
    return this.waitForHostFleetOrShutdown(this.hostFleetReconcilePending.promise)
  }

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    this.resolveHostFleetShutdown()
    this.hostFleetReconcilePending?.resolve()
    this.hostFleetReconcilePending = null
    this.clearLifecycleRetry()
  }

  private clearLifecycleRetry(): void {
    if (!this.ccFleetRetryTimer) return
    clearTimeout(this.ccFleetRetryTimer)
    this.ccFleetRetryTimer = null
  }

  private waitForHostFleetOrShutdown(coverage: Promise<void>): Promise<void> {
    return Promise.race([coverage, this.hostFleetShutdown])
  }

  private startHostFleetReconcile(request: HostFleetReconcileRequest): Promise<void> {
    const reconcileRequest: HostFleetReconcileRequest = {
      reason: request.reason,
      mode: request.mode,
      ccLifecycleGeneration: request.ccLifecycleGeneration,
      inputRevision: request.inputRevision,
    }
    const promise = this.dependencies.perform(reconcileRequest)
    const active: ActiveHostFleetReconcile = { ...reconcileRequest, promise }
    this.hostFleetReconcileInFlight = active

    const settle = () => {
      if (this.hostFleetReconcileInFlight !== active) return
      this.hostFleetReconcileInFlight = null
      const pending = this.hostFleetReconcilePending
      this.hostFleetReconcilePending = null
      if (!pending) return
      if (this.stopped) {
        pending.resolve()
        return
      }
      this.dependencies.recordRequest('trailing')
      const trailing = this.startHostFleetReconcile(pending)
      void trailing.then(pending.resolve, pending.resolve)
    }
    void promise.then(settle, settle)
    return promise
  }
}
