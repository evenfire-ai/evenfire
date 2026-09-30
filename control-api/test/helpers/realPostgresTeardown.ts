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

/**
 * Ends a pg pool and resolves only after every client it held at end() has
 * closed its connection.
 *
 * pg-pool's end() resolves as soon as its client list is empty, while each
 * client.end() it started is still in flight. A real-Postgres teardown that
 * then runs pg_terminate_backend can reach a client that is still closing; the
 * 57P01 it receives is re-emitted on the pool and, with no pool `error`
 * listener, fails the run as an unhandled error (#946).
 *
 * The helper snapshots the clients the pool holds before end() and waits for
 * each one by identity. Counting pool `remove` events against `totalCount` is
 * wrong both ways (pg-pool 3.13.0, `pg-pool/index.js`):
 * - a client still connecting is in `_clients` (:242), but a failed connect
 *   (:271-274) or a rejected onConnect (:294-295) drops it without `_remove`,
 *   so no `remove` is ever emitted and the wait never ends (R4-M1);
 * - a client removed before end() (release(true), expiry, idle timeout) is no
 *   longer counted, yet `_remove` (:172-188) still emits its `remove` when its
 *   connection closes, which stands in for a client still closing (R4-L12).
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
 * snapshot and is not waited for; a teardown that needs it closed must end it
 * before calling this helper.
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
  try {
    await pool.end()
    await Promise.all(closed)
  } finally {
    for (const [client, onEnd] of listeners) client.off('end', onEnd)
  }
}
