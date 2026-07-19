export type BoundedReporterDropReason =
  | 'stopped'
  | 'buffer_full'
  | 'requeue_full'
  | 'shutdown_submit_failed'
  | 'retry_exhausted'
  | 'shutdown_timeout'

type BufferedEntry<Value> = { value: Value; attempts: number }

export type BoundedOffPathReporterOptions<Value> = {
  capacity: number
  retryLimit: number
  stopTimeoutMs: number
  random: () => number
  submit: (value: Value) => Promise<void>
  onEnqueued?: (value: Value) => void
  onAccepted: (value: Value) => void
  onRetry?: (value: Value) => void
  onDrop: (value: Value, reason: BoundedReporterDropReason) => void
}

/** Bounded single-consumer queue for observational reporters on control paths. */
export class BoundedOffPathReporter<Value> {
  private readonly entries: Array<BufferedEntry<Value> | undefined>
  private head = 0
  private size = 0
  private flushInFlight = false
  private scheduled = false
  private retryScheduled = false
  private stopped = false
  private retryTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly options: BoundedOffPathReporterOptions<Value>) {
    if (!Number.isSafeInteger(options.capacity) || options.capacity < 1) {
      throw new Error('bounded reporter capacity must be a positive integer')
    }
    if (!Number.isSafeInteger(options.retryLimit) || options.retryLimit < 0) {
      throw new Error('bounded reporter retryLimit must be a non-negative integer')
    }
    this.entries = Array.from({ length: options.capacity })
  }

  enqueue(value: Value): void {
    if (this.stopped) {
      this.options.onDrop(value, 'stopped')
      return
    }
    if (!this.push({ value, attempts: 0 })) {
      this.options.onDrop(value, 'buffer_full')
      return
    }
    this.options.onEnqueued?.(value)
    this.scheduleFlush()
  }

  async stop(timeoutMs = this.options.stopTimeoutMs): Promise<void> {
    this.stopped = true
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
      this.retryScheduled = false
    }

    const deadline = Date.now() + Math.max(0, timeoutMs)
    while ((this.size > 0 || this.flushInFlight) && Date.now() <= deadline) {
      if (this.flushInFlight) {
        await new Promise(resolve => setTimeout(resolve, 0))
        continue
      }
      const remainingMs = Math.max(0, deadline - Date.now())
      await Promise.race([this.flush(), new Promise(resolve => setTimeout(resolve, remainingMs))])
    }

    let entry = this.shift()
    while (entry) {
      this.options.onDrop(entry.value, 'shutdown_timeout')
      entry = this.shift()
    }
  }

  private push(entry: BufferedEntry<Value>): boolean {
    if (this.size === this.options.capacity) return false
    this.entries[(this.head + this.size) % this.options.capacity] = entry
    this.size += 1
    return true
  }

  private shift(): BufferedEntry<Value> | undefined {
    if (this.size === 0) return undefined
    const entry = this.entries[this.head]
    this.entries[this.head] = undefined
    this.head = (this.head + 1) % this.options.capacity
    this.size -= 1
    return entry
  }

  private scheduleFlush(): void {
    if (this.stopped || this.size === 0 || this.scheduled || this.flushInFlight) return
    if (this.retryScheduled) return
    this.scheduled = true
    queueMicrotask(() => {
      this.scheduled = false
      if (this.stopped) return
      void this.flush()
    })
  }

  private async flush(): Promise<void> {
    if (this.flushInFlight) return
    this.flushInFlight = true
    try {
      const entry = this.shift()
      if (!entry) return
      try {
        await this.options.submit(entry.value)
        this.options.onAccepted(entry.value)
      } catch {
        if (this.stopped || entry.attempts >= this.options.retryLimit) {
          this.options.onDrop(
            entry.value,
            this.stopped ? 'shutdown_submit_failed' : 'retry_exhausted'
          )
          return
        }

        entry.attempts += 1
        this.options.onRetry?.(entry.value)
        if (!this.push(entry)) {
          this.options.onDrop(entry.value, 'requeue_full')
          return
        }
        this.retryScheduled = true
        const delayMs = 25 * 2 ** (entry.attempts - 1) + Math.floor(this.options.random() * 25)
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null
          this.retryScheduled = false
          if (this.stopped) return
          void this.flush()
        }, delayMs)
        this.retryTimer.unref?.()
      }
    } finally {
      this.flushInFlight = false
      this.scheduleFlush()
    }
  }
}
