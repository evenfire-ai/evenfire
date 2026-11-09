export const ACCESS_EXECUTION_LIMIT_CLAMPS = Object.freeze({
  actionDeadlineMs: 2_000,
  statementTimeoutMs: 2_500,
  producerCalls: 32,
  databaseStatements: 128,
  producerConcurrency: 4,
  objects: 1_000,
  decodedBytes: 8 * 1024 * 1024,
  objectBytes: 512 * 1024,
  accessPaths: 2_048,
  relationships: 4_096,
  dbRowsReturned: 4_096,
  kubernetesPageSize: 100,
  exactKubernetesGets: 4,
})

export type AccessExecutionKind = 'action'

export type AccessExecutionLimitName = keyof typeof ACCESS_EXECUTION_LIMIT_CLAMPS
export type AccessExecutionLimits = Readonly<Record<AccessExecutionLimitName, number>>

export type AccessBudgetCounterKind =
  | 'producerCalls'
  | 'databaseStatements'
  | 'objects'
  | 'decodedBytes'
  | 'accessPaths'
  | 'relationships'
  | 'dbRowsReturned'
  | 'exactKubernetesGets'

export type AccessBudgetCharge = Readonly<{
  kind: AccessBudgetCounterKind
  amount?: number
  authorityRequired?: boolean
}>

export class AccessBudgetConfigurationError extends Error {
  constructor(
    readonly limit: keyof AccessExecutionLimits,
    readonly reason: string
  ) {
    super(`Invalid access execution limit ${limit}: ${reason}`)
    this.name = 'AccessBudgetConfigurationError'
  }
}

export class AccessBudgetExceededError extends Error {
  constructor(
    readonly limit: AccessBudgetCounterKind | 'deadline' | 'objectBytes',
    readonly authorityRequired: boolean
  ) {
    super(`Access execution budget exhausted: ${limit}`)
    this.name = 'AccessBudgetExceededError'
  }
}

export class AccessExecutionCancelledError extends Error {
  constructor(readonly reason: 'deadline' | 'cancelled' | 'closed') {
    super(`Access execution cancelled: ${reason}`)
    this.name = 'AccessExecutionCancelledError'
  }
}

class BudgetCounter {
  constructor(
    readonly capacity: number,
    private available = capacity
  ) {}

  remaining(): number {
    return this.available
  }

  take(amount: number): boolean {
    if (amount > this.available) return false
    this.available -= amount
    return true
  }
}

class AccessSemaphore {
  private inUse = 0
  private readonly waiters: Array<{
    resolve: (release: () => void) => void
    reject: (error: Error) => void
    signal: AbortSignal
    onAbort: () => void
  }> = []

  constructor(private readonly capacity: number) {}

  async acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) throw new AccessExecutionCancelledError('cancelled')
    if (this.inUse < this.capacity) {
      this.inUse += 1
      return this.releaseOnce()
    }

    return new Promise<() => void>((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        signal,
        onAbort: () => undefined,
      }
      waiter.onAbort = () => {
        const index = this.waiters.indexOf(waiter)
        if (index >= 0) this.waiters.splice(index, 1)
        reject(new AccessExecutionCancelledError('cancelled'))
      }
      signal.addEventListener('abort', waiter.onAbort, { once: true })
      this.waiters.push(waiter)
    })
  }

  private releaseOnce(): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      const waiter = this.waiters.shift()
      if (waiter) {
        waiter.signal.removeEventListener('abort', waiter.onAbort)
        waiter.resolve(this.releaseOnce())
        return
      }
      this.inUse = Math.max(0, this.inUse - 1)
    }
  }
}

const COUNTER_KINDS: readonly AccessBudgetCounterKind[] = [
  'producerCalls',
  'databaseStatements',
  'objects',
  'decodedBytes',
  'accessPaths',
  'relationships',
  'dbRowsReturned',
  'exactKubernetesGets',
]

function positiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0
}

export function resolveAccessExecutionLimits(
  requested: Partial<AccessExecutionLimits> = {}
): AccessExecutionLimits {
  const values: Record<AccessExecutionLimitName, number> = { ...ACCESS_EXECUTION_LIMIT_CLAMPS }
  const maximums = ACCESS_EXECUTION_LIMIT_CLAMPS
  for (const key of Object.keys(ACCESS_EXECUTION_LIMIT_CLAMPS) as Array<
    keyof AccessExecutionLimits
  >) {
    const supplied = requested[key]
    if (supplied === undefined) continue
    if (!positiveSafeInteger(supplied)) {
      throw new AccessBudgetConfigurationError(key, 'must be a positive safe integer')
    }
    if (supplied > maximums[key]) {
      throw new AccessBudgetConfigurationError(key, 'exceeds the hard code clamp')
    }
    values[key] = supplied
  }
  return Object.freeze(values)
}

