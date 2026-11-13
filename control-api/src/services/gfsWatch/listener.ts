import { randomBytes } from 'node:crypto'
import { Client, type ClientConfig, type Notification } from 'pg'
import {
  gfsWatchDispatchFailedTotal,
  gfsWatchNotifyInvalidTotal,
} from '../../observability/metrics.js'
import {
  type AuthzKey,
  GFS_AUTHZ_CHANGED_CHANNEL,
  GFS_RESOURCE_CHANGED_CHANNEL,
  GFS_WATCH_CMD_CHANNEL,
  GFS_WATCH_PING_CHANNEL,
  type ResourceChanged,
  type WatchCmd,
  type WatchPing,
  isRevocationChannel,
  parseAuthzKey,
  parsePing,
  parseResourceChanged,
  parseWatchCmd,
} from './notifySchemas.js'
import type { RecentDirty } from './recentDirty.js'
import { FAILED, type GuardedConn, type TimerHandle, type WatchRuntime } from './runtime.js'

/**
 * 16 random bytes as 32 lowercase hex, once per process. It is the producer of
 * the ping schema: any other form (a uuid, for instance) never parses, so the
 * listener would never see its own echo and would declare itself lost forever.
 */
export const GFS_WATCH_INSTANCE_ID = randomBytes(16).toString('hex')

export const GFS_WATCH_LISTEN_CHANNELS = Object.freeze([
  GFS_RESOURCE_CHANGED_CHANNEL,
  GFS_AUTHZ_CHANGED_CHANNEL,
  GFS_WATCH_PING_CHANNEL,
  GFS_WATCH_CMD_CHANNEL,
] as const)

export const LISTENER_CLIENT_OPTIONS = Object.freeze({
  keepAlive: true,
  keepAliveInitialDelayMillis: 10_000,
  connectionTimeoutMillis: 5_000,
  query_timeout: 5_000,
} satisfies ClientConfig)

const PING_EVERY_MS = 10_000
const ECHO_CHECK_EVERY_MS = 5_000
// Last echo at t0 and a check that sees > 20 s at the latest at t0 + 25 s:
// a half-open LISTEN is detected within 30 s whatever the cause.
const ECHO_LOST_AFTER_MS = 20_000
const CONNECT_DEADLINE_MS = 10_000
const RECONNECT_BASE_MS = 1_000
const RECONNECT_CAP_MS = 8_000
const DISPOSE_DESTROY_AFTER_MS = 1_000
const MASS_CLOSE_SPREAD_PER_CONN_MS = 40
const MASS_CLOSE_SPREAD_CAP_MS = 10_000

/** Reopens of a mass close are spread over this window, 40 ms per victim up to 10 s. */
export function massCloseSpreadMs(victims: number): number {
  return Math.min(MASS_CLOSE_SPREAD_CAP_MS, MASS_CLOSE_SPREAD_PER_CONN_MS * victims)
}

/** The part of a pg Client the listener drives. */
export type ListenerClient = {
  on(event: 'error', listener: (err: Error) => void): unknown
  on(event: 'end', listener: () => void): unknown
  on(event: 'notification', listener: (n: Notification) => void): unknown
  removeAllListeners(): unknown
  connect(): Promise<unknown>
  query(text: string, values?: unknown[]): Promise<unknown>
  end(): Promise<void>
  connection?: { stream?: { destroy(): void } }
}

export type ListenerLostReason = 'listener_lost' | 'server_shutdown'

/** A watch connection as the listener sees it: what it closes and what it marks. */
export type ListenerConn = GuardedConn & {
  readonly op: { dirtyOverflow: boolean } | null
}

