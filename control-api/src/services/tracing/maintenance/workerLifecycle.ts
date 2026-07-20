export type TraceMaintenanceShutdownSignal = 'SIGINT' | 'SIGTERM'

type ShutdownCoordinatorOptions = {
  timeoutMs: number
  onRequested(signal: TraceMaintenanceShutdownSignal): void
  onCompleted(signal: TraceMaintenanceShutdownSignal): void
  onTimedOut(signal: TraceMaintenanceShutdownSignal, timeoutMs: number): void
  exit(code: number): void
}

export class TraceMaintenanceShutdownCoordinator {
  private readonly controller = new AbortController()
  private timeout: ReturnType<typeof setTimeout> | null = null
  private requestedSignal: TraceMaintenanceShutdownSignal | null = null
  private completed = false

  constructor(private readonly options: ShutdownCoordinatorOptions) {
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1_000) {
      throw new Error('trace maintenance shutdown timeout must be at least 1000ms')
    }
  }

  get signal(): AbortSignal {
    return this.controller.signal
  }

  request(signal: TraceMaintenanceShutdownSignal): boolean {
    if (this.requestedSignal) return false

    this.requestedSignal = signal
    this.options.onRequested(signal)
    this.controller.abort()
    this.timeout = setTimeout(() => {
      if (this.completed) return
      this.options.onTimedOut(signal, this.options.timeoutMs)
      this.options.exit(1)
    }, this.options.timeoutMs)
    this.timeout.unref?.()
    return true
  }

  finish(): boolean {
    if (!this.requestedSignal || this.completed) return false

    this.completed = true
    if (this.timeout) clearTimeout(this.timeout)
    this.timeout = null
    this.options.onCompleted(this.requestedSignal)
    return true
  }
}

export async function waitForAbortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return
  await new Promise<void>(resolve => {
    const timer = setTimeout(done, ms)

    function done() {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }

    signal.addEventListener('abort', done, { once: true })
  })
}
