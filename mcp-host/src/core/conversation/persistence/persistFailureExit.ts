import { logger } from '../../../logger'

export interface PersistFailureExitOptions {
  /**
   * Best-effort work before the exit, e.g. flushing buffered usage events.
   * A rejection is logged; the process exits 1 either way.
   */
  beforeExit: () => Promise<void>
  /** The exit happens after this long even if `beforeExit` has not settled. */
  beforeExitTimeoutMs: number
}

/**
 * Exit code of a graceful shutdown: 1 when closing the conversation store
 * rejects (a write was lost or the worker stalled), so the loss shows in the
 * container's termination state; 0 otherwise.
 */
export async function storeShutdownExitCode(shutdown: () => Promise<void>): Promise<number> {
  try {
    await shutdown()
    return 0
  } catch (err) {
    logger.error({ err }, 'ConversationStore shutdown failed; exiting with code 1')
    return 1
  }
}

/**
 * `onPersistFailure` handler for the Host process. A persist queue that can
 * no longer write never recovers in-process, so the process exits 1 and the
 * kubelet restarts the container, after a bounded `beforeExit`. During
 * shutdown `close()` reports the failure instead.
 */
export function exitOnPersistFailure(
  isShuttingDown: () => boolean,
  opts: PersistFailureExitOptions
): (err: Error) => void {
  let exiting = false
  return err => {
    if (exiting || isShuttingDown()) return
    exiting = true
    logger.error(
      { err },
      '[Main] Conversation store can no longer persist writes; exiting with code 1'
    )
    let timer: ReturnType<typeof setTimeout> | undefined
    const expired = new Promise<void>(resolve => {
      timer = setTimeout(() => {
        logger.warn(
          { timeoutMs: opts.beforeExitTimeoutMs },
          '[Main] Pre-exit flush did not finish in time'
        )
        resolve()
      }, opts.beforeExitTimeoutMs)
    })
    const flushed = Promise.resolve()
      .then(opts.beforeExit)
      .catch((flushErr: unknown) => {
        logger.warn({ err: flushErr }, '[Main] Pre-exit flush failed')
      })
    void Promise.race([flushed, expired]).then(() => {
      clearTimeout(timer)
      process.exit(1)
    })
  }
}
