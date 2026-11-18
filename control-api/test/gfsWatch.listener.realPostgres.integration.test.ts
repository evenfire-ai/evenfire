import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { Client, Pool, type PoolClient } from 'pg'
import { initDb } from '../src/db.js'
import { DbSeedResourceStore, seedRootDirectories } from '../src/gfs/seedResources.js'
import {
  gfsWatchNotifyInvalidTotal,
  gfsWatchTotalFailedTotal,
} from '../src/observability/metrics.js'
import { normUid, toRid32 } from '../src/services/gfsWatch/keys.js'
import {
  GFS_WATCH_INSTANCE_ID,
  type ListenerConn,
  createGfsWatchListener,
} from '../src/services/gfsWatch/listener.js'
import {
  type ResourceChanged,
  type WatchCmd,
  parsePing,
  serializeWatchCmd,
} from '../src/services/gfsWatch/notifySchemas.js'
import { createRecentDirty } from '../src/services/gfsWatch/recentDirty.js'
import { createWatchRuntime } from '../src/services/gfsWatch/runtime.js'
import { createGfsWatchPool } from '../src/services/gfsWatch/watchPool.js'
import { createScaledWatchClock } from './helpers/gfsWatchClock.js'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'
import { type TcpProxy, startTcpProxy } from './helpers/tcpProxy.js'
import './realPostgres.requirement.ts'

// Real pg@8 clients against a real Postgres, through a TCP proxy the test
// controls. Watch delays run ten times faster than wall time (a 20 s echo
// threshold elapses in 2 s); pg's own connect/query timeouts keep their real
// duration. Every NOTIFY comes from a real producer: the listener's own
// pingTick, the gfs_resource_changed trigger, or pg_notify for payloads
// that are invalid on purpose.

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip
const SCALE = 10

function databaseUrl(baseUrl: string, database: string, port?: number): string {
  const url = new URL(baseUrl)
  url.pathname = `/${database}`
  if (port !== undefined) {
    url.hostname = '127.0.0.1'
    url.port = String(port)
  }
  return url.toString()
}

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<number | null> {
  const start = Date.now()
  while (Date.now() - start <= timeoutMs) {
    if (predicate()) return Date.now() - start
    await sleep(20)
  }
  return null
}

const LISTEN_BACKEND = `query LIKE 'LISTEN gfs_resource_changed%' OR query LIKE '%gfs_watch_ping%'`

type ListenerSocket = { connection?: { stream?: { destroyed?: boolean } } }
const socketDestroyed = (c: unknown) => (c as ListenerSocket).connection?.stream?.destroyed === true

async function counterValue(
  metric: { get(): Promise<{ values: { labels: Record<string, unknown>; value: number }[] }> },
  labels: Record<string, string>
): Promise<number> {
  const { values } = await metric.get()
  return values
    .filter(v => Object.entries(labels).every(([k, x]) => v.labels[k] === x))
    .reduce((a, v) => a + v.value, 0)
}

type Conn = ListenerConn & { op: { dirtyOverflow: boolean } | null }

