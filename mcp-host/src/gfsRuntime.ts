import { GfsDownloadStore, GfsDownloadStoreError } from './internalTools/gfsDownloadStore'
import { logger } from './logger'
import { ScopedWorkspaceProvider } from './workspace/scopedWorkspace'

export interface GfsRuntime {
  store: GfsDownloadStore
  workspaceProvider: ScopedWorkspaceProvider
  stop(): Promise<void>
}

export interface GfsRuntimeOptions {
  /** Interval of the lifecycle cycle: initialize when unavailable, otherwise sweep. */
  cycleMs?: number
}

const DEFAULT_CYCLE_MS = 60 * 60 * 1000

function failureCode(error: unknown): string {
  if (error instanceof GfsDownloadStoreError) return error.code
  const code = (error as NodeJS.ErrnoException)?.code
  return typeof code === 'string' ? code : 'unknown'
}

/**
 * Contain GFS store failure without removing the caller workspace or falling
 * back to an unprotected shared-root shell. Ordinary RPC startup continues;
 * `store.isAvailable()` is the single managed-operation availability signal.
 * A store that failed to initialize is retried by the same cycle that sweeps,
 * so delivery returns without a Host restart once the cause is gone.
 */
export async function bootstrapGfsRuntime(
  hostRoot: string,
  options: GfsRuntimeOptions = {}
): Promise<GfsRuntime> {
  const workspaceProvider = new ScopedWorkspaceProvider(hostRoot)
  const store = new GfsDownloadStore(hostRoot)
  const cycleMs = options.cycleMs ?? DEFAULT_CYCLE_MS
  if (!Number.isSafeInteger(cycleMs) || cycleMs < 25)
    throw new Error('GFS runtime cycleMs must be an integer of at least 25ms')
  let stopped = false
  let cycleTimer: ReturnType<typeof setTimeout> | undefined
  let cycleInFlight: Promise<void> | undefined
  let stopping: Promise<void> | undefined

  const initialize = async (): Promise<void> => {
    try {
      await store.initialize()
    } catch (error) {
      if (stopped) return
      logger.error(
        { component: 'gfs-runtime', code: failureCode(error) },
        'GFS download store unavailable; managed GFS operations are disabled and initialization is retried by the hourly cycle'
      )
    }
  }

  const cycle = async (): Promise<void> => {
    if (stopped) return
    if (!store.isAvailable()) {
      await initialize()
      return
    }
    try {
      await store.cleanupExpired()
    } catch (error) {
      // cleanupExpired already counted sweep_failed for its own failures.
      logger.warn(
        { component: 'gfs-runtime', code: failureCode(error) },
        'GFS download cleanup failed; the next cycle retries it'
      )
    }
  }

  const schedule = (): void => {
    if (stopped || cycleTimer || cycleInFlight) return
    cycleTimer = setTimeout(() => {
      cycleTimer = undefined
      // One promise owns initialization and sweeps; the next cycle is
      // scheduled only after it settles, so cycles never overlap.
      cycleInFlight = cycle().then(
        () => {
          cycleInFlight = undefined
          schedule()
        },
        error => {
          cycleInFlight = undefined
          logger.error(
            { component: 'gfs-runtime', code: failureCode(error) },
            'Unexpected GFS runtime cycle error'
          )
          schedule()
        }
      )
    }, cycleMs)
    cycleTimer.unref?.()
  }

  cycleInFlight = initialize().finally(() => {
    cycleInFlight = undefined
  })
  await cycleInFlight
  schedule()

  return {
    store,
    workspaceProvider,
    stop() {
      if (stopping) return stopping
      stopped = true
      if (cycleTimer) clearTimeout(cycleTimer)
      cycleTimer = undefined
      stopping = (async () => {
        await cycleInFlight
        await store.close()
      })()
      return stopping
    },
  }
}
