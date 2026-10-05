import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import net from 'node:net'
import type { AddressInfo, Socket } from 'node:net'
import { Pool } from 'pg'
import type { PoolClient } from 'pg'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'

// pg-pool resolves end() once its `_clients` list is empty, while each
// client.end() it started is still in flight; a pg Client sets `_ended` and
// emits 'end' when its connection has closed. The fakes keep that ordering:
// end() resolves at once and the test decides when each client finishes
// closing.
class FakeClient extends EventEmitter {
  onClosed?: () => void

  constructor(public _ended = false) {
    super()
  }

  finishClosing(): void {
    this._ended = true
    this.emit('end')
    this.onClosed?.()
  }
}

class FakePool extends EventEmitter {
  readonly end = vi.fn(async () => {
    if (!Array.isArray(this._clients)) return
    for (const client of this._clients.splice(0) as FakeClient[]) {
      if (client._ended) this.emit('remove', client)
      else client.onClosed = () => void this.emit('remove', client)
    }
  })

  get totalCount(): number {
    return Array.isArray(this._clients) ? this._clients.length : 0
  }

  constructor(readonly _clients: unknown) {
    super()
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
    const alreadyEnded = new FakeClient(true)
    const a = new FakeClient()
    const b = new FakeClient()
    const pool = new FakePool([alreadyEnded, a, b])
    const done = endPoolAndWaitForClients(pool as unknown as Pool)

    expect(await settledAfterMicrotasks(done)).toBe(false)
    expect(pool.end).toHaveBeenCalledTimes(1)
    expect(a.listenerCount('end')).toBe(1)
    expect(b.listenerCount('end')).toBe(1)
    expect(alreadyEnded.listenerCount('end')).toBe(0)

    a.finishClosing()
    expect(await settledAfterMicrotasks(done)).toBe(false)

    b.finishClosing()
    await expect(done).resolves.toBeUndefined()
    expect(a.listenerCount('end')).toBe(0)
    expect(b.listenerCount('end')).toBe(0)
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
    expect(pool.end).toHaveBeenCalledTimes(1)
    expect(client.listenerCount('end')).toBe(0)
  })

  it.each(['client closure', 'pool.end()'] as const)(
    'rejects within five seconds when %s never settles and removes its listeners and timer',
    async phase => {
      vi.useFakeTimers()
      try {
        const client = new FakeClient()
        const pool = new FakePool([client])
        if (phase === 'pool.end()') {
          pool.end.mockImplementationOnce(() => new Promise<void>(() => {}))
        }
        const done = endPoolAndWaitForClients(pool as unknown as Pool)
        const errorListeners = pool.listeners('error')
        expect(errorListeners).toHaveLength(1)
        const outcome = done.then(
          () => undefined,
          (error: unknown) => error
        )

        await vi.advanceTimersByTimeAsync(4_999)
        expect(await settledAfterMicrotasks(done)).toBe(false)
        expect(client.listenerCount('end')).toBe(1)

        await vi.advanceTimersByTimeAsync(1)
        expect(await settledAfterMicrotasks(done)).toBe(true)
        expect(await outcome).toMatchObject({
          message: 'Timed out after 5000ms waiting for pg pool clients to close',
        })
        expect(pool.end).toHaveBeenCalledTimes(1)
        expect(client.listenerCount('end')).toBe(0)
        expect(pool.listeners('error')).toEqual(errorListeners)
        expect(vi.getTimerCount()).toBe(0)
        client.finishClosing()
      } finally {
        vi.useRealTimers()
      }
    }
  )

  it('clears the deadline after a successful close or an end() rejection', async () => {
    vi.useFakeTimers()
    try {
      const pool = new FakePool([])
      await endPoolAndWaitForClients(pool as unknown as Pool)
      expect(vi.getTimerCount()).toBe(0)

      pool.end.mockRejectedValueOnce(new Error('pool end failed'))
      await expect(endPoolAndWaitForClients(pool as unknown as Pool)).rejects.toThrow(
        'pool end failed'
      )
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('throws before end() when pg-pool no longer keeps _clients as an array', async () => {
    const pool = new FakePool(new Set([new FakeClient()]))
    await expect(endPoolAndWaitForClients(pool as unknown as Pool)).rejects.toThrow(
      'pg-pool internals changed: _clients is not an array'
    )
    expect(pool.end).not.toHaveBeenCalled()
  })

  it('does nothing for a pool that was never created', async () => {
    await expect(endPoolAndWaitForClients(undefined)).resolves.toBeUndefined()
    await expect(endPoolAndWaitForClients(null)).resolves.toBeUndefined()
  })

  it('rejects an unexpected pool error during end and preserves the earlier observer', async () => {
    const pool = new FakePool([])
    const earlierObserver = vi.fn()
    const error = Object.assign(new Error('unexpected pool failure'), { code: 'XX000' })
    pool.on('error', earlierObserver)
    pool.end.mockImplementationOnce(async () => {
      pool.emit('error', error)
    })

    await expect(endPoolAndWaitForClients(pool as unknown as Pool)).rejects.toBe(error)
    expect(earlierObserver).toHaveBeenCalledWith(error)
    expect(pool.listeners('error')).toHaveLength(2)
    expect(pool.listeners('error')[0]).toBe(earlierObserver)
  })

  it('keeps prior real-pool listeners, exposes unexpected errors, and adds no observer on a repeated end', async () => {
    const pool = new Pool({ host: '127.0.0.1', port: 1, user: 'unused', database: 'unused' })
    const earlierObserver = vi.fn()
    pool.on('error', earlierObserver)
    await endPoolAndWaitForClients(pool)
    const listeners = pool.listeners('error')
    expect(listeners).toHaveLength(2)
    expect(listeners[0]).toBe(earlierObserver)

    await expect(endPoolAndWaitForClients(pool)).rejects.toThrow(
      'Called end on pool more than once'
    )
    expect(pool.listeners('error')).toEqual(listeners)

    const expected = Object.assign(new Error('backend terminated during teardown'), {
      code: '57P01',
    })
    expect(() => pool.emit('error', expected)).not.toThrow()
    expect(earlierObserver).toHaveBeenLastCalledWith(expected)
    const unexpected = Object.assign(new Error('unexpected pool failure'), { code: 'XX000' })
    expect(() => pool.emit('error', unexpected)).toThrow(unexpected)
    expect(earlierObserver).toHaveBeenLastCalledWith(unexpected)
    expect(pool.listeners('error')).toEqual(listeners)
  })

  it('ends a real pg Pool that never connected', async () => {
    // Never connects: nothing checks a client out before end().
    const pool = new Pool({ host: '127.0.0.1', port: 1, user: 'unused', database: 'unused' })
    expect(pool.totalCount).toBe(0)
    await endPoolAndWaitForClients(pool)
    expect(pool.ended).toBe(true)
  })
})

// A PostgreSQL wire-protocol stub, enough for a real pg Pool to connect, check
// clients out and end them. It answers the startup message with
// AuthenticationOk + ReadyForQuery, never answers a query, and closes a
// connection a per-connection delay after that connection's Terminate, so a
// test decides when and in which order each client finishes closing.
// `dropEveryConnection` destroys each socket as soon as it is accepted, so a
// client is left in the middle of connect().
interface PgWireStub {
  readonly port: number
  /** Terminate messages received, across every connection. */
  terminates(): number
  close(): Promise<void>
}

const AUTHENTICATION_OK = Buffer.from([0x52, 0, 0, 0, 8, 0, 0, 0, 0])
const READY_FOR_QUERY_IDLE = Buffer.from([0x5a, 0, 0, 0, 5, 0x49])
const TERMINATE = 0x58

async function startPgWireStub(
  options: { closeDelayMsByConnection: readonly (number | null)[] } | { dropEveryConnection: true }
): Promise<PgWireStub> {
  let accepted = 0
  let terminates = 0
  const sockets = new Set<Socket>()
  const server = net.createServer({ allowHalfOpen: true }, (socket: Socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    const index = accepted
    accepted += 1
    if ('dropEveryConnection' in options) {
      socket.destroy()
      return
    }
    const closeDelayMs = options.closeDelayMsByConnection[index]
    if (closeDelayMs === undefined) {
      socket.destroy(new Error(`pg wire stub: no close delay for connection ${index}`))
      return
    }
    let pending = Buffer.alloc(0)
    let startupDone = false
    socket.on('data', (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk])
      for (;;) {
        if (!startupDone) {
          // The startup message has no type byte: Int32 length, then the body.
          if (pending.length < 4) return
          const length = pending.readInt32BE(0)
          if (pending.length < length) return
          pending = pending.subarray(length)
          startupDone = true
          socket.write(Buffer.concat([AUTHENTICATION_OK, READY_FOR_QUERY_IDLE]))
          continue
        }
        // Every later message: Byte1 type, Int32 length (counts itself).
        if (pending.length < 5) return
        const type = pending[0]
        const length = pending.readInt32BE(1)
        if (pending.length < 1 + length) return
        pending = pending.subarray(1 + length)
        if (type === TERMINATE) {
          terminates += 1
          // null deliberately holds this connection until fixture cleanup so
          // a test can forward a late client error after the helper returns.
          if (closeDelayMs !== null) setTimeout(() => socket.end(), closeDelayMs)
        }
      }
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    port,
    terminates: () => terminates,
    close: () => {
      for (const socket of sockets) socket.destroy()
      return new Promise<void>((resolve, reject) =>
        server.close(err => (err ? reject(err) : resolve()))
      )
    },
  }
}

function stubPool(port: number): Pool {
  return new Pool({
    host: '127.0.0.1',
    port,
    user: 'stub',
    database: 'stub',
    password: 'stub',
    max: 2,
  })
}

// The client's own TCP socket. Its 'close' is the independent witness that the
// connection is really gone, as opposed to anything the pool reports.
function socketOf(client: PoolClient): Socket {
  return (client as unknown as { connection: { stream: Socket } }).connection.stream
}

function socketClosed(client: PoolClient): Promise<void> {
  return new Promise<void>(resolve => socketOf(client).once('close', () => resolve()))
}

async function settleWithin(promise: Promise<void>, ms: number): Promise<'resolved' | 'timeout'> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<'timeout'>(resolve => {
    timer = setTimeout(() => resolve('timeout'), ms)
  })
  try {
    return await Promise.race([promise.then(() => 'resolved' as const), timeout])
  } finally {
    clearTimeout(timer)
  }
}

describe('endPoolAndWaitForClients against a real pg Pool and a PG wire stub', () => {
  it.each(['57P01', 'XX000'])(
    'handles a removed client forwarding %s after the helper returns',
    async code => {
      const stub = await startPgWireStub({ closeDelayMsByConnection: [null, 0] })
      const pool = stubPool(stub.port)
      const emit = vi.spyOn(pool, 'emit')
      try {
        const removed = await pool.connect()
        const held = await pool.connect()
        held.release()
        removed.release(true)
        expect(pool.totalCount).toBe(1)

        await endPoolAndWaitForClients(pool)

        expect(pool.ended).toBe(true)
        expect(pool.totalCount).toBe(0)
        expect(socketOf(held).destroyed).toBe(true)
        expect(socketOf(removed).destroyed).toBe(false)
        emit.mockClear()
        const error = Object.assign(new Error('late PostgreSQL client error'), { code })
        // This is the real client's existing pg-pool idleListener. The emit
        // spy passes through and adds no pool error listener that could hide
        // missing helper protection. Unexpected errors must still escape.
        const forward = (): void => {
          removed.emit('error', error)
        }
        if (code === '57P01') expect(forward).not.toThrow()
        else expect(forward).toThrow(error)

        const forwarded = emit.mock.calls.filter(([event]) => event === 'error')
        expect(forwarded).toHaveLength(1)
        expect(forwarded[0]?.[1]).toBe(error)
        expect(forwarded[0]?.[2]).toBe(removed)
      } finally {
        emit.mockRestore()
        await stub.close()
      }
    }
  )

  it('resolves when a client still connecting at end() fails to connect', async () => {
    const stub = await startPgWireStub({ dropEveryConnection: true })
    try {
      const pool = stubPool(stub.port)
      // Settled into a value at once, so the rejection is observed, not left
      // unhandled while the helper runs. The error text depends on whether the
      // platform reports the drop as a reset or as a close, so only the
      // rejection itself is asserted.
      const queryOutcome = pool.query('SELECT 1').then(
        () => 'resolved' as const,
        (error: unknown) => error
      )
      // The query's client is in the pool's list while it is still connecting.
      expect(pool.totalCount).toBe(1)

      const outcome = await settleWithin(endPoolAndWaitForClients(pool), 2000)

      expect(await queryOutcome).toBeInstanceOf(Error)
      expect(outcome).toBe('resolved')
      expect(pool.ended).toBe(true)
    } finally {
      await stub.close()
    }
  })

  it('resolves only after every idle client has closed its socket', async () => {
    const stub = await startPgWireStub({ closeDelayMsByConnection: [40, 120] })
    try {
      const pool = stubPool(stub.port)
      const a = await pool.connect()
      const b = await pool.connect()
      const events: string[] = []
      const aClosed = socketClosed(a).then(() => void events.push('a-closed'))
      const bClosed = socketClosed(b).then(() => void events.push('b-closed'))
      a.release()
      b.release()
      expect(pool.totalCount).toBe(2)
      expect(pool.idleCount).toBe(2)

      await endPoolAndWaitForClients(pool)
      events.push('helper')
      await Promise.all([aClosed, bClosed])

      expect(events).toEqual(['a-closed', 'b-closed', 'helper'])
      expect(stub.terminates()).toBe(2)
    } finally {
      await stub.close()
    }
  })

  it('waits for the client it holds, not for one the pool removed before end()', async () => {
    const stub = await startPgWireStub({ closeDelayMsByConnection: [20, 300] })
    try {
      const pool = stubPool(stub.port)
      const a = await pool.connect()
      const b = await pool.connect()
      const events: string[] = []
      const aClosed = socketClosed(a)
      const bClosed = socketClosed(b).then(() => void events.push('b-closed'))
      b.release()
      // release(true) destroys the client: the pool drops it from its list now
      // and emits 'remove' once its connection closes, 20 ms later.
      a.release(true)
      expect(pool.totalCount).toBe(1)

      await endPoolAndWaitForClients(pool)
      events.push('helper')
      await Promise.all([aClosed, bClosed])

      expect(events).toEqual(['b-closed', 'helper'])
      expect(stub.terminates()).toBe(2)
    } finally {
      await stub.close()
    }
  })
})
