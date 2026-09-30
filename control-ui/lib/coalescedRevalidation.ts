export interface CoalescedRevalidation<T> {
  request(value?: T): void
  dispose(): void
}

/** Serialize latest-state refreshes, coalescing bursts and preserving one trailing pass. */
export function createCoalescedRevalidation<T>(
  run: (latest: T | undefined) => Promise<void>,
  delayMs = 100
): CoalescedRevalidation<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  let running = false
  let pending = false
  let disposed = false
  let latest: T | undefined

  const schedule = () => {
    if (disposed || timer || running || !pending) return
    timer = setTimeout(() => {
      timer = null
      if (disposed || running || !pending) return
      const value = latest
      pending = false
      latest = undefined
      running = true
      void run(value)
        .catch(() => undefined)
        .finally(() => {
          running = false
          schedule()
        })
    }, delayMs)
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
    },
  }
}
