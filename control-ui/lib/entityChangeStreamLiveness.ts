// Allow two maximum heartbeat intervals plus the server's maximum poll delay.
export const ENTITY_CHANGE_STREAM_IDLE_TIMEOUT_MS = 2 * (60_000 + 5_000)

export interface EntityChangeStreamLiveness {
  receivedFrame(): void
  dispose(): void
}

/** Reconnect a half-open stream without changing visible entity state. */
export function watchEntityChangeStreamLiveness(
  onIdle: () => void,
  timeoutMs = ENTITY_CHANGE_STREAM_IDLE_TIMEOUT_MS
): EntityChangeStreamLiveness {
  let timer: ReturnType<typeof setTimeout> | null = null
  let disposed = false
  let idleTriggered = false

  const arm = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      if (!disposed && !idleTriggered) {
        idleTriggered = true
        onIdle()
      }
    }, timeoutMs)
  }

  arm()
  return {
    receivedFrame() {
      if (!disposed && !idleTriggered) arm()
    },
    dispose() {
      disposed = true
      if (timer) clearTimeout(timer)
      timer = null
    },
  }
}
