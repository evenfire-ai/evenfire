import type { Pool } from 'pg'
import { config } from '../../config.js'
import { rootLogger } from '../../observability/logger.js'
import { type GfsWatchRegistry, createGfsWatchRegistry } from './registry.js'
import { createGfsWatchPool } from './watchPool.js'

type GfsWatchProcess = { registry: GfsWatchRegistry; watchPool: Pool }

let current: GfsWatchProcess | null = null
let started = false

/**
 * The process's single watch registry and its pool, created on first use. A
 * second registry would hold a second LISTEN client and split the
 * connections a command is routed to, so every router and the server share
 * this one. Creating it opens no connection: the pool connects on its first
 * query and the listener on `startGfsWatchProcess`.
 */
export function gfsWatchProcess(): GfsWatchProcess {
  if (current === null) {
    const watchPool = createGfsWatchPool(config.pgConnectionString)
    const registry = createGfsWatchRegistry({
      listenConnectionString: config.pgConnectionString,
      watchPool,
      heartbeatMs: config.gfsWatchHeartbeatMs,
      log: rootLogger.child({ module: 'gfs-watch' }),
    })
    current = { registry, watchPool }
  }
  return current
}

/** Starts the LISTEN client and its liveness checks; once per process. */
export function startGfsWatchProcess(): void {
  if (started) return
  started = true
  gfsWatchProcess().registry.start()
}

/**
 * Closes every watch stream with `server_shutdown` and drops the LISTEN
 * client. Synchronous; it runs before the HTTP server waits for its open
 * connections, which would otherwise include every stream.
 */
export function stopGfsWatchRegistry(): void {
  current?.registry.stop()
}

/** Ends the watch pool; after `stopGfsWatchRegistry`, which aborts the ops that use it. */
export async function closeGfsWatchPool(): Promise<void> {
  if (current === null) return
  await current.watchPool.end()
}
