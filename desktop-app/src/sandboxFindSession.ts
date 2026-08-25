export type NativeFindUpdate = {
  requestId: number
  activeMatchOrdinal: number
  matches: number
  finalUpdate: boolean
}

/**
 * Chromium can synchronously report a final zero before asynchronously
 * reporting the real result set for a newly started WebContentsView search.
 * Keep that provisional zero pending briefly; any substantive update for the
 * same native request supersedes it. A genuine zero becomes empty once the
 * producer has stayed quiescent for the settling window.
 */
export function createSandboxFindResultGate(
  deliver: (result: NativeFindUpdate) => void,
  settleMs = 50
): { accept: (result: NativeFindUpdate) => void; dispose: () => void } {
  let pendingZero: ReturnType<typeof setTimeout> | null = null
  let disposed = false
  const clearPending = () => {
    if (pendingZero !== null) clearTimeout(pendingZero)
    pendingZero = null
  }
  return {
    accept(result) {
      if (disposed) return
      clearPending()
      if (result.finalUpdate && result.matches === 0) {
        pendingZero = setTimeout(() => {
          pendingZero = null
          if (!disposed) deliver(result)
        }, settleMs)
        return
      }
      deliver(result)
    },
    dispose() {
      disposed = true
      clearPending()
    },
  }
}
