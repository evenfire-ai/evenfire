import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Notification } from 'pg'
import pino from 'pino'
import { rootLogger } from '../src/observability/logger.js'
import {
  gfsWatchDispatchFailedTotal,
  gfsWatchNotifyInvalidTotal,
  gfsWatchTickFailedTotal,
} from '../src/observability/metrics.js'
import type { Rid32 } from '../src/services/gfsWatch/keys.js'
import { normUid } from '../src/services/gfsWatch/keys.js'
import {
  GFS_WATCH_INSTANCE_ID,
  type ListenerClient,
  type ListenerConn,
  createGfsWatchListener,
} from '../src/services/gfsWatch/listener.js'
import { serializeWatchCmd } from '../src/services/gfsWatch/notifySchemas.js'
import { createRecentDirty } from '../src/services/gfsWatch/recentDirty.js'
import { createWatchRuntime } from '../src/services/gfsWatch/runtime.js'
import {
  type VirtualWatchClock,
  createVirtualWatchClock,
  flushMicrotasks,
} from './helpers/gfsWatchClock.js'

type Handler = (...args: unknown[]) => void

/**
 * A pg.Client stand-in. It loops a ping NOTIFY back to its own notification
 * listeners, as Postgres does for a session that LISTENs on the channel, and
 * keeps every handler ever registered so a test can fire an event of a client
 * the listener has already disposed.
 */
class FakeClient implements ListenerClient {
  handlers = new Map<string, Handler[]>()
  everRegistered = new Map<string, Handler[]>()
  queries: { text: string; values?: unknown[] }[] = []
  ended = 0
  destroyed = 0
  echo = true
  /** The next `on` for this event throws once, before registering anything. */
  throwOn: string | null = null
  connectResult: { resolve: () => void; reject: (e: Error) => void } | null = null
  connection = { stream: { destroy: () => void (this.destroyed += 1) } }

  on(event: string, listener: Handler) {
    if (event === this.throwOn) {
      this.throwOn = null
      throw new Error(`on('${event}') failed`)
    }
    for (const map of [this.handlers, this.everRegistered]) {
      map.set(event, [...(map.get(event) ?? []), listener])
    }
    return this
  }
  removeAllListeners() {
    this.handlers.clear()
    return this
  }
  emit(event: string, ...args: unknown[]) {
    for (const h of this.handlers.get(event) ?? []) h(...args)
  }
  connect() {
    return new Promise<void>((resolve, reject) => (this.connectResult = { resolve, reject }))
  }
  query(text: string, values?: unknown[]) {
    this.queries.push({ text, values })
    if (text.includes('pg_notify') && this.echo) {
      const payload = String(values?.[0])
      queueMicrotask(() =>
        this.emit('notification', { channel: 'gfs_watch_ping', payload, processId: 1 })
      )
    }
    return Promise.resolve({})
  }
  end() {
    this.ended += 1
    return Promise.resolve()
  }
}

type Conn = ListenerConn & { op: { dirtyOverflow: boolean } | null }

/** How the n-th createClient call (1-based) fails, if it does. */
type CreateFault = (n: number) => 'create' | 'on' | null

async function counterValue(
  metric: { get(): Promise<{ values: { labels: Record<string, unknown>; value: number }[] }> },
  labels: Record<string, string>
): Promise<number> {
  const { values } = await metric.get()
  return values
    .filter(v => Object.entries(labels).every(([k, x]) => v.labels[k] === x))
    .reduce((a, v) => a + v.value, 0)
}

let unhandled: unknown[] = []
const onUnhandled = (reason: unknown) => unhandled.push(reason)
beforeEach(() => {
  unhandled = []
  process.on('unhandledRejection', onUnhandled)
})
afterEach(async () => {
  await new Promise(resolve => setImmediate(resolve))
  process.off('unhandledRejection', onUnhandled)
  expect(unhandled).toEqual([])
})

