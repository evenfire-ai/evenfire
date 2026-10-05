import type { Pool } from 'pg'

/**
 * The part of a pg Client this helper reads. `_ended` and the `end` event are
 * pg 8.x internals and public API respectively; see the comment below.
 */
interface ClosingClient {
  readonly _ended: boolean
  once(event: 'end', listener: () => void): unknown
  off(event: 'end', listener: () => void): unknown
}

// A removed client's pg-pool idleListener can still forward an error after
// end() returns. Keep this shared observer on the ended pool for that late
// teardown phase. Only PostgreSQL's expected backend-termination code is
// handled; an unexpected error still escapes unchanged, including when an
// earlier listener merely observed it. This function holds no pool reference.
function handlePoolTeardownError(error: unknown): void {
  if (error !== null && typeof error === 'object' && 'code' in error && error.code === '57P01')
    return
  throw error
}

/**
 * Ends a pg pool and resolves only after every client it held at end() has
 * closed its connection.
 *
 * pg-pool's end() resolves as soon as its client list is empty, while each
 * client.end() it started is still in flight. A real-Postgres teardown that
 * then runs pg_terminate_backend can reach a client that is still closing; the
 * 57P01 it receives is re-emitted on the pool and, with no pool `error`
 * listener, fails the run as an unhandled error.
 *
 * The helper snapshots the clients the pool holds before end() and waits for
 * each one by identity. Counting pool `remove` events against `totalCount` is
 * wrong both ways (pg-pool 3.13.0, `pg-pool/index.js`):
 * - a client still connecting is in `_clients` (:242), but a failed connect
 *   (:271-274) or a rejected onConnect (:294-295) drops it without `_remove`,
 *   so no `remove` is ever emitted and the wait never ends;
 * - a client removed before end() (release(true), expiry, idle timeout) is no
 *   longer counted, yet `_remove` (:172-188) still emits its `remove` when its
 *   connection closes, which stands in for a client still closing.
 *
 * pg 8.20.0 `pg/lib/client.js` sets `_ended` (:184) and emits `end` (:202-204)
 * from the connection's `end` handler (:179), which `pg/lib/connection.js`
 * emits on the socket's `close` (:60-62). That handler runs for a connection
 * that closed and for a connect that failed (:191-196), so every client in the
 * snapshot either has `_ended` set already or emits `end` exactly once.
 * `_clients` is private to pg-pool: if it is not an array the helper throws,
 * before ending the pool, rather than wait on something it cannot read.
 *
 * Scope: a client the pool had already removed before end() is not in the
 * snapshot and is not waited for. Before ending the pool, the helper installs
 * one retained error observer for the 57P01 such a client can still forward.
 * Earlier listeners are preserved; unexpected errors remain visible/failing.
 *
 * The five-second deadline covers both pool.end() and client closure, below
 * the ordinary ten-second test hook limit. A stuck close rejects explicitly;
 * it does not authorize terminating a backend whose client is still open.
 *
 * A pool that was never created (setup failed first) is left alone, as the
 * `pool?.end()` it replaces did.
 */
export async function endPoolAndWaitForClients(pool: Pool | null | undefined): Promise<void> {
  if (!pool) return
  const clients = (pool as unknown as { _clients: unknown })._clients
  if (!Array.isArray(clients)) {
    throw new Error('pg-pool internals changed: _clients is not an array')
  }
  if (!pool.listeners('error').includes(handlePoolTeardownError)) {
    pool.on('error', handlePoolTeardownError)
  }
  const listeners: Array<[ClosingClient, () => void]> = []
  const closed = (clients as ClosingClient[]).map(
    client =>
      new Promise<void>(resolve => {
        if (client._ended) {
          resolve()
          return
        }
        const onEnd = (): void => resolve()
        listeners.push([client, onEnd])
        client.once('end', onEnd)
      })
  )
  let timer: NodeJS.Timeout | undefined
  try {
    await Promise.race([
      (async () => {
        await pool.end()
        await Promise.all(closed)
      })(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('Timed out after 5000ms waiting for pg pool clients to close')),
          5_000
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
    for (const [client, onEnd] of listeners) client.off('end', onEnd)
  }
}