function createCounters(
  limits: AccessExecutionLimits
): Map<AccessBudgetCounterKind, BudgetCounter> {
  return new Map(COUNTER_KINDS.map(kind => [kind, new BudgetCounter(limits[kind])]))
}

type SharedAccessBudgetState = {
  counters: Map<AccessBudgetCounterKind, BudgetCounter>
  semaphore: AccessSemaphore
  controller: AbortController
  deadline: number
}

export class AccessExecutionBudget {
  readonly deadline: number
  readonly signal: AbortSignal
  readonly limits: AccessExecutionLimits
  private closed = false
  private timer?: ReturnType<typeof setTimeout>

  private constructor(
    private readonly shared: SharedAccessBudgetState,
    limits: AccessExecutionLimits
  ) {
    this.deadline = shared.deadline
    this.signal = shared.controller.signal
    this.limits = limits
  }

  static create(
    _kind: AccessExecutionKind,
    options: {
      limits?: Partial<AccessExecutionLimits>
      now?: number
    } = {}
  ): AccessExecutionBudget {
    const limits = resolveAccessExecutionLimits(options.limits)
    const controller = new AbortController()
    const now = options.now ?? Date.now()
    const deadlineMs = limits.actionDeadlineMs
    const shared: SharedAccessBudgetState = {
      counters: createCounters(limits),
      semaphore: new AccessSemaphore(limits.producerConcurrency),
      controller,
      deadline: now + deadlineMs,
    }
    const budget = new AccessExecutionBudget(shared, limits)
    budget.timer = setTimeout(() => controller.abort('deadline'), deadlineMs)
    budget.timer.unref?.()
    return budget
  }

  remainingMs(now = Date.now()): number {
    return Math.max(0, this.deadline - now)
  }

  statementTimeoutMs(now = Date.now()): number {
    this.assertActive(now)
    const timeout = Math.min(this.limits.statementTimeoutMs, this.remainingMs(now) - 250)
    if (timeout < 1) throw new AccessBudgetExceededError('deadline', true)
    return Math.floor(timeout)
  }

  assertActive(now = Date.now()): void {
    if (this.closed) throw new AccessExecutionCancelledError('closed')
    if (this.signal.aborted) {
      throw new AccessExecutionCancelledError(
        this.signal.reason === 'deadline' || now >= this.deadline
          ? 'deadline'
          : this.signal.reason === 'closed'
            ? 'closed'
            : 'cancelled'
      )
    }
    if (now >= this.deadline) {
      this.shared.controller.abort('deadline')
      throw new AccessExecutionCancelledError('deadline')
    }
  }

  charge(event: AccessBudgetCharge): void {
    this.assertActive()
    const amount = event.amount ?? 1
    if (!positiveSafeInteger(amount)) {
      throw new AccessBudgetConfigurationError(event.kind, 'charge must be a positive safe integer')
    }
    const counter = this.counter(event.kind)
    if (!counter.take(amount)) {
      throw new AccessBudgetExceededError(event.kind, event.authorityRequired ?? true)
    }
  }

  chargeOperationalObject(bytes: number, authorityRequired = false): void {
    this.assertActive()
    if (!positiveSafeInteger(bytes)) {
      throw new AccessBudgetConfigurationError('objectBytes', 'must be a positive safe integer')
    }
    if (bytes > this.limits.objectBytes) {
      throw new AccessBudgetExceededError('objectBytes', authorityRequired)
    }
    this.charge({ kind: 'objects', authorityRequired })
    this.charge({ kind: 'decodedBytes', amount: bytes, authorityRequired })
  }

  async runProducer<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.charge({ kind: 'producerCalls' })
    return this.runBoundedWork(work)
  }

  async runBoundedWork<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const release = await this.shared.semaphore.acquire(this.signal)
    try {
      this.assertActive()
      const result = await work(this.signal)
      this.assertActive()
      return result
    } finally {
      release()
    }
  }

  cancel(): void {
    this.shared.controller.abort('cancelled')
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    if (this.timer) clearTimeout(this.timer)
    this.shared.controller.abort('closed')
  }

  remaining(kind: AccessBudgetCounterKind): number {
    return this.counter(kind).remaining()
  }

  private counter(kind: AccessBudgetCounterKind): BudgetCounter {
    const value = this.shared.counters.get(kind)
    if (!value) throw new AccessBudgetConfigurationError(kind, 'counter is not configured')
    return value
  }
}