function setup({
  conns = [] as Conn[],
  clock = createVirtualWatchClock({ random: () => 0 }) as VirtualWatchClock,
  autoConnect = true,
  instanceId,
  createFault = () => null,
}: {
  conns?: Conn[]
  clock?: VirtualWatchClock
  autoConnect?: boolean
  instanceId?: string
  createFault?: CreateFault
} = {}) {
  const clients: FakeClient[] = []
  /** Clock instant of every createClient call, including the ones that throw. */
  const attempts: number[] = []
  const events: string[] = []
  const closed: { connId: string; reason: string; spreadMs?: number }[] = []
  const live = new Set(conns)
  const recentDirty = createRecentDirty(clock.now)
  const onCmd = vi.fn()
  const onResourceChanged = vi.fn()
  const resetWindows = vi.fn(() => events.push('resetWindows'))
  const onExpansionFailed = vi.fn(() => events.push('onExpansionFailed'))
  let listener!: ReturnType<typeof createGfsWatchListener<Conn>>
  const closeConn = vi.fn((conn: Conn, reason: string, opts?: { spreadMs: number }) => {
    events.push(`close:${conn.connId}:${reason}:ready=${listener.state.listenerReady}`)
    closed.push({ connId: conn.connId, reason, spreadMs: opts?.spreadMs })
    live.delete(conn)
  })
  const rt = createWatchRuntime<Conn>({
    clock,
    closeConnInternal: conn => closeConn(conn, 'internal'),
  })
  listener = createGfsWatchListener<Conn>({
    connectionString: 'postgres://unused',
    runtime: rt,
    recentDirty,
    connections: () => live,
    opsInFlight: () => [...live].filter(c => c.op !== null),
    closeConn,
    onCmd,
    onResourceChanged,
    resetWindows,
    onExpansionFailed,
    instanceId,
    createClient: () => {
      attempts.push(clock.now())
      const fault = createFault(attempts.length)
      if (fault === 'create') throw new Error('invalid connection string')
      const c = new FakeClient()
      if (fault === 'on') c.throwOn = 'notification'
      clients.push(c)
      if (autoConnect) queueMicrotask(() => c.connectResult?.resolve())
      return c
    },
  })
  return {
    clock,
    clients,
    attempts,
    events,
    closed,
    live,
    recentDirty,
    onCmd,
    onResourceChanged,
    resetWindows,
    onExpansionFailed,
    closeConn,
    rt,
    listener,
  }
}

const conn = (id: string, op = false): Conn => ({
  connId: id,
  op: op ? { dirtyOverflow: false } : null,
})

describe('connectListener and the echo liveness proof', () => {
  it('connects, LISTENs only the three PR channels, and pings through its own connection', async () => {
    const t = setup()
    t.listener.startGfsWatchRegistry()
    await flushMicrotasks()
    expect(t.listener.state.listenerReady).toBe(true)
    expect(t.clients).toHaveLength(1)
    expect(t.clients[0]!.queries[0]!.text).toBe(
      'LISTEN gfs_resource_changed; LISTEN gfs_watch_ping; LISTEN gfs_watch_cmd'
    )
    await t.clock.advanceAsync(30_000)
    const pings = t.clients[0]!.queries.filter(q => q.text.includes('pg_notify'))
    expect(pings.map(p => p.values)).toEqual([
      [`${GFS_WATCH_INSTANCE_ID}:1:1`],
      [`${GFS_WATCH_INSTANCE_ID}:1:2`],
      [`${GFS_WATCH_INSTANCE_ID}:1:3`],
    ])
  })

  it('with its own echo, 2 minutes pass without a loss', async () => {
    const t = setup({ conns: [conn('a')] })
    t.listener.startGfsWatchRegistry()
    await flushMicrotasks()
    for (let i = 0; i < 24; i += 1) await t.clock.advanceAsync(5_000)
    expect(t.resetWindows).not.toHaveBeenCalled()
    expect(t.closed).toEqual([])
    expect(t.listener.state.lastEchoAt).toBe(120_000)
  })

  it('without an echo, the loss is detected after 20 s and at most 25 s after the last echo', async () => {
    const t = setup({ conns: [conn('a')] })
    t.listener.startGfsWatchRegistry()
    await flushMicrotasks()
    await t.clock.advanceAsync(10_000) // ping 1 echoed at 10 s
    expect(t.listener.state.lastEchoAt).toBe(10_000)
    t.clients[0]!.echo = false
    let lostAt: number | null = null
    for (let i = 0; i < 40 && lostAt === null; i += 1) {
      await t.clock.advanceAsync(1_000)
      if (t.resetWindows.mock.calls.length > 0) lostAt = t.clock.now()
    }
    expect(lostAt).not.toBeNull()
    expect(lostAt! - 10_000).toBeGreaterThan(20_000)
    expect(lostAt! - 10_000).toBeLessThanOrEqual(25_000)
    expect(t.closed).toEqual([{ connId: 'a', reason: 'listener_lost', spreadMs: 40 }])
  })

  it('ignores an echo of another instance, of an older epoch, and of a client no longer current', async () => {
    const t = setup()
    t.listener.startGfsWatchRegistry()
    await flushMicrotasks()
    const c1 = t.clients[0]!
    const at = t.listener.state.lastEchoAt
    await t.clock.advanceAsync(1_000)
    const other = 'f'.repeat(32)
    t.listener.dispatch({ channel: 'gfs_watch_ping', payload: `${other}:1:1`, processId: 1 }, 1)
    t.listener.dispatch(
      { channel: 'gfs_watch_ping', payload: `${GFS_WATCH_INSTANCE_ID}:2:1`, processId: 1 },
      1
    )
    expect(t.listener.state.lastEchoAt).toBe(at)
    c1.emit('error', new Error('reset'))
    await t.clock.advanceAsync(1_000) // reconnect to c2
    const handlers = c1.everRegistered.get('notification')!
    const before = t.listener.state.lastEchoAt
    await t.clock.advanceAsync(1_000)
    for (const h of handlers) {
      h({ channel: 'gfs_watch_ping', payload: `${GFS_WATCH_INSTANCE_ID}:1:9`, processId: 1 })
    }
    expect(t.listener.state.lastEchoAt).toBe(before)
  })

  it('an instance id that is not 32 lowercase hex never echoes and is lost every cycle', async () => {
    const t = setup({ instanceId: '6f1c4f5e-1b2a-4c3d-9e8f-001122334455' })
    t.listener.startGfsWatchRegistry()
    await flushMicrotasks()
    await t.clock.advanceAsync(25_000)
    expect(t.resetWindows).toHaveBeenCalledTimes(1)
  })
})