export type GfsWatchListenerDeps<C extends ListenerConn> = {
  connectionString: string
  runtime: WatchRuntime<C>
  recentDirty: RecentDirty
  /** Every admitted connection; the listener closes a copy of it. */
  connections: () => Iterable<C>
  /** Connections with an op in flight. */
  opsInFlight: () => Iterable<C>
  /** Must not throw; each call already runs inside `guarded`. */
  closeConn: (conn: C, reason: ListenerLostReason, opts: { spreadMs: number }) => void
  onCmd: (cmd: WatchCmd) => void
  onResourceChanged: (change: ResourceChanged) => void
  onAuthzChanged: (key: AuthzKey) => void
  /** Drops the authorization/session windows of the registry; both process transitions call it. */
  resetWindows: () => void
  /**
   * Fail-closed reaction to an unreadable revocation hint, after the
   * in-flight decisions were marked suspect: hold every user and reopen their
   * connections so they are reauthorized against gfsc.
   */
  onExpansionFailed: () => void
  createClient?: (config: ClientConfig) => ListenerClient
  instanceId?: string
}

export type GfsWatchListenerState = {
  readonly instanceId: string
  listenerClient: ListenerClient | null
  listenerReady: boolean
  listenerEpoch: number
  lastEchoAt: number
  shuttingDown: boolean
  reconnectAttempt: number
  reconnectTimer: TimerHandle | null
  tConnect: TimerHandle | null
  pingInterval: TimerHandle | null
  echoInterval: TimerHandle | null
  pingCounter: number
}

type Validated =
  | { ok: true; channel: typeof GFS_WATCH_PING_CHANNEL; value: WatchPing }
  | { ok: true; channel: typeof GFS_WATCH_CMD_CHANNEL; value: WatchCmd }
  | { ok: true; channel: typeof GFS_RESOURCE_CHANGED_CHANNEL; value: ResourceChanged }
  | { ok: true; channel: typeof GFS_AUTHZ_CHANGED_CHANNEL; value: AuthzKey }
  | { ok: false }

function validate(channel: string, payload: unknown): Validated {
  switch (channel) {
    case GFS_WATCH_PING_CHANNEL: {
      const value = parsePing(payload)
      return value ? { ok: true, channel, value } : { ok: false }
    }
    case GFS_WATCH_CMD_CHANNEL: {
      const value = parseWatchCmd(payload)
      return value ? { ok: true, channel, value } : { ok: false }
    }
    case GFS_RESOURCE_CHANGED_CHANNEL: {
      const value = parseResourceChanged(payload)
      return value ? { ok: true, channel, value } : { ok: false }
    }
    case GFS_AUTHZ_CHANGED_CHANNEL: {
      const value = parseAuthzKey(payload)
      return value ? { ok: true, channel, value } : { ok: false }
    }
    default:
      return { ok: false }
  }
}

const noop = (): void => {}

/**
 * The process-wide LISTEN connection of the GFS watch and its liveness proof.
 *
 * The LISTEN runs on a dedicated pg.Client outside every pool. Liveness is an
 * echo: the listener NOTIFYs `gfs_watch_ping` through its own connection and
 * expects to receive it back. No echo within 20 s means the listener is lost,
 * whatever the cause (half-open TCP, a frozen proxy, a dropped LISTEN), and a
 * saturated pool can neither fake a loss nor hide one.
 */
