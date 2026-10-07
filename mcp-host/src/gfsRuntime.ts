import { GfsDownloadStore, GfsDownloadStoreError } from './internalTools/gfsDownloadStore'
import { logger } from './logger'
import { ScopedWorkspaceProvider } from './workspace/scopedWorkspace'

export interface GfsRuntime {
  store: GfsDownloadStore
  workspaceProvider: ScopedWorkspaceProvider
  stop(): Promise<void>
}

export interface GfsRuntimeOptions {
  retryDelayMs?: number
  maxRetryAttempts?: number
}

function transientWriterContention(error: unknown): boolean {
  return (
    error instanceof GfsDownloadStoreError &&
    error.code === 'writer_locked' &&
    error.transientWriterContention === true
  )
}

/**
 * Contain GFS store failure without removing the caller workspace or falling
 * back to an unprotected shared-root shell. Ordinary RPC startup continues;
 * `store.isAvailable()` is the single managed-operation availability signal.
 */
export async function bootstrapGfsRuntime(
  hostRoot: string,
  options: GfsRuntimeOptions = {}
): Promise<GfsRuntime> {
  const workspaceProvider = new ScopedWorkspaceProvider(hostRoot)
  const store = new GfsDownloadStore(hostRoot)
  let stopped = false
  let lifecycleTimer: ReturnType<typeof setTimeout> | undefined
  let lifecycleInFlight: Promise<void> | undefined
  let stopping: Promise<void> | undefined
  let attempts = 0
  const retryDelayMs = options.retryDelayMs ?? 2_000
  const maxRetryAttempts = options.maxRetryAttempts ?? 60
  if (!Number.isSafeInteger(retryDelayMs) || retryDelayMs < 25)
    throw new Error('GFS runtime retryDelayMs must be an integer of at least 25ms')
  if (!Number.isSafeInteger(maxRetryAttempts) || maxRetryAttempts < 1)
    throw new Error('GFS runtime maxRetryAttempts must be a positive integer')

  type LifecycleStep = { kind: 'retry' | 'cleanup'; delayMs: number }
  const clearLifecycleTimer = () => {
    if (lifecycleTimer) clearTimeout(lifecycleTimer)
    lifecycleTimer = undefined
  }
  // A store whose initialize() resolved is available; it becomes unavailable
  // only afterwards, when a persist fails (`unsafe`) or writer ownership is
  // lost. The periodic lifecycle then ends for good, so that is logged as an
  // error rather than returning silently.
  const lifecycleStopped = (): undefined => {
    logger.error(
      { component: 'gfs-runtime', available: false },
      'GFS download store is no longer available; periodic cleanup stopped and managed GFS operations are disabled'
    )
    return undefined
  }
  const cycle = async (kind: LifecycleStep['kind']): Promise<LifecycleStep | undefined> => {
    if (stopped) return
    if (kind === 'retry') {
      attempts += 1
      try {
        await store.initialize()
      } catch (error) {
        if (stopped) return
        if (!transientWriterContention(error)) {
          logger.error(
            { component: 'gfs-runtime', err: error, attempt: attempts },
            'GFS writer retry ended in recovery-required state'
          )
          return
        }
        if (attempts >= maxRetryAttempts) {
          logger.error(
            { component: 'gfs-runtime', attempt: attempts },
            'GFS writer retry budget exhausted; managed operations remain disabled'
          )
          return
        }
        return { kind: 'retry', delayMs: retryDelayMs }
      }
      if (stopped) return
      logger.info(
        { component: 'gfs-runtime', attempt: attempts },
        'GFS writer retry initialization completed'
      )
    }
    if (stopped) return
    if (!store.isAvailable()) return lifecycleStopped()
    try {
      await store.cleanupExpired()
    } catch (error) {
      logger.warn({ component: 'gfs-runtime', err: error }, 'GFS download cleanup failed')
    }
    if (stopped) return
    if (!store.isAvailable()) return lifecycleStopped()
    return { kind: 'cleanup', delayMs: 60 * 60 * 1000 }
  }
  const schedule = (step: LifecycleStep): void => {
    if (stopped || lifecycleTimer || lifecycleInFlight) return
    lifecycleTimer = setTimeout(() => {
      lifecycleTimer = undefined
      startCycle(step.kind)
    }, step.delayMs)
    lifecycleTimer.unref?.()
  }
  const startCycle = (kind: LifecycleStep['kind']): void => {
    if (stopped || lifecycleInFlight) return
    // One promise owns initialization and sweeps. Schedule only after it has
    // settled, so a slow sweep never overlaps another mutation or loses its join.
    lifecycleInFlight = cycle(kind).then(
      next => {
        lifecycleInFlight = undefined
        if (!stopped && next) schedule(next)
      },
      error => {
        lifecycleInFlight = undefined
        logger.error(
          { component: 'gfs-runtime', err: error, attempt: attempts },
          'Unexpected GFS runtime lifecycle error'
        )
      }
    )
  }

  try {
    await store.initialize()
    startCycle('cleanup')
  } catch (error) {
    if (transientWriterContention(error)) {
      logger.warn(
        { component: 'gfs-runtime', retryDelayMs, maxRetryAttempts },
        'GFS writer is transiently owned by another verified Pod; supervised retry started'
      )
      schedule({ kind: 'retry', delayMs: retryDelayMs })
    } else {
      logger.error(
        { component: 'gfs-runtime', err: error, available: store.isAvailable() },
        'GFS download store entered recovery-required state; managed GFS operations are disabled'
      )
    }
  }

  return {
    store,
    workspaceProvider,
    stop() {
      if (stopping) return stopping
      stopped = true
      clearLifecycleTimer()
      stopping = (async () => {
        await lifecycleInFlight
        // An initialized store can still own its writer after a failed persist
        // has made isAvailable() false. Close unconditionally, including a
        // retry that won during stop.
        await store.close()
      })()
      return stopping
    },
  }
}
