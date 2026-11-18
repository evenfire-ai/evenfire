export interface KeyedSingleFlight {
  /**
   * Runs `task` for `key`, or, while a task for that key is in flight, keeps
   * it as the one pass to run when the current one settles. Later requests
   * replace the kept pass, so a burst collapses into at most two runs.
   */
  run(key: string, task: () => Promise<unknown>): void
  /** Drops kept passes; in-flight tasks finish but nothing runs after them. */
  dispose(): void
}

export function createKeyedSingleFlight(): KeyedSingleFlight {
  const pendingByKey = new Map<string, (() => Promise<unknown>) | null>()
  let disposed = false

  const drain = async (key: string, first: () => Promise<unknown>) => {
    let task: (() => Promise<unknown>) | null = first
    while (task && !disposed) {
      pendingByKey.set(key, null)
      try {
        await task()
      } catch {
        // A failed pass must not wedge the key: the next request runs normally.
      }
      task = pendingByKey.get(key) ?? null
    }
    pendingByKey.delete(key)
  }

  return {
    run(key, task) {
      if (disposed) return
      if (pendingByKey.has(key)) {
        pendingByKey.set(key, task)
        return
      }
      void drain(key, task)
    },
    dispose() {
      disposed = true
      pendingByKey.clear()
    },
  }
}