export function createGfsWatchListener<C extends ListenerConn>(deps: GfsWatchListenerDeps<C>) {
  const rt = deps.runtime
  const createClient =
    deps.createClient ?? ((config: ClientConfig) => new Client(config) as unknown as ListenerClient)
  const s: GfsWatchListenerState = {
    instanceId: deps.instanceId ?? GFS_WATCH_INSTANCE_ID,
    listenerClient: null,
    listenerReady: false,
    listenerEpoch: 0,
    lastEchoAt: 0,
    shuttingDown: false,
    reconnectAttempt: 0,
    reconnectTimer: null,
    tConnect: null,
    pingInterval: null,
    echoInterval: null,
    pingCounter: 0,
  }

  async function connectListener(): Promise<void> {
    const e = ++s.listenerEpoch
    const c = createClient({ connectionString: deps.connectionString, ...LISTENER_CLIENT_OPTIONS })
    s.listenerClient = c
    // Permanent until the client is disposed: pg emits 'error' after an
    // unexpected end, and an EventEmitter with no 'error' listener throws.
    c.on('error', () => rt.guardedTick('listener-error', () => onListenerLost(c, e)))
    c.on('end', () => rt.guardedTick('listener-end', () => onListenerLost(c, e)))
    c.on('notification', n => {
      if (s.listenerClient === c) dispatch(n, e)
    })
    // Safety net over connectionTimeoutMillis, which does not cover the LISTEN.
    s.tConnect = rt.timer(CONNECT_DEADLINE_MS, () =>
      rt.guardedTick('listener-connect', () => {
        s.tConnect = null
        onListenerLost(c, e)
      })
    )
    const r = await rt.total(async () => {
      await c.connect()
      await c.query(GFS_WATCH_LISTEN_CHANNELS.map(channel => `LISTEN ${channel}`).join('; '))
    }, 'listener-connect')
    // After the identity gate: once this client is no longer current, tConnect
    // belongs to a newer attempt (this one's was cancelled when it was lost).
    if (s.listenerClient !== c) return
    rt.cancel(s, 'tConnect')
    if (r === FAILED) {
      onListenerLost(c, e)
      return
    }
    s.lastEchoAt = rt.now()
    s.listenerReady = true
    s.reconnectAttempt = 0
  }

  /** Synchronous and idempotent: a late event of an older client does nothing. */
  function onListenerLost(c: ListenerClient | null, e: number): void {
    if (c === null || s.listenerClient !== c || s.listenerEpoch !== e) return
    // Own state first, so a throwing close below cannot leave the listener
    // half-discarded or without its reconnection.
    s.listenerReady = false
    s.listenerClient = null
    rt.cancel(s, 'tConnect')
    disposeListener(c)
    if (!s.shuttingDown) {
      s.reconnectAttempt += 1
      // 1 s → 8 s cap plus up to 20 % jitter: the next attempt is ≤ 9.6 s away.
      const d = rt.jitter(
        Math.min(RECONNECT_CAP_MS, RECONNECT_BASE_MS * 2 ** (s.reconnectAttempt - 1))
      )
      s.reconnectTimer = rt.timer(d, () =>
        rt.guardedTick('listener-reconnect', () => {
          s.reconnectTimer = null
          return connectListener()
        })
      )
    }
    rt.log.warn({ epoch: e, reconnectAttempt: s.reconnectAttempt }, 'gfs watch listener lost')
    // Every connection closes below, so what the windows hold describes
    // connections that will no longer exist. Guarded: a failure here must not
    // keep the connections open over a dead LISTEN.
    rt.guardedTick('listener-reset-windows', deps.resetWindows)
    closeAllOnCopy('listener_lost')
  }

  function closeAllOnCopy(reason: ListenerLostReason): void {
    const victims = [...deps.connections()]
    const spreadMs = massCloseSpreadMs(victims.length)
    for (const conn of victims) rt.guarded(conn, () => deps.closeConn(conn, reason, { spreadMs }))
  }

  /** Synchronous; never throws. */
  function disposeListener(c: ListenerClient): void {
    try {
      c.removeAllListeners()
      c.on('error', noop)
      // end() sets _ending, so pg no longer turns the close into an 'error',
      // and it destroys the socket itself when the connection is not
      // queryable or a query is active.
      void c.end().catch(noop)
      // Half-open with no active query: end() waits for a FIN that never
      // comes, so the socket is destroyed by hand.
      const destroyTimer = rt.timer(DISPOSE_DESTROY_AFTER_MS, () => {
        try {
          c.connection?.stream?.destroy()
        } catch {
          // already destroyed
        }
      })
      destroyTimer.unref?.()
    } catch (err) {
      rt.log.error({ err }, 'gfs watch listener dispose failed')
    }
  }

  function pingTick(): void {
    if (!s.listenerReady || s.listenerClient === null) return
    s.pingCounter += 1
    // A failed ping does nothing by itself: there will simply be no echo.
    void s.listenerClient
      .query(`SELECT pg_notify('${GFS_WATCH_PING_CHANNEL}', $1)`, [
        `${s.instanceId}:${s.listenerEpoch}:${s.pingCounter}`,
      ])
      .catch(noop)
  }

  function echoCheckTick(): void {
    if (s.listenerReady && rt.now() - s.lastEchoAt > ECHO_LOST_AFTER_MS) {
      onListenerLost(s.listenerClient, s.listenerEpoch)
    }
  }

  /** Only this process's echo, on the current client, counts. */
  function onPing(p: WatchPing, e: number): void {
    if (p.instanceId === s.instanceId && p.epoch === e && e === s.listenerEpoch) {
      s.lastEchoAt = rt.now()
    }
  }

  /**
   * A revocation hint the registry could not read may be exactly the
   * revocation, so it fails closed: no decision in flight, nor of an op born
   * in the next window, is trusted, and the registry's fail-closed hook
   * reopens the affected connections.
   */
  function onInvalidRevocationHint(channel: string): void {
    if (s.shuttingDown) return
    rt.logSampledError(
      `invalid-revocation:${channel}`,
      { channel },
      'invalid NOTIFY on a revocation channel'
    )
    deps.recentDirty.markOverflow()
    for (const conn of deps.opsInFlight()) if (conn.op) conn.op.dirtyOverflow = true
    rt.guardedTick('invalid-revocation-hint', deps.onExpansionFailed)
  }

  /**
   * Runs inside pg's socket 'data' handler and never throws. NOTIFY needs no
   * privilege, so every payload is validated against its channel's schema
   * before touching state. On a revocation channel, both an invalid payload
   * and a handler that throws fail closed.
   */
  function dispatch(n: Notification, e: number): void {
    try {
      const v = validate(n.channel, n.payload)
      if (!v.ok) {
        gfsWatchNotifyInvalidTotal.inc({ channel: n.channel })
        if (isRevocationChannel(n.channel)) onInvalidRevocationHint(n.channel)
        return
      }
      switch (v.channel) {
        case GFS_WATCH_PING_CHANNEL:
          return onPing(v.value, e)
        case GFS_WATCH_CMD_CHANNEL:
          return deps.onCmd(v.value)
        case GFS_RESOURCE_CHANGED_CHANNEL:
          return deps.onResourceChanged(v.value)
        case GFS_AUTHZ_CHANGED_CHANNEL:
          return deps.onAuthzChanged(v.value)
      }
    } catch (err) {
      rt.log.error({ err, channel: n.channel }, 'gfs watch dispatch failed')
      gfsWatchDispatchFailedTotal.inc({ channel: n.channel })
      // A revocation whose handler threw was not applied; dropping it would
      // fail open, so it is treated like one that could not be read.
      if (isRevocationChannel(n.channel)) {
        rt.guardedTick('revocation-dispatch-failed', () => onInvalidRevocationHint(n.channel))
      }
    }
  }

  /** Once, at process start. */
  function startGfsWatchRegistry(): void {
    s.pingInterval = rt.interval(PING_EVERY_MS, () => rt.guardedTick('ping', pingTick))
    s.echoInterval = rt.interval(ECHO_CHECK_EVERY_MS, () =>
      rt.guardedTick('echo-check', echoCheckTick)
    )
    rt.guardedTick('listener-connect', connectListener)
  }

  /** Shutdown step; synchronous. */
  function stopGfsWatchRegistry(): void {
    s.shuttingDown = true
    rt.cancel(s, 'pingInterval', 'echoInterval', 'tConnect', 'reconnectTimer')
    rt.guardedTick('listener-reset-windows', deps.resetWindows)
    s.listenerReady = false
    const c = s.listenerClient
    s.listenerClient = null
    if (c) disposeListener(c)
    closeAllOnCopy('server_shutdown')
  }

  return {
    state: s as Readonly<GfsWatchListenerState>,
    startGfsWatchRegistry,
    stopGfsWatchRegistry,
    connectListener,
    onListenerLost,
    disposeListener,
    dispatch,
    pingTick,
    echoCheckTick,
    onPing,
    onInvalidRevocationHint,
  }
}

export type GfsWatchListener<C extends ListenerConn> = ReturnType<typeof createGfsWatchListener<C>>