describeRealPostgres('GFS watch listener against real Postgres', () => {
  const database = `control_api_gfs_watch_listener_${randomBytes(6).toString('hex')}`
  let adminPool: Pool
  let pool: Pool
  let proxy: TcpProxy
  let proxiedUrl = ''
  const stops: (() => Promise<void> | void)[] = []
  let uncaught: unknown[] = []
  const onUncaught = (e: unknown) => uncaught.push(e)

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`CREATE DATABASE ${quoteIdent(database)}`)
    pool = new Pool({ connectionString: databaseUrl(adminUrl!, database) })
    await initDb({ connect: () => pool.connect() })
    proxy = await startTcpProxy(
      Number(new URL(adminUrl!).port || 5432),
      new URL(adminUrl!).hostname
    )
    proxiedUrl = databaseUrl(adminUrl!, database, proxy.port)
  })

  beforeEach(() => {
    uncaught = []
    process.on('uncaughtException', onUncaught)
    process.on('unhandledRejection', onUncaught)
    proxy.setAccept('pass')
    proxy.setTraffic('pass')
  })

  afterEach(async () => {
    for (const stop of stops.splice(0).reverse()) await stop()
    proxy.destroyAll()
    // No LISTEN backend of this test may survive into the next one.
    let listenBackends = -1
    for (let i = 0; i < 100; i += 1) {
      const r = await adminPool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1 AND (${LISTEN_BACKEND})`,
        [database]
      )
      listenBackends = r.rows[0]!.n
      if (listenBackends === 0) break
      await sleep(50)
    }
    expect(listenBackends).toBe(0)
    process.off('uncaughtException', onUncaught)
    process.off('unhandledRejection', onUncaught)
    expect(uncaught).toEqual([])
  })

  afterAll(async () => {
    try {
      await proxy?.close()
      if (pool) await endPoolAndWaitForClients(pool)
      if (adminPool) {
        await adminPool.query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
            WHERE datname = $1 AND pid <> pg_backend_pid()`,
          [database]
        )
        await adminPool.query(`DROP DATABASE IF EXISTS ${quoteIdent(database)}`)
      }
    } finally {
      await adminPool?.end()
    }
  })

  function startListener({
    connectionString = proxiedUrl,
    conns = [] as Conn[],
    instanceId,
    scale = SCALE,
  }: { connectionString?: string; conns?: Conn[]; instanceId?: string; scale?: number } = {}) {
    const clock = createScaledWatchClock(scale)
    const live = new Set(conns)
    const closed: { connId: string; reason: string }[] = []
    const cmds: WatchCmd[] = []
    const changes: ResourceChanged[] = []
    let losses = 0
    let expansionFailures = 0
    const recentDirty = createRecentDirty(clock.now)
    const rt = createWatchRuntime<Conn>({
      clock,
      closeConnInternal: c => {
        closed.push({ connId: c.connId, reason: 'internal' })
        live.delete(c)
      },
    })
    const listener = createGfsWatchListener<Conn>({
      connectionString,
      runtime: rt,
      recentDirty,
      connections: () => live,
      opsInFlight: () => [...live].filter(c => c.op !== null),
      closeConn: (c, reason) => {
        closed.push({ connId: c.connId, reason })
        live.delete(c)
      },
      onCmd: cmd => cmds.push(cmd),
      onResourceChanged: change => changes.push(change),
      resetWindows: () => {
        if (!listener.state.shuttingDown) losses += 1
      },
      onExpansionFailed: () => (expansionFailures += 1),
      instanceId,
    })
    listener.startGfsWatchRegistry()
    stops.push(() => listener.stopGfsWatchRegistry())
    return {
      listener,
      clock,
      closed,
      cmds,
      changes,
      recentDirty,
      live,
      losses: () => losses,
      expansionFailures: () => expansionFailures,
      /** Scaled watch milliseconds → real milliseconds. */
      real: (watchMs: number) => watchMs / scale,
    }
  }

  async function sniffer(channel: string) {
    const client = new Client({ connectionString: databaseUrl(adminUrl!, database) })
    client.on('error', () => {})
    await client.connect()
    const payloads: string[] = []
    client.on('notification', n => payloads.push(n.payload ?? ''))
    await client.query(`LISTEN ${channel}`)
    stops.push(() => client.end().catch(() => {}))
    return payloads
  }

  const conn = (id: string, op = false): Conn => ({
    connId: id,
    op: op ? { dirtyOverflow: false } : null,
  })

  it('T-SB89: the real instance id echoes; 3 pings are 3 accepted echoes and 2 minutes pass without a loss', async () => {
    const pings = await sniffer('gfs_watch_ping')
    const t = startListener({ conns: [conn('a')] })
    expect(await waitFor(() => t.listener.state.listenerReady, 5_000)).not.toBeNull()
    const echoes: number[] = []
    let last = t.listener.state.lastEchoAt
    const sampler = setInterval(() => {
      if (t.listener.state.lastEchoAt !== last) {
        last = t.listener.state.lastEchoAt
        echoes.push(last)
      }
    }, 10)
    stops.push(() => clearInterval(sampler))
    await sleep(t.real(120_000))
    clearInterval(sampler)
    expect(t.losses()).toBe(0)
    expect(t.closed).toEqual([])
    const parsed = pings.map(p => parsePing(p))
    expect(parsed.length).toBeGreaterThanOrEqual(10)
    expect(parsed.slice(0, 3)).toEqual([
      { instanceId: GFS_WATCH_INSTANCE_ID, epoch: 1, n: 1 },
      { instanceId: GFS_WATCH_INSTANCE_ID, epoch: 1, n: 2 },
      { instanceId: GFS_WATCH_INSTANCE_ID, epoch: 1, n: 3 },
    ])
    expect(echoes.length).toBeGreaterThanOrEqual(parsed.length - 1)
  }, 30_000)

  it('T-SB89 control: a uuid instance id never echoes and the listener is lost within 25 s', async () => {
    const t = startListener({ instanceId: '6f1c4f5e-1b2a-4c3d-9e8f-001122334455' })
    expect(await waitFor(() => t.listener.state.listenerReady, 5_000)).not.toBeNull()
    const lostIn = await waitFor(() => t.losses() >= 1, t.real(30_000))
    expect(lostIn).not.toBeNull()
    expect(lostIn!).toBeGreaterThan(t.real(20_000) - 200)
  }, 20_000)

  it('T-SB49 (a): dropped NOTIFYs → one loss, the process lives, reconnects and keeps its new echo', async () => {
    const t = startListener({ conns: [conn('a'), conn('b')] })
    expect(await waitFor(() => t.listener.state.listenerReady, 5_000)).not.toBeNull()
    proxy.setTraffic('dropNotify', { existingOnly: true })
    const lostIn = await waitFor(() => t.losses() >= 1, t.real(30_000) + 500)
    expect(lostIn).not.toBeNull()
    expect(lostIn!).toBeLessThanOrEqual(t.real(30_000))
    expect(t.closed.map(c => c.reason)).toEqual(['listener_lost', 'listener_lost'])
    expect(
      await waitFor(() => t.listener.state.listenerReady, t.real(10_000) + 2_000)
    ).not.toBeNull()
    expect(t.listener.state.listenerEpoch).toBe(2)
    await sleep(t.real(40_000))
    expect(t.losses()).toBe(1)
    expect(proxy.stats.droppedNotifications).toBeGreaterThan(0)
  }, 30_000)

  it('T-SB49 (b): a TCP RST on the established connection → one loss and a reconnection', async () => {
    const t = startListener({ conns: [conn('a')] })
    expect(await waitFor(() => t.listener.state.listenerReady, 5_000)).not.toBeNull()
    proxy.resetAll()
    expect(await waitFor(() => t.losses() >= 1, 2_000)).not.toBeNull()
    expect(t.closed).toEqual([{ connId: 'a', reason: 'listener_lost' }])
    expect(
      await waitFor(() => t.listener.state.listenerReady, t.real(10_000) + 2_000)
    ).not.toBeNull()
    await sleep(t.real(30_000))
    expect(t.losses()).toBe(1)
  }, 20_000)

  it('T-SB49 (c) / I8: a connect the proxy accepts and never answers is abandoned by tConnect (10 s scaled, before pg 5 s real timeout) and retried', async () => {
    proxy.setAccept('blackhole')
    const t = startListener()
    const lostIn = await waitFor(() => t.losses() >= 1, 10_000)
    expect(lostIn).not.toBeNull()
    expect(t.listener.state.listenerReady).toBe(false)
    proxy.setAccept('pass')
    expect(await waitFor(() => t.listener.state.listenerReady, 12_000)).not.toBeNull()
  }, 30_000)

  it('T-SB49 (c) / I8: on real time pg connectionTimeoutMillis wins: the connect fails as transient, the listener is lost and retried', async () => {
    proxy.setAccept('blackhole')
    const transientBefore = await counterValue(gfsWatchTotalFailedTotal, {
      label: 'listener-connect',
      kind: 'transient',
    })
    const t = startListener({ scale: 1 })
    const start = Date.now()
    expect(await waitFor(() => t.losses() >= 1, 9_000)).not.toBeNull()
    const lostAfter = Date.now() - start
    // pg's 5 s connect timeout, well before the 10 s tConnect.
    expect(lostAfter).toBeGreaterThanOrEqual(4_500)
    expect(lostAfter).toBeLessThan(9_000)
    expect(
      await counterValue(gfsWatchTotalFailedTotal, { label: 'listener-connect', kind: 'transient' })
    ).toBe(transientBefore + 1)
    proxy.setAccept('pass')
    expect(await waitFor(() => t.listener.state.listenerReady, 12_000)).not.toBeNull()
  }, 30_000)

  it('T-SB49 (d): half-open with an active query → end() destroys the socket at once', async () => {
    const t = startListener()
    expect(await waitFor(() => t.listener.state.listenerReady, 5_000)).not.toBeNull()
    const c1 = t.listener.state.listenerClient
    proxy.setTraffic('frozen', { existingOnly: true })
    // The next ping is a query that never completes: it stays active.
    await sleep(t.real(11_000))
    expect(socketDestroyed(c1)).toBe(false)
    expect(await waitFor(() => t.losses() >= 1, t.real(30_000))).not.toBeNull()
    // Before the 1 s destroy timer could have fired.
    expect(await waitFor(() => socketDestroyed(c1), t.real(1_000) / 2)).not.toBeNull()
    expect(
      await waitFor(() => t.listener.state.listenerReady, t.real(10_000) + 2_000)
    ).not.toBeNull()
  }, 20_000)

  it('T-SB49 (d): half-open without an active query → the 1 s destroy closes the socket', async () => {
    const t = startListener()
    expect(await waitFor(() => t.listener.state.listenerReady, 5_000)).not.toBeNull()
    proxy.setTraffic('frozen', { existingOnly: true })
    const c1 = t.listener.state.listenerClient
    t.listener.onListenerLost(c1, t.listener.state.listenerEpoch)
    // end() sends a Terminate and a FIN the frozen proxy swallows: only the destroy closes it.
    await sleep(t.real(1_000) / 2)
    expect(socketDestroyed(c1)).toBe(false)
    expect(await waitFor(() => socketDestroyed(c1), t.real(1_000) + 500)).not.toBeNull()
  }, 20_000)

  it('T-SB25 / T-S20: a saturated watch pool causes no loss; a frozen LISTEN is lost within 30 s', async () => {
    const watchPool = createGfsWatchPool(databaseUrl(adminUrl!, database))
    stops.push(() => endPoolAndWaitForClients(watchPool))
    const held: PoolClient[] = []
    for (let i = 0; i < 4; i += 1) held.push(await watchPool.connect())
    stops.push(() => held.forEach(c => c.release()))
    // Waiters keep the pool saturated; each one times out after 2 s and is re-queued.
    let saturating = true
    const saturate = async () => {
      while (saturating) await watchPool.query('SELECT 1').catch(() => {})
    }
    const loops = [saturate(), saturate(), saturate()]
    stops.push(async () => {
      saturating = false
      await Promise.all(loops)
    })
    const t = startListener({ conns: [conn('a')] })
    expect(await waitFor(() => t.listener.state.listenerReady, 5_000)).not.toBeNull()
    await sleep(t.real(60_000))
    expect(watchPool.waitingCount).toBeGreaterThan(0)
    expect(t.losses()).toBe(0)
    proxy.setTraffic('frozen', { existingOnly: true })
    const lostIn = await waitFor(() => t.losses() >= 1, t.real(30_000) + 500)
    expect(lostIn).not.toBeNull()
    expect(lostIn!).toBeLessThanOrEqual(t.real(30_000))
    expect(t.closed).toEqual([{ connId: 'a', reason: 'listener_lost' }])
  }, 30_000)

  it('T-S6 / T-S21: a terminated LISTEN backend closes every connection; not ready until the re-LISTEN', async () => {
    const t = startListener({
      connectionString: databaseUrl(adminUrl!, database),
      conns: [conn('a'), conn('b'), conn('c')],
    })
    expect(await waitFor(() => t.listener.state.listenerReady, 5_000)).not.toBeNull()
    const killed = await adminPool.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE datname = $1 AND (${LISTEN_BACKEND})`,
      [database]
    )
    expect(killed.rowCount).toBe(1)
    expect(await waitFor(() => t.losses() >= 1, 2_000)).not.toBeNull()
    expect(t.listener.state.listenerReady).toBe(false)
    expect(t.closed.map(c => `${c.connId}:${c.reason}`).sort()).toEqual([
      'a:listener_lost',
      'b:listener_lost',
      'c:listener_lost',
    ])
    expect(
      await waitFor(() => t.listener.state.listenerReady, t.real(10_000) + 2_000)
    ).not.toBeNull()
    const listening = await adminPool.query(
      `SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = $1 AND (${LISTEN_BACKEND})`,
      [database]
    )
    expect(listening.rows[0]!.n).toBe(1)
  }, 20_000)

  it('T-SB50: invalid commands are counted and dropped, a valid one for an unknown connection reaches onCmd, the replica lives', async () => {
    const t = startListener({ connectionString: databaseUrl(adminUrl!, database) })
    expect(await waitFor(() => t.listener.state.listenerReady, 5_000)).not.toBeNull()
    const before = (await gfsWatchNotifyInvalidTotal.get()).values
      .filter(v => v.labels.channel === 'gfs_watch_cmd')
      .reduce((a, v) => a + v.value, 0)
    const user = normUid('6f1c4f5e-1b2a-4c3d-9e8f-001122334455')!
    const valid = serializeWatchCmd({
      c: 'b'.repeat(32),
      s: 1,
      u: user,
      g: 1,
      r: user,
      keys: new Set(),
    })
    // The invalid ones are the real producer's output with only `k` broken.
    for (const k of [{ main: 'x' }, null]) {
      const broken = { ...JSON.parse(valid), c: 'a'.repeat(32), k }
      await pool.query(`SELECT pg_notify('gfs_watch_cmd', $1)`, [JSON.stringify(broken)])
    }
    await pool.query(`SELECT pg_notify('gfs_watch_cmd', $1)`, [valid])
    expect(await waitFor(() => t.cmds.length >= 1, 2_000)).not.toBeNull()
    await sleep(200)
    const after = (await gfsWatchNotifyInvalidTotal.get()).values
      .filter(v => v.labels.channel === 'gfs_watch_cmd')
      .reduce((a, v) => a + v.value, 0)
    expect(after - before).toBe(2)
    expect(t.cmds.map(c => c.c)).toEqual(['b'.repeat(32)])
    expect(t.listener.state.listenerReady).toBe(true)
    expect(t.losses()).toBe(0)
  }, 20_000)

  it('T-SB50: the real trigger reaches onResourceChanged normalized; an invalid resource payload fails closed', async () => {
    const withOp = conn('a', true)
    const t = startListener({ connectionString: databaseUrl(adminUrl!, database), conns: [withOp] })
    expect(await waitFor(() => t.listener.state.listenerReady, 5_000)).not.toBeNull()
    const client = await pool.connect()
    let rootId: string
    try {
      await client.query('BEGIN')
      const seeded = await seedRootDirectories(
        new DbSeedResourceStore(client),
        `watch-listener-${randomBytes(4).toString('hex')}`,
        ['/org']
      )
      await client.query('COMMIT')
      rootId = seeded.byPath['/org']!
    } finally {
      client.release()
    }
    expect(
      await waitFor(() => t.changes.some(c => c.rid32 === toRid32(rootId)), 2_000)
    ).not.toBeNull()
    const change = t.changes.find(c => c.rid32 === toRid32(rootId))!
    const row = await pool.query<{ parent: string | null }>(
      'SELECT parent_resource_id::text AS parent FROM gfs_resources WHERE resource_id = $1',
      [rootId]
    )
    expect(change).toMatchObject({
      op: 'i',
      oldParent: null,
      newParent: toRid32(row.rows[0]!.parent),
    })
    expect(withOp.op!.dirtyOverflow).toBe(false)
    expect(t.recentDirty.overflowed()).toBe(false)

    await pool.query(`SELECT pg_notify('gfs_resource_changed', $1)`, ['not,a,valid,payload'])
    expect(await waitFor(() => t.recentDirty.overflowed(), 2_000)).not.toBeNull()
    expect(withOp.op!.dirtyOverflow).toBe(true)
    expect(t.expansionFailures()).toBe(1)
    // A short-lived client: an idle pool backend whose last query names the
    // ping channel would read as a surviving LISTEN backend in afterEach.
    const once = new Client({ connectionString: databaseUrl(adminUrl!, database) })
    await once.connect()
    try {
      await once.query(`SELECT pg_notify('gfs_watch_ping', $1)`, ['not-a-ping'])
    } finally {
      await once.end()
    }
    await sleep(t.real(30_000))
    expect(t.losses()).toBe(0)
    expect(t.closed).toEqual([])
  }, 20_000)
})
