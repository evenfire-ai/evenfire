import type { Pool } from 'pg'

/**
 * Ends a pg pool and resolves only after every client it held has closed its
 * connection.
 *
 * pg-pool's end() resolves as soon as its client list is empty, while each
 * client.end() it started is still in flight. A real-Postgres teardown that
 * then runs pg_terminate_backend can reach a client that is still closing; the
 * 57P01 it receives is re-emitted on the pool and, with no pool `error`
 * listener, fails the run as an unhandled error (#946). pg-pool emits `remove`
 * from each client's end callback, so waiting for one `remove` per client open
 * at end() closes that window without listening for errors.
 *
 * A pool that was never created (setup failed first) is left alone, as the
 * `pool?.end()` it replaces did.
 */
export async function endPoolAndWaitForClients(pool: Pool | null | undefined): Promise<void> {
  if (!pool) return
  const open = pool.totalCount
  let removed = 0
  let onRemove: (() => void) | undefined
  const closed = new Promise<void>(resolve => {
    if (open === 0) {
      resolve()
      return
    }
    onRemove = () => {
      removed += 1
      if (removed === open) resolve()
    }
    pool.on('remove', onRemove)
  })
  try {
    await pool.end()
    await closed
  } finally {
    if (onRemove) pool.off('remove', onRemove)
  }
}
