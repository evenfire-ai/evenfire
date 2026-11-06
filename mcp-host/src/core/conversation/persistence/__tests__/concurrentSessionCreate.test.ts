/**
 * Two requests on a new chat can reach `getOrCreate` before either has
 * cached the conversation, for example two parallel model selections or a
 * selection racing the first message. Both must receive one conversation
 * backed by one session row. Two creations insert two rows with the same
 * `session_key`; the second insert fails on that unique index, and a failed
 * async write makes the persist queue unusable.
 */
import { describe, expect, it, vi } from 'vitest'
import { ConversationError } from '../../../errors'
import { ConversationManager } from '../../conversation'
import { PersistQueue, type WorkerLike } from '../persistQueue'
import { SqliteConversationStore } from '../sqliteConversationStore'
import { createInProcessWorker } from './testHelpers'

function setup() {
  const inner = createInProcessWorker(':memory:')
  // 2 ms per message stands in for a worker thread's round trip. Without it
  // the in-process worker answers within the same millisecond and both
  // creations would mint the same `conv-<key>-<ms>` id, hiding the race.
  const worker: WorkerLike = {
    ...inner.worker,
    postMessage: m => void setTimeout(() => inner.worker.postMessage(m), 2),
  }
  const onFailure = vi.fn()
  const queue = new PersistQueue(worker, {
    syncTimeoutMs: 2000,
    asyncTimeoutMs: 5000,
    stallTimeoutMs: 30_000,
    onFailure,
  })
  const manager = new ConversationManager(new SqliteConversationStore(queue, { cacheSize: 8 }))
  const rows = (key: string) =>
    inner.db.prepare('SELECT id FROM sessions WHERE session_key = ?').all(key) as Array<{
      id: string
    }>
  return { manager, queue, onFailure, rows }
}

describe('concurrent getOrCreate on a new session key', () => {
  it('creates one conversation and one session row', async () => {
    const { manager, queue, onFailure, rows } = setup()
    const key = 'u-1:rpc:host-a:fresh-chat'

    const [a, b, c] = await Promise.all([
      manager.getOrCreate(key, { userId: 'u-1' }),
      manager.getOrCreate(key, { userId: 'u-1' }),
      manager.getOrCreate(key, { userId: 'u-1' }),
    ])
    await queue.drain()

    expect(b).toBe(a)
    expect(c).toBe(a)
    // Witness: the row was written, under the id every caller received.
    expect(rows(key)).toEqual([{ id: a.id }])
    expect(onFailure).not.toHaveBeenCalled()
    await queue.close()
  })

  it('still refuses a concurrent caller that does not own the session', async () => {
    const { manager, queue, onFailure, rows } = setup()
    const key = 'u-1:rpc:host-a:fresh-chat'

    const [owner, other] = await Promise.allSettled([
      manager.getOrCreate(key, { userId: 'u-1' }),
      manager.getOrCreate(key, { userId: 'u-2' }),
    ])
    await queue.drain()

    expect(owner.status).toBe('fulfilled')
    expect(other.status).toBe('rejected')
    expect((other as PromiseRejectedResult).reason).toBeInstanceOf(ConversationError)
    // Witness: the owner's creation was persisted.
    const created = (owner as PromiseFulfilledResult<{ id: string; user_id: string }>).value
    expect(created.user_id).toBe('u-1')
    expect(rows(key)).toEqual([{ id: created.id }])
    expect(onFailure).not.toHaveBeenCalled()
    await queue.close()
  })
})