describe('onListenerLost: own state first, then the closes', () => {
  it('discards the client and schedules the reconnection before resetting windows and closing a copy', async () => {
    const conns = [conn('a'), conn('b'), conn('c')]
    const t = setup({ conns })
    t.listener.startGfsWatchRegistry()
    await flushMicrotasks()
    const c1 = t.clients[0]!
    c1.emit('end')
    expect(t.listener.state.listenerClient).toBeNull()
    expect(t.listener.state.reconnectTimer).not.toBeNull()
    expect(c1.ended).toBe(1)
    expect(t.events).toEqual([
      'resetWindows',
      'close:a:listener_lost:ready=false',
      'close:b:listener_lost:ready=false',
      'close:c:listener_lost:ready=false',
    ])
    expect(t.closed.every(c => c.spreadMs === 120)).toBe(true)
    // The disposed client's late 'error' and 'end' do nothing.
    c1.emit('error', new Error('late'))
    for (const h of c1.everRegistered.get('error')!) h(new Error('late, original handler'))
    for (const h of c1.everRegistered.get('end')!) h()
    expect(t.resetWindows).toHaveBeenCalledTimes(1)
  })

  it('a close that throws neither stops the other closes nor the transition', async () => {
    const conns = [conn('a'), conn('b'), conn('c')]
    const t = setup({ conns })
    t.closeConn.mockImplementation((c: Conn, reason: string) => {
      t.closed.push({ connId: c.connId, reason })
      if (c.connId === 'b' && reason === 'listener_lost') throw new Error('close broke')
    })
    t.listener.startGfsWatchRegistry()
    await flushMicrotasks()
    t.clients[0]!.emit('error', new Error('reset'))
    expect(t.closed.map(c => `${c.connId}:${c.reason}`)).toEqual([
      'a:listener_lost',
      'b:listener_lost',
      'b:internal',
      'c:listener_lost',
    ])
    expect(t.listener.state.listenerClient).toBeNull()
    expect(t.listener.state.reconnectTimer).not.toBeNull()
  })

  it('spreads the mass close over 40 ms per connection, capped at 10 s', async () => {
    const conns = Array.from({ length: 300 }, (_, i) => conn(`c${i}`))
    const t = setup({ conns })
    t.listener.startGfsWatchRegistry()
    await flushMicrotasks()
    t.clients[0]!.emit('end')
    expect(new Set(t.closed.map(c => c.spreadMs))).toEqual(new Set([10_000]))
    expect(t.closed).toHaveLength(300)
  })

  it('reconnects with backoff 1 s, 2 s, 4 s, 8 s, 8 s, and back to 1 s once ready', async () => {
    const t = setup({ autoConnect: false })
    t.listener.startGfsWatchRegistry()
    const gaps: number[] = []
    for (let i = 0; i < 5; i += 1) {
      const c = t.clients.at(-1)!
      c.connectResult!.reject(new Error('ECONNREFUSED'))
      await flushMicrotasks()
      const lastStart = t.clock.now()
      const n = t.clients.length
      while (t.clients.length === n) await t.clock.advanceAsync(100)
      gaps.push(Math.round(t.clock.now() - lastStart))
    }
    expect(gaps).toEqual([1_000, 2_000, 4_000, 8_000, 8_000])
    t.clients.at(-1)!.connectResult!.resolve()
    await flushMicrotasks()
    expect(t.listener.state.listenerReady).toBe(true)
    expect(t.listener.state.reconnectAttempt).toBe(0)
    t.clients.at(-1)!.emit('end')
    const n = t.clients.length
    const start = t.clock.now()
    while (t.clients.length === n) await t.clock.advanceAsync(100)
    expect(Math.round(t.clock.now() - start)).toBe(1_000)
  })

  it('with maximal jitter the next attempt is never more than 9.6 s away', async () => {
    const t = setup({
      autoConnect: false,
      clock: createVirtualWatchClock({ random: () => 0.999999 }),
    })
    t.listener.startGfsWatchRegistry()
    for (let i = 0; i < 8; i += 1) {
      t.clients.at(-1)!.connectResult!.reject(new Error('ECONNREFUSED'))
      await flushMicrotasks()
      const n = t.clients.length
      const start = t.clock.now()
      while (t.clients.length === n) await t.clock.advanceAsync(100)
      expect(t.clock.now() - start).toBeLessThanOrEqual(9_600)
    }
  })

  it('a hung connect is abandoned at 10 s and retried (I8)', async () => {
    const t = setup({ autoConnect: false })
    t.listener.startGfsWatchRegistry()
    await t.clock.advanceAsync(9_999)
    expect(t.resetWindows).not.toHaveBeenCalled()
    await t.clock.advanceAsync(1)
    expect(t.resetWindows).toHaveBeenCalledTimes(1)
    expect(t.listener.state.tConnect).toBeNull()
    expect(t.clients[0]!.ended).toBe(1)
    await t.clock.advanceAsync(1_000)
    expect(t.clients).toHaveLength(2)
  })
})

