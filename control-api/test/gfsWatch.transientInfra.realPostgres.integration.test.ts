import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { Client, Pool } from 'pg'
import {
  externalSessionDatabaseFailure,
  runExternalSessionDatabaseOperation,
} from '../src/services/auth/sessionDatabaseFailure.js'
import { isTransientInfraError } from '../src/services/gfsWatch/transientInfraError.js'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'
import './realPostgres.requirement.ts'

// Every error below is produced by the real pg / pg-pool driver against a real
// server (or a real unreachable address); none is constructed by hand.

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip

function databaseUrl(baseUrl: string, database: string): string {
  const url = new URL(baseUrl)
  url.pathname = `/${database}`
  return url.toString()
}

function urlWithHost(baseUrl: string, host: string, port?: number): string {
  const url = new URL(baseUrl)
  url.hostname = host
  if (port !== undefined) url.port = String(port)
  return url.toString()
}

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('expected the driver call to reject')
}

describeRealPostgres('isTransientInfraError against the real pg driver', () => {
  const database = `control_api_gfs_watch_transient_${randomBytes(6).toString('hex')}`
  let connectionString = ''
  let adminPool: Pool
  const pools: Pool[] = []

  function pool(config: ConstructorParameters<typeof Pool>[0]): Pool {
    const created = new Pool(config)
    created.on('error', () => {})
    pools.push(created)
    return created
  }

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`CREATE DATABASE ${quoteIdent(database)}`)
    connectionString = databaseUrl(adminUrl!, database)
  })

  afterAll(async () => {
    try {
      for (const created of pools) await endPoolAndWaitForClients(created)
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

  it('classifies a backend terminated mid-query as transient', async () => {
    const client = new Client({ connectionString })
    client.on('error', () => {})
    await client.connect()
    try {
      const pid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!
        .pid
      const running = rejectionOf(client.query('SELECT pg_sleep(30)'))
      await adminPool.query('SELECT pg_terminate_backend($1)', [pid])
      const error = await running
      expect((error as { code?: string }).code).toBe('57P01')
      expect(isTransientInfraError(error)).toBe(true)

      // The same client after the loss: what a caller holding the reference sees.
      const after = await rejectionOf(client.query('SELECT 1'))
      expect((after as Error).constructor).toBe(Error)
      expect((after as Error).message).toBe('Connection terminated unexpectedly')
      expect(isTransientInfraError(after)).toBe(true)
    } finally {
      await client.end().catch(() => {})
    }
  })

  it('classifies a pg-pool connect timeout on a saturated pool as transient', async () => {
    const saturated = pool({ connectionString, max: 1, connectionTimeoutMillis: 50 })
    const held = await saturated.connect()
    try {
      const error = await rejectionOf(saturated.query('SELECT 1'))
      expect((error as Error).message).toBe('timeout exceeded when trying to connect')
      expect(isTransientInfraError(error)).toBe(true)
    } finally {
      held.release()
    }
  })

  it('classifies a client-side query timeout as transient', async () => {
    const bounded = pool({ connectionString, max: 1, query_timeout: 50 })
    const error = await rejectionOf(bounded.query('SELECT pg_sleep(2)'))
    expect((error as Error).message).toBe('Query read timeout')
    expect(isTransientInfraError(error)).toBe(true)
  })

  it('classifies a server statement timeout (SQLSTATE class 57) as transient', async () => {
    const bounded = pool({ connectionString, max: 1, statement_timeout: 50 })
    const error = await rejectionOf(bounded.query('SELECT pg_sleep(2)'))
    expect((error as { code?: string }).code).toBe('57014')
    expect(isTransientInfraError(error)).toBe(true)
  })

  it('classifies an unresolvable host as transient', async () => {
    const unresolvable = pool({
      connectionString: urlWithHost(adminUrl!, 'gfs-watch-transient.invalid'),
      max: 1,
      connectionTimeoutMillis: 5_000,
    })
    const error = await rejectionOf(unresolvable.query('SELECT 1'))
    expect(['ENOTFOUND', 'EAI_AGAIN']).toContain((error as { code?: string }).code)
    expect(isTransientInfraError(error)).toBe(true)
  })

  it('classifies a refused connection as transient', async () => {
    const refused = pool({
      connectionString: urlWithHost(adminUrl!, '127.0.0.1', 1),
      max: 1,
      connectionTimeoutMillis: 5_000,
    })
    const error = await rejectionOf(refused.query('SELECT 1'))
    expect((error as { code?: string }).code).toBe('ECONNREFUSED')
    expect(isTransientInfraError(error)).toBe(true)
  })

  it('classifies a connect timeout to an unanswering address as transient', async () => {
    // TEST-NET-1 (RFC 5737) is never routed, so the TCP handshake never completes.
    const silentUrl = urlWithHost(adminUrl!, '192.0.2.1', 5432)
    const viaPool = pool({ connectionString: silentUrl, max: 1, connectionTimeoutMillis: 100 })
    const poolError = await rejectionOf(viaPool.query('SELECT 1'))
    expect((poolError as Error).message).toMatch(
      /^(Connection terminated due to connection timeout|timeout expired)/
    )
    expect(isTransientInfraError(poolError)).toBe(true)

    const client = new Client({ connectionString: silentUrl, connectionTimeoutMillis: 100 })
    client.on('error', () => {})
    const clientError = await rejectionOf(client.connect())
    expect((clientError as Error).message).toMatch(/^(timeout expired|Connection terminated)/)
    expect(isTransientInfraError(clientError)).toBe(true)
  })

  it('classifies the session wrapper of a real database outage as transient', async () => {
    const refused = pool({
      connectionString: urlWithHost(adminUrl!, '127.0.0.1', 1),
      max: 1,
      connectionTimeoutMillis: 5_000,
    })
    const error = await rejectionOf(
      runExternalSessionDatabaseOperation(() => refused.query('SELECT 1'))
    )
    expect((error as Error).name).toBe('ExternalSessionBackendUnavailableError')
    expect(isTransientInfraError(error)).toBe(true)
  })

  it("keeps pg's plain-Error caller defect as a defect", async () => {
    const healthy = pool({ connectionString, max: 1 })
    const error = await rejectionOf(
      healthy.query('SELECT $1::int', 'not-an-array' as unknown as unknown[])
    )
    expect((error as Error).constructor).toBe(Error)
    expect((error as Error).message).toBe('Query values must be an array')
    expect(isTransientInfraError(error)).toBe(false)
    // Negative control: the session classifier treats every plain Error as an
    // outage, which is why the watch must not reuse it on raw driver errors.
    expect((externalSessionDatabaseFailure(error) as Error).name).toBe(
      'ExternalSessionBackendUnavailableError'
    )
  })

  it('keeps a statement error (SQLSTATE class 42) as a defect', async () => {
    const healthy = pool({ connectionString, max: 1 })
    const error = await rejectionOf(healthy.query('SELEC 1'))
    expect((error as { code?: string }).code).toBe('42601')
    expect(isTransientInfraError(error)).toBe(false)
  })
})
