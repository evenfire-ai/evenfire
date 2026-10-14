import { logger } from '../../../logger'

/**
 * `onPersistFailure` handler for the Host process. A persist queue that can
 * no longer write never recovers in-process, so the process exits 1 and the
 * kubelet restarts the container. During shutdown `close()` reports the
 * failure instead.
 */
export function exitOnPersistFailure(isShuttingDown: () => boolean): (err: Error) => void {
  return err => {
    if (isShuttingDown()) return
    logger.error(
      { err },
      '[Main] Conversation store can no longer persist writes; exiting with code 1'
    )
    process.exit(1)
  }
}
