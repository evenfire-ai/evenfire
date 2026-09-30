import type { EventEmitter } from 'node:events'
import type { Pool } from 'pg'

type TrackedClient = EventEmitter & { _ended?: boolean }

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
 * The clients are taken from pg-pool's `_clients` at call time and each one is
 * awaited on its own `end` event. Counting pool `remove` events is not enough:
 * pg-pool emits none for a client whose connect fails (or whose onConnect
 * rejects), which hangs the wait, and a `remove` from a client dropped before
 * this call is counted in place of one still closing, which ends it early.
 * `_clients` is private to pg-pool 3.x; the helper throws if it is missing.
 * A client still open after `timeoutMs` rejects with a count, so a teardown
 * fails with a cause instead of the hook timeout.
 *
 * A pool that was never created (setup failed first) is left alone, as the
 * `pool?.end()` it replaces did.
 */
export async function endPoolAndWaitForClients(
  pool: Pool | null | undefined,
  timeoutMs = 10_000
): Promise<void> {
  if (!pool) return
  const clients = (pool as unknown as { _clients?: unknown })._clients
  if (!Array.isArray(clients)) {
    throw new Error(
      'endPoolAndWaitForClients: pg-pool no longer exposes _clients; update the helper for this pg-pool version'
    )
  }
  const tracked = clients.slice() as TrackedClient[]
  const listeners: Array<[TrackedClient, () => void]> = []
  const ended = tracked.map(
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
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const open = tracked.filter(client => !client._ended).length
      reject(
        new Error(
          `endPoolAndWaitForClients: ${open} of ${tracked.length} client(s) held at end() still connected after ${timeoutMs} ms (pool.ended=${pool.ended})`
        )
      )
    }, timeoutMs)
  })
  try {
    await Promise.race([Promise.all([pool.end(), ...ended]), timeout])
  } finally {
    clearTimeout(timer)
    for (const [client, onEnd] of listeners) client.off('end', onEnd)
  }
}
