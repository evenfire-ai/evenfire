import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import jwt from 'jsonwebtoken'
import { randomBytes } from 'node:crypto'
import { Pool } from 'pg'
import request from 'supertest'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'

// Refresh rotation of the HCC lineage against the REAL revocation table
// (`workflow_revoked_refresh_jtis`): the route verifies the refresh, reads the
// Host, and only then consumes the jti. These cases pin what a mocked pool
// cannot show — the atomic INSERT ... ON CONFLICT under concurrency, that a
// transient Host error leaves no row behind, and the expires_at floor the
// expiry cron relies on. Refresh tokens come from the real producer
// (`issueMcpHostRefreshJwt`) and Hosts from MockGateway, which assigns the uid.
// Skipped without CONTROL_API_REAL_PG_ADMIN_URL.

const REISSUE_GRACE_SECONDS = 5 * 60

function jwtDecode(token: string): { jti: string } {
  return jwt.decode(token) as { jti: string }
}

function databaseUrl(baseUrl: string, database: string): string {
  const url = new URL(baseUrl)
  url.pathname = `/${database}`
  return url.toString()
}

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip

describeRealPostgres('mcp-host refresh rotation (real Postgres)', () => {
  const database = `control_api_mcp_host_renewal_${randomBytes(6).toString('hex')}`
  let connectionString = ''
  const previousPgEnv = process.env.CONTROL_API_PG_CONNECTION_STRING

  let adminPool: Pool
  let corePool: Pool
  let limiterPool: Pool
  // Loaded dynamically AFTER the env points the module pool at the test DB.
  let mod: {
    createApp: (gateway: unknown) => import('express').Express
    config: typeof import('../src/config.js').config
    jwt: typeof import('../src/utils/auth/mcpHostJwtToken.js')
    MockGateway: typeof import('./mockGateway.js').MockGateway
  }
  let gateway: InstanceType<typeof mod.MockGateway>
  let app: import('express').Express

  beforeAll(async () => {
    connectionString = databaseUrl(adminUrl!, database)
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`CREATE DATABASE "${database.replace(/"/g, '""')}"`)

    process.env.CONTROL_API_PG_CONNECTION_STRING = connectionString

    const dbMod = await import('../src/db.js')
    corePool = dbMod.pool as unknown as Pool
    corePool.on('error', () => {})
    limiterPool = dbMod.rateLimitPool as unknown as Pool
    limiterPool.on('error', () => {})
    const migratePool = new Pool({ connectionString })
    await dbMod.initDb({ connect: () => migratePool.connect() })
    await endPoolAndWaitForClients(migratePool)

    const appMod = await import('../src/app.js')
    const configMod = await import('../src/config.js')
    const jwtMod = await import('../src/utils/auth/mcpHostJwtToken.js')
    const { MockGateway } = await import('./mockGateway.js')
    mod = {
      createApp: appMod.createApp as never,
      config: configMod.config,
      jwt: jwtMod,
      MockGateway,
    }
  }, 60_000)

  afterAll(async () => {
    try {
      if (previousPgEnv === undefined) delete process.env.CONTROL_API_PG_CONNECTION_STRING
      else process.env.CONTROL_API_PG_CONNECTION_STRING = previousPgEnv
      await endPoolAndWaitForClients(corePool).catch(() => {})
      await endPoolAndWaitForClients(limiterPool).catch(() => {})
      if (adminPool) {
        await adminPool.query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
          WHERE datname = $1 AND pid <> pg_backend_pid()`,
          [database]
        )
        await adminPool.query(`DROP DATABASE IF EXISTS "${database.replace(/"/g, '""')}"`)
      }
    } finally {
      await adminPool?.end()
    }
  })

  beforeEach(async () => {
    await corePool.query('DELETE FROM workflow_revoked_refresh_jtis')
    await corePool.query('DELETE FROM rate_limit_buckets')
    gateway = new mod.MockGateway('mcp-server')
    app = mod.createApp(gateway)
  })

  async function seedHost(name: string): Promise<string> {
    const created = (await gateway.createResource(
      'hosts',
      { metadata: { name }, spec: { host: name, contextRef: 'ctx-a', secretRef: `${name}-llm` } },
      mod.config.hostsNamespace
    )) as { metadata: { uid: string } }
    return created.metadata.uid
  }

  function issueHccRefresh(host: string, hostUid: string): string {
    return mod.jwt.issueMcpHostRefreshJwt(mod.config.hostsNamespace, 'standalone', [host], {
      workflowControlScopes: ['workflow:list', 'oauth:user-token'],
      hccCredential: { hostUid },
    }).token
  }

  function refresh(token: string) {
    return request(app)
      .post('/api/v1/workflow-auth/refresh')
      .set('Authorization', `Bearer ${token}`)
      .send()
  }

  async function revokedRow(jti: string): Promise<{ expires_at: Date } | undefined> {
    const res = await corePool.query<{ expires_at: Date }>(
      'SELECT expires_at FROM workflow_revoked_refresh_jtis WHERE jti = $1',
      [jti]
    )
    return res.rows[0]
  }

  it('F2g: concurrent refreshes of the same HCC jti yield exactly one 200', async () => {
    const hostUid = await seedHost('race-host')
    const token = issueHccRefresh('race-host', hostUid)

    // Hold every Host read until all requests have passed verify, so they all
    // reach the consume step together and only the table's atomic INSERT can
    // pick the winner (otherwise the first request finishes before the others
    // verify, and the revoked-jti cache answers instead).
    const racers = 3
    const realGet = gateway.getResource.bind(gateway)
    let arrived = 0
    let release!: () => void
    const allArrived = new Promise<void>(resolve => {
      release = resolve
    })
    vi.spyOn(gateway, 'getResource').mockImplementation(async (...args) => {
      arrived += 1
      if (arrived === racers) release()
      await allArrived
      return realGet(...args)
    })

    const results = await Promise.all(Array.from({ length: racers }, () => refresh(token)))
    const statuses = results.map(r => r.status).sort()

    expect(statuses).toEqual([200, 401, 401])
    const winner = results.find(r => r.status === 200)!
    expect(mod.jwt.verifyMcpHostControlJwt(winner.body.mcpHostControlToken)?.host_uid).toBe(hostUid)
  })

  it('F2d: a transient Host error answers 503 and leaves no revocation row; the retry succeeds once', async () => {
    const hostUid = await seedHost('blip-host')
    const token = issueHccRefresh('blip-host', hostUid)
    const { jti } = (await mod.jwt.verifyMcpHostRefreshJwt(token)) as { jti: string }
    gateway.failGetResource(
      'hosts',
      Object.assign(new Error('apiserver down'), { statusCode: 503 })
    )

    const failed = await refresh(token)
    expect(failed.status).toBe(503)
    expect(failed.body).toEqual({ error: 'host_state_unavailable' })
    expect(await revokedRow(jti)).toBeUndefined()

    const retried = await refresh(token)
    expect(retried.status).toBe(200)
    expect(await revokedRow(jti)).toBeDefined()

    expect((await refresh(token)).status).toBe(401)
  })

  it('F2c: a recreated Host (new uid) gets 401 and the refresh is not consumed', async () => {
    const oldUid = await seedHost('reborn-host')
    const token = issueHccRefresh('reborn-host', oldUid)
    const { jti } = (await mod.jwt.verifyMcpHostRefreshJwt(token)) as { jti: string }
    await gateway.deleteResource('hosts', 'reborn-host', mod.config.hostsNamespace)
    await seedHost('reborn-host')

    const res = await refresh(token)
    expect(res.status).toBe(401)
    expect(await revokedRow(jti)).toBeUndefined()
  })

  it('keeps the revocation row for the whole reissue window: expires_at = exp + reissue grace', async () => {
    const hostUid = await seedHost('floor-host')
    const token = issueHccRefresh('floor-host', hostUid)
    const claims = (await mod.jwt.verifyMcpHostRefreshJwt(token)) as { jti: string; exp: number }
    expect(claims.exp).toBeGreaterThan(Math.floor(Date.now() / 1000))

    const res = await refresh(token)
    expect(res.status).toBe(200)

    // Reissue accepts this refresh until exp + grace, so a row that the expiry
    // cron could delete at plain exp would let it be replayed after a restart.
    const row = await revokedRow(claims.jti)
    expect(row).toBeDefined()
    const storedSeconds = Math.floor(new Date(row!.expires_at).getTime() / 1000)
    expect(storedSeconds).toBe(claims.exp + REISSUE_GRACE_SECONDS)
  })

  it('floors expires_at at now + reissue grace for a refresh consumed on reissue after its exp', async () => {
    const hostUid = await seedHost('late-host')
    const realNow = Date.now()
    // Sign so that exp is 60 s in the past: still inside the reissue grace.
    const clock = vi
      .spyOn(Date, 'now')
      .mockReturnValue(realNow - (mod.config.mcpHostJwtRefreshTtlSec + 60) * 1000)
    let token: string
    try {
      token = issueHccRefresh('late-host', hostUid)
    } finally {
      clock.mockRestore()
    }
    const { jti } = jwtDecode(token)

    const res = await request(app)
      .post('/api/v1/workflow-auth/reissue')
      .set('Authorization', `Bearer ${token}`)
      .send({ host_ref: 'late-host' })
    expect(res.status).toBe(200)

    const row = await revokedRow(jti)
    expect(row).toBeDefined()
    const storedSeconds = Math.floor(new Date(row!.expires_at).getTime() / 1000)
    expect(storedSeconds).toBeGreaterThanOrEqual(
      Math.floor(realNow / 1000) + REISSUE_GRACE_SECONDS - 5
    )
  })
})
