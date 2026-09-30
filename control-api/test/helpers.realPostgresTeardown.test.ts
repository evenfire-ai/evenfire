import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { Pool } from 'pg'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'

// pg-pool resolves end() while each client.end() is still in flight; the pg
// Client emits 'end' once its connection has closed and sets `_ended`. The
// fake keeps that ordering: end() resolves at once and the test decides when
// each client finishes closing.
class FakeClient extends EventEmitter {
  _ended = false
  finishClosing(): void {
    this._ended = true
    this.emit('end')
  }
}

class FakePool extends EventEmitter {
  readonly end = vi.fn(async () => {})
  ended = false
  readonly _clients: FakeClient[]
  constructor(clients: FakeClient[]) {
    super()
    this._clients = clients
  }
  get totalCount(): number {
    return this._clients.length
  }
}

async function settledAfterMicrotasks(promise: Promise<void>): Promise<boolean> {
  let settled = false
  void promise.then(
    () => {
      settled = true
    },
    () => {
      settled = true
    }
  )
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
  return settled
}

describe('endPoolAndWaitForClients', () => {
  it('resolves only after every client held at end() has ended', async () => {
    const clients = [new FakeClient(), new FakeClient()]
    const pool = new FakePool(clients)
    const done = endPoolAndWaitForClients(pool as unknown as Pool)

    expect(await settledAfterMicrotasks(done)).toBe(false)
    expect(pool.end).toHaveBeenCalledTimes(1)

    clients[0].finishClosing()
    expect(await settledAfterMicrotasks(done)).toBe(false)

    clients[1].finishClosing()
    expect(await settledAfterMicrotasks(done)).toBe(true)
    await expect(done).resolves.toBeUndefined()
    expect(clients.map(client => client.listenerCount('end'))).toEqual([0, 0])
  })

  it('is not ended early by a remove event from a client it does not track', async () => {
    const tracked = new FakeClient()
    const pool = new FakePool([tracked])
    const done = endPoolAndWaitForClients(pool as unknown as Pool)

    // A client dropped before the call emits its remove late.
    pool.emit('remove', new FakeClient())
    expect(await settledAfterMicrotasks(done)).toBe(false)
    expect(pool.end).toHaveBeenCalledTimes(1)

    tracked.finishClosing()
    await expect(done).resolves.toBeUndefined()
  })

  it('does not wait for a client that had already ended', async () => {
    const closed = new FakeClient()
    closed._ended = true
    const pool = new FakePool([closed])
    await expect(endPoolAndWaitForClients(pool as unknown as Pool)).resolves.toBeUndefined()
    expect(pool.end).toHaveBeenCalledTimes(1)
  })

  it('rejects with a description when a client never ends', { timeout: 2_000 }, async () => {
    const stuck = new FakeClient()
    const pool = new FakePool([stuck])
    await expect(endPoolAndWaitForClients(pool as unknown as Pool, 50)).rejects.toThrow(
      'endPoolAndWaitForClients: 1 of 1 client(s) held at end() still connected after 50 ms (pool.ended=false)'
    )
    expect(pool.end).toHaveBeenCalledTimes(1)
    expect(stuck.listenerCount('end')).toBe(0)
  })

  it('throws when the pool does not expose its client list', async () => {
    const pool = Object.assign(new EventEmitter(), { end: vi.fn(async () => {}), totalCount: 0 })
    await expect(endPoolAndWaitForClients(pool as unknown as Pool)).rejects.toThrow(
      'endPoolAndWaitForClients: pg-pool no longer exposes _clients'
    )
    expect(pool.end).not.toHaveBeenCalled()
    // Witness that the helper ran: the refusal above names the missing list.
  })

  it('resolves after end() when the pool holds no client', async () => {
    const pool = new FakePool([])
    await expect(endPoolAndWaitForClients(pool as unknown as Pool)).resolves.toBeUndefined()
    expect(pool.end).toHaveBeenCalledTimes(1)
  })

  it('rejects when end() rejects', async () => {
    const client = new FakeClient()
    const pool = new FakePool([client])
    pool.end.mockRejectedValueOnce(new Error('Called end on pool more than once'))
    await expect(endPoolAndWaitForClients(pool as unknown as Pool)).rejects.toThrow(
      'Called end on pool more than once'
    )
    expect(client.listenerCount('end')).toBe(0)
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

  it('ends a real pg Pool whose in-flight connect is refused', { timeout: 5_000 }, async () => {
    // pg-pool emits no remove for a client whose connect fails; the client
    // still emits end.
    const pool = new Pool({ host: '127.0.0.1', port: 1, user: 'unused', database: 'unused' })
    const query = pool.query('SELECT 1')
    const queryOutcome = query.then(
      () => 'resolved',
      (err: NodeJS.ErrnoException) => err.code
    )
    expect(pool.totalCount).toBe(1)

    await endPoolAndWaitForClients(pool)

    expect(pool.ended).toBe(true)
    expect(await queryOutcome).toBe('ECONNREFUSED')
  })
})
