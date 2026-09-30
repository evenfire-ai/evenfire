import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import net from 'node:net'
import type { AddressInfo, Socket } from 'node:net'
import { Pool } from 'pg'
import type { PoolClient } from 'pg'
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
  options: { closeDelayMsByConnection: readonly number[] } | { dropEveryConnection: true }
): Promise<PgWireStub> {
  let accepted = 0
  let terminates = 0
  const server = net.createServer({ allowHalfOpen: true }, (socket: Socket) => {
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
          setTimeout(() => socket.end(), closeDelayMs)
        }
      }
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    port,
    terminates: () => terminates,
    close: () =>
      new Promise<void>((resolve, reject) => server.close(err => (err ? reject(err) : resolve()))),
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
  it('resolves when a client still connecting at end() fails to connect (R4-M1)', async () => {
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

  it('resolves only after every idle client has closed its socket (R4-M3)', async () => {
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

  it('waits for the client it holds, not for one the pool removed before end() (R4-L12)', async () => {
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