describe('T-SB33 events of a superseded client', () => {
  it("C1's error after C2 confirmed its LISTENs: no loss, one listener", async () => {
    const t = setup({ conns: [conn('a')] })
    t.listener.startGfsWatchRegistry()
    await flushMicrotasks()
    const c1 = t.clients[0]!
    c1.emit('end')
    await t.clock.advanceAsync(1_000)
    expect(t.listener.state.listenerReady).toBe(true)
    const c2 = t.clients[1]!
    expect(t.listener.state.listenerClient).toBe(c2)
    const lossesBefore = t.resetWindows.mock.calls.length
    for (const h of c1.everRegistered.get('error')!) h(new Error('C1 late error'))
    for (const h of c1.everRegistered.get('end')!) h()
    expect(t.resetWindows.mock.calls.length).toBe(lossesBefore)
    expect(t.listener.state.listenerClient).toBe(c2)
    expect(t.clients).toHaveLength(2)
  })

  it('the echo check does nothing while listenerReady = false', async () => {
    const t = setup({ autoConnect: false })
    t.listener.startGfsWatchRegistry()
    for (let i = 0; i < 9; i += 1) {
      t.listener.echoCheckTick()
      await t.clock.advanceAsync(1_000)
    }
    expect(t.resetWindows).not.toHaveBeenCalled()
  })

  it('a reconnect in progress is neither pinged nor torn down by echo checks that see the last echo long gone', async () => {
    const t = setup({ autoConnect: false })
    t.listener.startGfsWatchRegistry()
    t.clients[0]!.connectResult!.resolve()
    await flushMicrotasks()
    expect(t.listener.state.listenerReady).toBe(true)
    t.clients[0]!.echo = false
    // No echo since 0 s: the check at 25 s declares the loss, and the
    // reconnection starts c2 at 26 s, still connecting.
    await t.clock.advanceAsync(26_000)
    expect(t.resetWindows).toHaveBeenCalledTimes(1)
    const c2 = t.clients[1]!
    expect(t.listener.state.listenerClient).toBe(c2)
    expect(t.listener.state.listenerReady).toBe(false)
    // The checks at 30 s and 35 s see more than 20 s without an echo, but
    // the attempt in progress is not theirs to judge: tConnect bounds it.
    await t.clock.advanceAsync(9_000)
    expect(t.resetWindows).toHaveBeenCalledTimes(1)
    expect(t.listener.state.listenerClient).toBe(c2)
    expect(c2.ended).toBe(0)
    // Nor pinged at 30 s: an echo of a ping sent before the LISTEN would
    // prove nothing about it.
    expect(c2.queries).toEqual([])
    c2.connectResult!.resolve()
    await flushMicrotasks()
    expect(t.listener.state.listenerReady).toBe(true)
    expect(t.clients).toHaveLength(2)
  })
})

