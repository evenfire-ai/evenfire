import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { Pool } from 'pg'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'

// pg-pool resolves end() while each client.end() is still in flight and emits
// 'remove' from that client's end callback. The fake keeps that ordering: end()
// resolves at once and the test decides when each client finishes closing.
class FakePool extends EventEmitter {
  readonly end = vi.fn(async () => {})
  constructor(readonly totalCount: number) {
    super()
  }
}

async function settledAfterMicrotasks(promise: Promise<void>): Promise<boolean> {
  let settled = false
  void promise.then(() => {
    settled = true
  })
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
  return settled
}

describe('endPoolAndWaitForClients', () => {
  it('resolves only after every client open at end() has emitted remove', async () => {
    const pool = new FakePool(2)
    const done = endPoolAndWaitForClients(pool as unknown as Pool)

    expect(await settledAfterMicrotasks(done)).toBe(false)
    expect(pool.end).toHaveBeenCalledTimes(1)

    pool.emit('remove', {})
    expect(await settledAfterMicrotasks(done)).toBe(false)

    pool.emit('remove', {})
    await expect(done).resolves.toBeUndefined()
    expect(pool.listenerCount('remove')).toBe(0)
  })

  it('resolves after end() when the pool holds no client', async () => {
    const pool = new FakePool(0)
    await expect(endPoolAndWaitForClients(pool as unknown as Pool)).resolves.toBeUndefined()
    expect(pool.end).toHaveBeenCalledTimes(1)
    expect(pool.listenerCount('remove')).toBe(0)
  })

  it('rejects when end() rejects', async () => {
    const pool = new FakePool(1)
    pool.end.mockRejectedValueOnce(new Error('Called end on pool more than once'))
    await expect(endPoolAndWaitForClients(pool as unknown as Pool)).rejects.toThrow(
      'Called end on pool more than once'
    )
    expect(pool.listenerCount('remove')).toBe(0)
  })

  it('does nothing for a pool that was never created', async () => {
    await expect(endPoolAndWaitForClients(undefined)).resolves.toBeUndefined()
    await expect(endPoolAndWaitForClients(null)).resolves.toBeUndefined()
  })

  it('ends a real pg Pool that never connected', async () => {
    // Never connects: nothing checks a client out before end().
    const pool = new Pool({ host: '127.0.0.1', port: 1, user: 'unused', database: 'unused' })
    expect(pool.totalCount).toBe(0)
    await endPoolAndWaitForClients(pool)
    expect(pool.ended).toBe(true)
  })
})
