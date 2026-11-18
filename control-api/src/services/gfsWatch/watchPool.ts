import { Pool, type PoolConfig } from 'pg'
import type { PoolConstructor } from '../../boundedPgPool.js'
import { rootLogger } from '../../observability/logger.js'

/**
 * The watch registry's own pool: its queries (ancestry CTE, team expansion,
 * session confirmation, root grantees) never take connections from the core
 * pool, and a saturated core pool never starves the watch.
 *
 * `query_timeout` is the client-side deadline. `statement_timeout` alone does
 * not end an await on a half-open connection (the server never sees the query
 * or cannot answer), so the await would last until TCP gives up, minutes
 * later. With it, a query waits at most 2 s for a connection plus 2 s for a
 * result, and pg-pool discards the connection whose query timed out.
 * keepAlive starts probing after 10 s instead of the OS default (2 h on Linux).
 */
export const GFS_WATCH_POOL_OPTIONS = Object.freeze({
  max: 4,
  connectionTimeoutMillis: 2_000,
  statement_timeout: 2_000,
  query_timeout: 2_000,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10_000,
} satisfies PoolConfig)

const log = rootLogger.child({ module: 'gfs-watch-pool' })

export function createGfsWatchPool(
  connectionString: string,
  PoolClass: PoolConstructor = Pool
): Pool {
  const pool = new PoolClass({ connectionString, ...GFS_WATCH_POOL_OPTIONS })
  // pg-pool re-emits an idle client's error on the pool; an EventEmitter
  // without an 'error' listener throws it, and nothing catches it above.
  pool.on('error', err => log.warn({ err }, 'gfs watch pool idle client error'))
  return pool
}
