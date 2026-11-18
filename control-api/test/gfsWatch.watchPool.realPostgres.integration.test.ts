import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { Pool } from 'pg'
import { isTransientInfraError } from '../src/services/gfsWatch/transientInfraError.js'
import { GFS_WATCH_POOL_OPTIONS, createGfsWatchPool } from '../src/services/gfsWatch/watchPool.js'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'
import { type TcpProxy, startTcpProxy } from './helpers/tcpProxy.js'
import './realPostgres.requirement.ts'

// The watch pool's deadlines are client-side, so they must hold when the
// server cannot answer at all: a frozen (half-open) connection and a connect
// the network accepts and never completes.

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip

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

async function rejectionOf(p: Promise<unknown>): Promise<Error> {
  try {
    await p
  } catch (error) {
    return error as Error
  }
  throw new Error('expected a rejection')
}

describeRealPostgres('GFS watch pool deadlines against real Postgres', () => {
  const database = `control_api_gfs_watch_pool_${randomBytes(6).toString('hex')}`
  let adminPool: Pool
  let proxy: TcpProxy
  const pools: Pool[] = []

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`CREATE DATABASE ${quoteIdent(database)}`)
    const upstream = new URL(adminUrl!)
    proxy = await startTcpProxy(Number(upstream.port || 5432), upstream.hostname)
  })

  beforeEach(() => {
    proxy.setAccept('pass')
    proxy.setTraffic('pass')
  })

  afterAll(async () => {
    try {
      proxy?.destroyAll()
      for (const p of pools) await endPoolAndWaitForClients(p).catch(() => {})
      await proxy?.close()
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

  function watchPool(): Pool {
    const p = createGfsWatchPool(databaseUrl(adminUrl!, database, proxy.port))
    pools.push(p)
    return p
  }

  it('carries the declared budget', () => {
    expect(GFS_WATCH_POOL_OPTIONS).toEqual({
      max: 4,
      connectionTimeoutMillis: 2_000,
      statement_timeout: 2_000,
      query_timeout: 2_000,
      keepAlive: true,
      keepAliveInitialDelayMillis: 10_000,
    })
  })

  it('I48: a query on a half-open connection rejects within 2 s as transient and the connection leaves the pool', async () => {
    const pool = watchPool()
    await pool.query('SELECT 1')
    expect(pool.totalCount).toBe(1)
    proxy.setTraffic('frozen', { existingOnly: true })
    const start = Date.now()
    const error = await rejectionOf(pool.query('SELECT 1'))
    const elapsed = Date.now() - start
    expect(error.message).toBe('Query read timeout')
    expect(isTransientInfraError(error)).toBe(true)
    expect(elapsed).toBeGreaterThanOrEqual(1_900)
    expect(elapsed).toBeLessThan(3_000)
    expect(pool.totalCount).toBe(0)
    proxy.destroyAll()
    proxy.setTraffic('pass')
    expect((await pool.query<{ n: number }>('SELECT 2 AS n')).rows[0]!.n).toBe(2)
  }, 15_000)

  it('I48: a connect the network accepts and never answers rejects within 2 s as transient', async () => {
    proxy.setAccept('blackhole')
    const pool = watchPool()
    const start = Date.now()
    const error = await rejectionOf(pool.query('SELECT 1'))
    const elapsed = Date.now() - start
    expect(isTransientInfraError(error)).toBe(true)
    expect(elapsed).toBeLessThan(3_000)
    proxy.destroyAll()
  }, 15_000)

  it('every session also carries the 2 s server-side statement deadline', async () => {
    const pool = watchPool()
    const r = await pool.query<{ statement_timeout: string }>('SHOW statement_timeout')
    expect(r.rows[0]!.statement_timeout).toBe('2s')
  }, 15_000)

  it('an idle client killed by the server is absorbed by the pool without crashing the process', async () => {
    const pool = watchPool()
    const uncaught: unknown[] = []
    const onUncaught = (e: unknown) => uncaught.push(e)
    process.on('uncaughtException', onUncaught)
    try {
      const client = await pool.connect()
      const pid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!
        .pid
      client.release()
      expect(pool.idleCount).toBe(1)
      await adminPool.query('SELECT pg_terminate_backend($1)', [pid])
      for (let i = 0; i < 100 && pool.totalCount > 0; i += 1)
        await new Promise(r => setTimeout(r, 20))
      expect(pool.totalCount).toBe(0)
      await new Promise(r => setTimeout(r, 100))
      expect(uncaught).toEqual([])
      expect((await pool.query<{ n: number }>('SELECT 3 AS n')).rows[0]!.n).toBe(3)
    } finally {
      process.off('uncaughtException', onUncaught)
    }
  }, 15_000)
})