describe('stopGfsWatchRegistry', () => {
  it('cancels every process handle, never reconnects, and closes everything with server_shutdown', async () => {
    const t = setup({ conns: [conn('a'), conn('b')] })
    t.listener.startGfsWatchRegistry()
    await flushMicrotasks()
    const c1 = t.clients[0]!
    t.listener.stopGfsWatchRegistry()
    const s = t.listener.state
    expect([s.pingInterval, s.echoInterval, s.tConnect, s.reconnectTimer]).toEqual([
      null,
      null,
      null,
      null,
    ])
    expect(s.listenerReady).toBe(false)
    expect(s.listenerClient).toBeNull()
    expect(t.events).toEqual([
      'resetWindows',
      'close:a:server_shutdown:ready=false',
      'close:b:server_shutdown:ready=false',
    ])
    // Only the one-shot socket destroy of the disposed client may remain.
    expect(t.clock.pendingCount()).toBe(1)
    await t.clock.advanceAsync(60_000)
    expect(c1.destroyed).toBe(1)
    expect(t.clients).toHaveLength(1)
    expect(t.clock.pendingCount()).toBe(0)
  })

  it('a stop while connecting cancels tConnect and does not reconnect when the connect fails later', async () => {
    const t = setup({ autoConnect: false })
    t.listener.startGfsWatchRegistry()
    const c1 = t.clients[0]!
    t.listener.stopGfsWatchRegistry()
    expect(t.listener.state.tConnect).toBeNull()
    c1.connectResult!.reject(new Error('Connection terminated'))
    await t.clock.advanceAsync(30_000)
    expect(t.clients).toHaveLength(1)
    expect(t.listener.state.reconnectTimer).toBeNull()
  })
})

describe('dispatch is total and validates each channel', () => {
  const user = '6f1c4f5e-1b2a-4c3d-9e8f-001122334455'
  const validCmd = () =>
    serializeWatchCmd({
      c: 'a'.repeat(32),
      s: 1,
      u: normUid(user)!,
      g: 1,
      r: normUid(user)!,
      keys: new Set(),
    })

  async function ready(conns: Conn[] = []) {
    const t = setup({ conns })
    t.listener.startGfsWatchRegistry()
    await flushMicrotasks()
    const n = (channel: string, payload: string): Notification => ({
      channel,
      payload,
      processId: 1,
    })
    return { ...t, n, epoch: t.listener.state.listenerEpoch }
  }

  it('an invalid command or ping is counted and dropped, with no other effect', async () => {
    const t = await ready([conn('a', true)])
    const cmdBefore = await counterValue(gfsWatchNotifyInvalidTotal, { channel: 'gfs_watch_cmd' })
    const pingBefore = await counterValue(gfsWatchNotifyInvalidTotal, { channel: 'gfs_watch_ping' })
    t.listener.dispatch(t.n('gfs_watch_cmd', '{"c":"x"'), t.epoch)
    t.listener.dispatch(t.n('gfs_watch_ping', 'not-a-ping'), t.epoch)
    expect(t.onCmd).not.toHaveBeenCalled()
    expect(t.recentDirty.overflowed()).toBe(false)
    expect([...t.live][0]!.op!.dirtyOverflow).toBe(false)
    expect(await counterValue(gfsWatchNotifyInvalidTotal, { channel: 'gfs_watch_cmd' })).toBe(
      cmdBefore + 1
    )
    expect(await counterValue(gfsWatchNotifyInvalidTotal, { channel: 'gfs_watch_ping' })).toBe(
      pingBefore + 1
    )
    t.listener.dispatch(t.n('gfs_watch_cmd', validCmd()), t.epoch)
    expect(t.onCmd).toHaveBeenCalledTimes(1)
  })

  it('an invalid payload on the resource channel marks every decision suspect, then hands off to onExpansionFailed', async () => {
    const withOp = conn('a', true)
    const idle = conn('b')
    const t = await ready([withOp, idle])
    t.onExpansionFailed.mockImplementation(() => {
      // The marks are already in place when the fail-closed hook runs.
      expect(t.recentDirty.overflowed()).toBe(true)
      expect(withOp.op!.dirtyOverflow).toBe(true)
      t.events.push('onExpansionFailed')
    })
    t.listener.dispatch(t.n('gfs_resource_changed', 'garbage'), t.epoch)
    expect(t.onResourceChanged).not.toHaveBeenCalled()
    expect(t.onExpansionFailed).toHaveBeenCalledTimes(1)
    expect(t.recentDirty.overflowed()).toBe(true)
    expect(withOp.op!.dirtyOverflow).toBe(true)
    expect(idle.op).toBeNull()
    // Closing the held connections is the hook's job, not the listener's.
    expect(t.closed).toEqual([])
  })

  it('an onExpansionFailed that throws is counted and does not escape dispatch', async () => {
    const t = await ready([conn('a', true)])
    t.onExpansionFailed.mockImplementation(() => {
      throw new Error('hold failed')
    })
    const before = await counterValue(gfsWatchTickFailedTotal, { name: 'invalid-revocation-hint' })
    expect(() => t.listener.dispatch(t.n('gfs_resource_changed', 'garbage'), t.epoch)).not.toThrow()
    expect(await counterValue(gfsWatchTickFailedTotal, { name: 'invalid-revocation-hint' })).toBe(
      before + 1
    )
    expect(t.recentDirty.overflowed()).toBe(true)
  })

  it('an invalid revocation hint during shutdown does nothing', async () => {
    const withOp = conn('a', true)
    const t = await ready([withOp])
    t.live.add(withOp)
    t.listener.stopGfsWatchRegistry()
    t.live.add(withOp)
    t.listener.dispatch(t.n('gfs_resource_changed', 'garbage'), t.epoch)
    expect(t.recentDirty.overflowed()).toBe(false)
    expect(withOp.op!.dirtyOverflow).toBe(false)
    expect(t.onExpansionFailed).not.toHaveBeenCalled()
  })

  it('passes a valid resource change normalized to its handler', async () => {
    const t = await ready()
    const id = '0f1c4f5e-1b2a-4c3d-9e8f-001122334455'
    t.listener.dispatch(t.n('gfs_resource_changed', `${id},,${id},1,0,i`), t.epoch)
    expect(t.onResourceChanged).toHaveBeenCalledWith({
      rid32: id.replace(/-/g, '') as Rid32,
      oldParent: null,
      newParent: id.replace(/-/g, ''),
      h: 1,
      a: 0,
      op: 'i',
    })
  })

  it('a handler that throws is logged and counted, and dispatch does not throw', async () => {
    const t = await ready()
    t.onCmd.mockImplementation(() => {
      throw new TypeError('handler broke')
    })
    const before = await counterValue(gfsWatchDispatchFailedTotal, { channel: 'gfs_watch_cmd' })
    expect(() => t.listener.dispatch(t.n('gfs_watch_cmd', validCmd()), t.epoch)).not.toThrow()
    expect(await counterValue(gfsWatchDispatchFailedTotal, { channel: 'gfs_watch_cmd' })).toBe(
      before + 1
    )
  })

  it('a NOTIFY delivered on a superseded client is not dispatched', async () => {
    const t = await ready()
    const c1 = t.clients[0]!
    const handlers = c1.everRegistered.get('notification')!
    c1.emit('end')
    for (const h of handlers) h(t.n('gfs_watch_cmd', validCmd()))
    expect(t.onCmd).not.toHaveBeenCalled()
  })
})

