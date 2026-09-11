export interface WriterCleanupRunnerDeps {
  reconcileUploads?: () => Promise<void>
  reconcileBlobs: () => Promise<void>
  onBlobFailure?: () => void
  log?: (message: string) => void
}

/**
 * Serialize the writer's two durable cleanup passes.
 *
 * The runner is deliberately created before the serving handler but invoked
 * only after all writer services have been wired. This keeps boot cleanup and
 * the interval on one gate without allowing a synchronous first invocation to
 * observe an uninitialized upload service.
 */
export function createWriterCleanupRunner(deps: WriterCleanupRunnerDeps): () => Promise<void> {
  let running = false
  const log = deps.log ?? ((message: string) => console.error(message))

  return async () => {
    if (running) return
    running = true
    try {
      if (deps.reconcileUploads) {
        try {
          await deps.reconcileUploads()
        } catch (error) {
          log(
            `[gfsc] upload reconciliation failed: ${error instanceof Error ? error.message : String(error)}`
          )
        }
      }
      try {
        await deps.reconcileBlobs()
      } catch (error) {
        deps.onBlobFailure?.()
        log(
          `[gfsc] blob reconciliation failed: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    } finally {
      running = false
    }
  }
}
