import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { type IncomingHttpHeaders, type Server, request as httpRequest } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Pool } from 'pg'
import request from 'supertest'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'
import './realPostgres.requirement.ts'

// The per-user entity-change stream is retired in favour of
// /external/gfs/watch; the operator stream Control UI uses stays. Both are
// observed through the production app on real PostgreSQL: the internal
// service gate, the real admin session verifier and the real feed checkpoint.

function databaseUrl(baseUrl: string, database: string): string {
  const url = new URL(baseUrl)
  url.pathname = `/${database}`
  return url.toString()
}

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

type StreamHead = {
  status: number
  headers: IncomingHttpHeaders
  firstFrame: Record<string, unknown> | null
  body: string
}

/** GET a stream; resolves on its first NDJSON frame (then aborts) or on the end of a plain reply. */
function readFirstFrame(url: string, headers: Record<string, string>): Promise<StreamHead> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: 'GET', headers })
    req.on('response', res => {
      res.setEncoding('utf8')
      let buf = ''
      const streaming = String(res.headers['content-type']).startsWith('application/x-ndjson')
      res.on('data', (chunk: string) => {
        buf += chunk
        const nl = buf.indexOf('\n')
        if (streaming && nl >= 0) {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            firstFrame: JSON.parse(buf.slice(0, nl)) as Record<string, unknown>,
            body: '',
          })
          req.destroy()
        }
      })
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, firstFrame: null, body: buf })
      )
    })
    req.on('error', err => {
      if (!req.destroyed) reject(err)
    })
    req.end()
  })
}

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip

describeRealPostgres('entity-change stream retirement (real PostgreSQL)', () => {
  const database = `control_api_ec_retirement_${randomBytes(6).toString('hex')}`
  const previousConnectionString = process.env.CONTROL_API_PG_CONNECTION_STRING
  let adminPool: Pool
  let corePool: Pool
  let limiterPool: Pool
  let server: Server
  let baseUrl: string
  let internalHeaders: Record<string, string>
  let mod: {
    stream: typeof import('../src/routes/entityChangeStream.js')
    adminToken: typeof import('../src/utils/auth/adminAuthToken.js')
    cookies: typeof import('../src/utils/auth/sessionCookies.js')
    issuance: typeof import('../src/services/auth/externalSessionIssuance.js')
    entityChanges: typeof import('../src/services/entityChangeService.js')
  }

  beforeAll(async () => {
    const connectionString = databaseUrl(adminUrl!, database)
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`CREATE DATABASE ${quoteIdent(database)}`)
    process.env.CONTROL_API_PG_CONNECTION_STRING = connectionString

    const dbMod = await import('../src/db.js')
    corePool = dbMod.pool as unknown as Pool
    corePool.on('error', () => {})
    limiterPool = dbMod.rateLimitPool as unknown as Pool
    limiterPool.on('error', () => {})
    const migratePool = new Pool({ connectionString })
    await dbMod.initDb({ connect: () => migratePool.connect() })
    await endPoolAndWaitForClients(migratePool)

    const { createApp } = await import('../src/app.js')
    const { config } = await import('../src/config.js')
    const { MockGateway } = await import('./mockGateway.js')
    mod = {
      stream: await import('../src/routes/entityChangeStream.js'),
      adminToken: await import('../src/utils/auth/adminAuthToken.js'),
      cookies: await import('../src/utils/auth/sessionCookies.js'),
      issuance: await import('../src/services/auth/externalSessionIssuance.js'),
      entityChanges: await import('../src/services/entityChangeService.js'),
    }
    const internalToken = config.internalServiceTokens['external-rest-api']
    if (!internalToken) throw new Error('config has no external-rest-api internal service token')
    internalHeaders = {
      authorization: `Bearer ${internalToken}`,
      'x-service-token': 'external-rest-api',
    }
    server = createApp(new MockGateway() as never).listen(0, '127.0.0.1')
    await once(server, 'listening')
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  }, 60_000)

  afterAll(async () => {
    try {
      mod?.stream.closeActiveEntityChangeStreams()
      mod?.entityChanges.stopEntityChangeDispatcher()
      if (server) {
        server.closeAllConnections()
        await new Promise<void>(resolve => server.close(() => resolve()))
      }
      await endPoolAndWaitForClients(corePool).catch(() => {})
      await endPoolAndWaitForClients(limiterPool).catch(() => {})
      if (previousConnectionString === undefined)
        delete process.env.CONTROL_API_PG_CONNECTION_STRING
      else process.env.CONTROL_API_PG_CONNECTION_STRING = previousConnectionString
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

  async function externalUserSession(): Promise<string> {
    const user = await corePool.query<{ id: string }>(
      `INSERT INTO users (id, email, name) VALUES (gen_random_uuid(), $1, 'retirement')
       RETURNING id`,
      [`${randomBytes(6).toString('hex')}@example.test`]
    )
    const userId = user.rows[0]!.id
    const issued = await mod.issuance.issueExternalUserSession(
      {
        contract: 'v1',
        userId,
        email: `${userId}@example.test`,
        teamId: null,
        role: 'member',
        authenticationMethods: ['pwd'],
      } as never,
      {
        policy: {
          issueV1: true,
          acceptV1: true,
          issueV2: false,
          acceptV2: false,
        } as import('../src/services/access/userAccessPolicy.js').EffectiveUserAccessPolicy,
      }
    )
    return issued.token
  }

  it('T-S17: GET /api/v1/external/entity-changes/stream answers the 404 of an unrouted path', async () => {
    const userToken = await externalUserSession()
    const external = (path: string, withSession: boolean) =>
      request(server)
        .get(path)
        .set(internalHeaders)
        .set(withSession ? { 'x-user-session-token': userToken } : {})
        .timeout({ deadline: 5_000 })

    for (const withSession of [false, true]) {
      const retired = await external('/api/v1/external/entity-changes/stream', withSession)
      expect(retired.status).toBe(404)
      expect(retired.body).toEqual({ error: 'Not Found' })
    }

    // Witness: the same caller passes the internal gate and reaches the
    // replacement, which answers in its own error shape.
    const watch = await external('/api/v1/external/gfs/watch', false)
    expect(watch.status).toBe(401)
    expect(watch.headers['x-watch-error']).toBe('session_invalid')
  })

  it('T-S17: the operator stream still opens for a live admin session and sends its first frame', async () => {
    const admin = await corePool.query<{ id: string; session_version: number }>(
      `SELECT id, session_version FROM control_admin_users WHERE status = 'active' LIMIT 1`
    )
    const row = admin.rows[0]
    if (!row) throw new Error('initDb seeded no active control admin')
    const token = mod.adminToken.signAdminToken(row.id, 'admin', Number(row.session_version))
    const url = `${baseUrl}/api/v1/gfs/entity-changes/stream`

    const unauthenticated = await readFirstFrame(url, {})
    expect(unauthenticated.status).toBe(401)

    const opened = await readFirstFrame(url, {
      cookie: `${mod.cookies.CONTROL_UI_ADMIN_SESSION_COOKIE}=${token}`,
    })
    expect(opened.status).toBe(200)
    expect(opened.headers['content-type']).toMatch(/^application\/x-ndjson/)
    // No cursor: the first frame tells the operator to load everything.
    expect(opened.firstFrame).toMatchObject({
      schemaVersion: 1,
      type: 'resync_required',
      scopes: ['gfs', 'authorization'],
    })
  })
})
