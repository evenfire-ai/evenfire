export interface CoalescedRevalidation<T> {
  request(value?: T): void
  dispose(): void
}

/** Serialize latest-state refreshes, coalescing bursts and preserving one trailing pass. */
export function createCoalescedRevalidation<T>(
  run: (latest: T | undefined) => Promise<void>,
  onError: (error: unknown) => void,
  delayMs = 100,
  maxWaitMs = 1000
): CoalescedRevalidation<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  let maxTimer: ReturnType<typeof setTimeout> | null = null
  let running = false
  let pending = false
  let disposed = false
  let latest: T | undefined

  const flush = () => {
    if (timer) clearTimeout(timer)
    if (maxTimer) clearTimeout(maxTimer)
    timer = null
    maxTimer = null
    if (disposed || running || !pending) return
    const value = latest
    pending = false
    latest = undefined
    running = true
    void run(value)
      .catch(error => {
        try {
          onError(error)
        } catch {
          // Error reporting must not prevent the scheduler from releasing its
          // single-flight state or draining a queued latest-state pass.
        }
      })
      .finally(() => {
        running = false
        schedule()
      })
  }

  const schedule = () => {
    if (disposed || running || !pending) return
    if (!timer) timer = setTimeout(flush, delayMs)
    if (!maxTimer) maxTimer = setTimeout(flush, maxWaitMs)
  }

  return {
    request(value) {
      if (disposed) return
      pending = true
      if (value !== undefined) latest = value
      if (timer) clearTimeout(timer)
      timer = null
      schedule()
    },
    dispose() {
      disposed = true
      pending = false
      latest = undefined
      if (timer) clearTimeout(timer)
      timer = null
      if (maxTimer) clearTimeout(maxTimer)
      maxTimer = null
    },
  }
}