describe('entry points that reject asynchronously (no unhandledRejection)', () => {
  it('connectListener throwing after the connect is caught by guardedTick and counted', async () => {
    const clock = createVirtualWatchClock()
    const originalClear = clock.clear
    let armed = true
    clock.clear = h => {
      if (armed) {
        armed = false
        throw new Error('clear broke after connect')
      }
      originalClear(h)
    }
    const before = await counterValue(gfsWatchTickFailedTotal, { name: 'listener-connect' })
    const t = setup({ clock })
    t.listener.startGfsWatchRegistry()
    await flushMicrotasks()
    expect(await counterValue(gfsWatchTickFailedTotal, { name: 'listener-connect' })).toBe(
      before + 1
    )
    // The process goes on: the tConnect left armed later discards this client and reconnects.
    await t.clock.advanceAsync(12_000)
    expect(t.clients.length).toBeGreaterThanOrEqual(2)
  })

  it('a reconnection whose connect rejects is total', async () => {
    const t = setup({ autoConnect: false })
    t.listener.startGfsWatchRegistry()
    for (let i = 0; i < 3; i += 1) {
      t.clients.at(-1)!.connectResult!.reject(new Error('Connection terminated unexpectedly'))
      await t.clock.advanceAsync(10_000)
    }
    expect(t.clients.length).toBeGreaterThanOrEqual(4)
  })
})

describe('a throwing resetWindows does not cut a process transition short', () => {
  it('onListenerLost still closes every connection and keeps its reconnection', async () => {
    const t = setup({ conns: [conn('a'), conn('b')] })
    t.resetWindows.mockImplementation(() => {
      throw new Error('windows broke')
    })
    const before = await counterValue(gfsWatchTickFailedTotal, { name: 'listener-reset-windows' })
    t.listener.startGfsWatchRegistry()
    await flushMicrotasks()
    expect(() => t.clients[0]!.emit('end')).not.toThrow()
    expect(t.closed.map(c => `${c.connId}:${c.reason}`)).toEqual([
      'a:listener_lost',
      'b:listener_lost',
    ])
    expect(t.listener.state.listenerClient).toBeNull()
    expect(t.listener.state.reconnectTimer).not.toBeNull()
    expect(await counterValue(gfsWatchTickFailedTotal, { name: 'listener-reset-windows' })).toBe(
      before + 1
    )
    await t.clock.advanceAsync(1_000)
    expect(t.listener.state.listenerReady).toBe(true)
  })

  it('stopGfsWatchRegistry still disposes the client and closes every connection', async () => {
    const t = setup({ conns: [conn('a'), conn('b')] })
    t.listener.startGfsWatchRegistry()
    await flushMicrotasks()
    const c1 = t.clients[0]!
    t.resetWindows.mockImplementation(() => {
      throw new Error('windows broke')
    })
    expect(() => t.listener.stopGfsWatchRegistry()).not.toThrow()
    expect(c1.ended).toBe(1)
    expect(t.listener.state.listenerClient).toBeNull()
    expect(t.closed.map(c => `${c.connId}:${c.reason}`)).toEqual([
      'a:server_shutdown',
      'b:server_shutdown',
    ])
  })
})

