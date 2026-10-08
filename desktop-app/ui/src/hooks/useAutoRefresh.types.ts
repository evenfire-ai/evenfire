export type AutoRefreshOptions = {
  /** Only a visible surface drives refreshes; `false` arms no timer or listener. */
  enabled: boolean
  /** The surface's imperative refresh. Errors are the caller's to record. */
  refresh: () => Promise<unknown>
  /** Reads the cache at call time: true when the data is older than `maxAgeMs`. */
  isStale: (maxAgeMs: number) => boolean
  pollIntervalMs?: number
  staleAfterMs?: number
}

export type AutoRefreshControls = {
  /**
   * Manual refresh: runs regardless of staleness, joins a run already in
   * flight instead of starting a second one, and resets the poll deadline.
   */
  refreshNow: () => Promise<void>
}
