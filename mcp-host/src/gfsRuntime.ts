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
  /**
   * How long stop() waits for the cycle in flight, and then for the store's
   * drain in close(); each wait has this deadline.
   */
  stopTimeoutMs?: number
}

/**
 * Every five minutes: each cycle sweeps expired copies and restores the
 * free-space floor, so a volume another writer filled is given back within
 * this window. A cycle costs one walk of users/<key>/.gfs-downloads and one
 * statfs; it removes files only when something expired or the volume is
 * below the floor.
 */
const DEFAULT_CYCLE_MS = 5 * 60 * 1000
/** The same deadline as GfsDownloadStore.close()'s default drain. */
const DEFAULT_STOP_TIMEOUT_MS = 5_000

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
  const stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS
  if (!Number.isSafeInteger(stopTimeoutMs) || stopTimeoutMs < 0)
    throw new Error('GFS runtime stopTimeoutMs must be a non-negative integer')
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
        'GFS download store unavailable; managed GFS operations are disabled and initialization is retried by the next cycle'
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
        // A cycle that never settles (a hung statfs or rm) must not hold
        // shutdown: the wait is bounded and the store is closed regardless.
        // close() then drains the mutation queue under its own deadline.
        const inFlight = cycleInFlight
        if (inFlight !== undefined) {
          let timer: ReturnType<typeof setTimeout> | undefined
          const timedOut = await Promise.race([
            inFlight.then(() => false),
            new Promise<boolean>(resolve => {
              timer = setTimeout(() => resolve(true), stopTimeoutMs)
            }),
          ])
          clearTimeout(timer)
          if (timedOut)
            logger.warn(
              { component: 'gfs-runtime', timeoutMs: stopTimeoutMs },
              'GFS runtime stop timed out waiting for the cycle in flight; the store is closed anyway'
            )
        }
        await store.close(stopTimeoutMs)
      })()
      return stopping
    },
  }
}