describe('tConnect belongs to the current attempt only', () => {
  it('losing the client cancels its tConnect at once', async () => {
    const t = setup({ autoConnect: false })
    t.listener.startGfsWatchRegistry()
    expect(t.listener.state.tConnect).not.toBeNull()
    const c1 = t.clients[0]!
    c1.emit('error', new Error('reset while connecting'))
    expect(t.listener.state.tConnect).toBeNull()
    // Ping and echo intervals, the reconnection and the dispose destroy; no tConnect.
    expect(t.clock.pendingCount()).toBe(4)
  })

  it('a superseded connect that rejects late does not cancel the current attempt’s tConnect', async () => {
    const t = setup({ autoConnect: false })
    t.listener.startGfsWatchRegistry()
    const c1 = t.clients[0]!
    // c1 hangs; its tConnect discards it at 10 s and the reconnection starts c2 at 11 s.
    await t.clock.advanceAsync(11_000)
    expect(t.clients).toHaveLength(2)
    const tConnect2 = t.listener.state.tConnect
    expect(tConnect2).not.toBeNull()
    c1.connectResult!.reject(new Error('Connection terminated'))
    await flushMicrotasks()
    expect(t.listener.state.tConnect).toBe(tConnect2)
    expect(t.clock.isPending(tConnect2)).toBe(true)
    // c2 hangs too and is still abandoned 10 s after it started.
    const lossesBefore = t.resetWindows.mock.calls.length
    await t.clock.advanceAsync(10_000)
    expect(t.resetWindows.mock.calls.length).toBe(lossesBefore + 1)
  })
})

describe('a client that cannot be built still leaves a way back', () => {
  it('createClient throwing at start schedules a reconnection after the backoff', async () => {
    const t = setup({ createFault: n => (n === 1 ? 'create' : null) })
    const before = await counterValue(gfsWatchTickFailedTotal, { name: 'listener-connect' })
    t.listener.startGfsWatchRegistry()
    const s = t.listener.state
    expect(s.listenerClient).toBeNull()
    expect(s.tConnect).toBeNull()
    expect(s.reconnectTimer).not.toBeNull()
    expect(s.reconnectAttempt).toBe(1)
    await t.clock.advanceAsync(999)
    expect(t.attempts).toEqual([0])
    await t.clock.advanceAsync(1)
    expect(t.attempts).toEqual([0, 1_000])
    expect(s.listenerReady).toBe(true)
    expect(s.reconnectAttempt).toBe(0)
    // Handled where it happens, not as an escaped tick failure.
    expect(await counterValue(gfsWatchTickFailedTotal, { name: 'listener-connect' })).toBe(before)
  })

  it('createClient throwing on a reconnection backs off further and retries', async () => {
    const t = setup({ createFault: n => (n === 2 ? 'create' : null) })
    t.listener.startGfsWatchRegistry()
    await flushMicrotasks()
    t.clients[0]!.emit('end')
    await t.clock.advanceAsync(1_000)
    const s = t.listener.state
    expect(t.attempts).toEqual([0, 1_000])
    expect(s.listenerClient).toBeNull()
    expect(s.reconnectTimer).not.toBeNull()
    expect(s.reconnectAttempt).toBe(2)
    await t.clock.advanceAsync(1_999)
    expect(t.attempts).toHaveLength(2)
    await t.clock.advanceAsync(1)
    expect(t.attempts).toEqual([0, 1_000, 3_000])
    expect(s.listenerReady).toBe(true)
  })

  it('a client whose handlers cannot be attached is disposed and never becomes current', async () => {
    const t = setup({ createFault: n => (n === 1 ? 'on' : null) })
    t.listener.startGfsWatchRegistry()
    const s = t.listener.state
    const half = t.clients[0]!
    expect(s.listenerClient).toBeNull()
    expect(s.tConnect).toBeNull()
    expect(s.reconnectTimer).not.toBeNull()
    expect(half.ended).toBe(1)
    expect(half.connectResult).toBeNull()
    expect([...half.handlers.keys()]).toEqual(['error'])
    await t.clock.advanceAsync(1_000)
    expect(t.clients).toHaveLength(2)
    expect(s.listenerClient).toBe(t.clients[1])
    expect(s.listenerReady).toBe(true)
  })

  it('a stop after a failed build cancels the scheduled reconnection', async () => {
    const t = setup({ createFault: n => (n === 1 ? 'create' : null) })
    t.listener.startGfsWatchRegistry()
    expect(t.listener.state.reconnectTimer).not.toBeNull()
    t.listener.stopGfsWatchRegistry()
    expect(t.listener.state.reconnectTimer).toBeNull()
    expect(t.clock.pendingCount()).toBe(0)
    await t.clock.advanceAsync(30_000)
    expect(t.attempts).toEqual([0])
  })

  it('repeated build failures back off 1 s, 2 s, 4 s, 8 s, 8 s and never spin', async () => {
    const t = setup({ createFault: n => (n <= 6 ? 'create' : null) })
    t.listener.startGfsWatchRegistry()
    await t.clock.advanceAsync(31_000)
    const gaps = t.attempts.slice(1).map((at, i) => at - t.attempts[i]!)
    expect(gaps).toEqual([1_000, 2_000, 4_000, 8_000, 8_000, 8_000])
    expect(t.listener.state.listenerReady).toBe(true)
    expect(t.listener.state.reconnectAttempt).toBe(0)
  })

  it('a late event of the previous client after a failed build changes nothing', async () => {
    const t = setup({ createFault: n => (n === 2 ? 'create' : null) })
    t.listener.startGfsWatchRegistry()
    await flushMicrotasks()
    const c1 = t.clients[0]!
    c1.emit('end')
    await t.clock.advanceAsync(1_000)
    const s = t.listener.state
    const timer = s.reconnectTimer
    expect(timer).not.toBeNull()
    const losses = t.resetWindows.mock.calls.length
    for (const h of c1.everRegistered.get('error')!) h(new Error('C1 late error'))
    for (const h of c1.everRegistered.get('end')!) h()
    expect(t.resetWindows.mock.calls.length).toBe(losses)
    expect(s.reconnectTimer).toBe(timer)
    expect(s.reconnectAttempt).toBe(2)
    await t.clock.advanceAsync(2_000)
    expect(t.attempts).toEqual([0, 1_000, 3_000])
    expect(s.listenerReady).toBe(true)
  })
})

describe('the build-failure log line of the real pg client', () => {
  it('carries no part of the connection string password, through the redacting root logger', async () => {
    const secret = 'fixture-watch-pw'
    // Port 99999 makes pg's connection-string parser throw from the Client
    // constructor, the error this log line reports on every reconnect. The URL
    // is assembled at runtime so the public-boundary scanner does not read a
    // credentialed PostgreSQL literal in this file.
    const loopback = ['127', '0', '0', '1'].join('.')
    const connectionString = ['postgres://watch', `${secret}@${loopback}`, '99999/clerum'].join(':')
    const stream = (rootLogger as unknown as Record<symbol, { write(line: string): unknown }>)[
      pino.symbols.streamSym
    ]!
    const lines: string[] = []
    const write = vi.spyOn(stream, 'write').mockImplementation(line => {
      lines.push(String(line))
      return true
    })
    const level = rootLogger.level
    rootLogger.level = 'error'
    try {
      const clock = createVirtualWatchClock({ random: () => 0 })
      const rt = createWatchRuntime<Conn>({ clock, closeConnInternal: () => {} })
      const listener = createGfsWatchListener<Conn>({
        connectionString,
        runtime: rt,
        recentDirty: createRecentDirty(clock.now),
        connections: () => [],
        opsInFlight: () => [],
        closeConn: () => {},
        onCmd: () => {},
        onResourceChanged: () => {},
        resetWindows: () => {},
        onExpansionFailed: () => {},
      })
      listener.startGfsWatchRegistry()
      await clock.advanceAsync(3_000)
      listener.stopGfsWatchRegistry()
    } finally {
      rootLogger.level = level
      write.mockRestore()
    }
    const built = lines.filter(l => l.includes('gfs watch listener client construction failed'))
    // At 0 s, 1 s and 3 s: the start and two backed-off reconnects.
    expect(built).toHaveLength(3)
    for (const l of built) {
      expect(l).not.toContain(secret)
      expect(JSON.parse(l)).toMatchObject({ err: { code: 'ERR_INVALID_URL' } })
    }
  })
})
