/**
 * The token broker's fast path, the rpc-proxy grant gate and the grant-existence
 * sweep all read grants through the store reader fence with a key built from the
 * CR they just read. An unsealed (legacy) grant — written by a baked-lane pod
 * without install identity — must not count for a same-name reinstall on another
 * lane that kept the `oauth.id`: no still-valid access token handed to mcp-host
 * for the new server's URL, no "connected" verdict from the gate or the sweep.
 * A baked reinstall of the same provider keeps being served.
 *
 * `POST /mcp-oauth/user-token` runs through the real app against a real Postgres
 * (the store fence is SQL, so it cannot be asserted on a mocked pool).
 *
 * Real producers (T1): see `fixtures/legacyOAuthGrant.ts`.
 *
 *   CONTROL_API_REAL_PG_ADMIN_URL=postgres://<user>:<pass>@<host>:5432 npm test -- \
 *     test/routes.mcpOauth.legacyGrantLaneFence.realPostgres.integration.test.ts
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import request from 'supertest'
import { createApp } from '../src/app.js'
import { config } from '../src/config.js'
import type { DbClient } from '../src/db.js'
import { initDb } from '../src/db.js'
import { deriveOAuthEncryptionKey } from '../src/oauth/encryption.js'
import { resolveBatchGrantExistence } from '../src/routes/mcpOauth.js'
import { resolveInvocableMcpServersForContexts } from '../src/services/access/mcpInvocable.js'
import { issueMcpHostControlJwt } from '../src/utils/auth/mcpHostJwtToken.js'
import {
  CONTEXT,
  NS,
  type OAuthSpec,
  bakedOAuth,
  genericOAuth,
  installServer,
  legacyConsent,
  reinstallServer,
} from './fixtures/legacyOAuthGrant.js'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'
import { MockGateway } from './mockGateway.js'

// The broker reads grants through the app's shared pool; point it at this suite's
// database.
const testDb = vi.hoisted(() => ({ pool: undefined as import('pg').Pool | undefined }))

vi.mock('../src/db.js', async () => {
  const actual = await vi.importActual<typeof import('../src/db.js')>('../src/db.js')
  const current = () => {
    if (!testDb.pool) throw new Error('test pool not initialised')
    return testDb.pool
  }
  return {
    ...actual,
    pool: {
      query: (text: string, values?: unknown[]) => current().query(text, values),
      connect: () => current().connect(),
    },
  }
})

vi.mock('../src/services/notificationEmitter.js', () => ({
  emitNotification: vi.fn().mockResolvedValue(undefined),
  enqueueApprovalRequestedNotification: vi.fn().mockResolvedValue(undefined),
  enqueueApprovalUpdatedNotification: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../src/services/rateLimiterService.js', () => ({
  checkAndIncrement: vi.fn().mockResolvedValue({
    allowed: true,
    backendAvailable: true,
    remaining: 59,
    resetMs: Date.now() + 60_000,
    windowStartMs: Date.now(),
    count: 1,
  }),
}))

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip

function databaseUrl(baseUrl: string, database: string): string {
  const url = new URL(baseUrl)
  url.pathname = `/${database}`
  return url.toString()
}

const KEY = deriveOAuthEncryptionKey(config.oauthEncryptionKey)
const LEGACY_AT = 'LEGACY-AT-google'
const USER = 'alice'
type Flavor = 'user' | 'context'

function controlToken(): string {
  return issueMcpHostControlJwt('mcp-host', 'standalone', ['mcp-host/standalone'], {
    scopes: ['oauth:user-token'],
  }).token
}

describeRealPostgres('legacy grants seen by the broker, gate and sweep (real Postgres)', () => {
  const database = `control_api_legacy_lane_routes_${randomUUID().replace(/-/g, '')}`
  let adminPool: Pool
  let dbPool: Pool
  let db: DbClient
  const originalBrokerEnabled = config.mcpOauthBrokerEnabled

  beforeAll(async () => {
    if (!adminUrl) throw new Error('CONTROL_API_REAL_PG_ADMIN_URL is required')
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`CREATE DATABASE "${database.replace(/"/g, '""')}"`)
    dbPool = new Pool({ connectionString: databaseUrl(adminUrl, database) })
    await initDb({ connect: () => dbPool.connect() })
    db = { query: (text, values) => dbPool.query(text, values) }
    testDb.pool = dbPool
  })

  afterAll(async () => {
    try {
      testDb.pool = undefined
      await endPoolAndWaitForClients(dbPool)
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
    await dbPool.query('DELETE FROM oauth_grants')
    config.mcpOauthBrokerEnabled = true
  })

  afterEach(() => {
    config.mcpOauthBrokerEnabled = originalBrokerEnabled
  })

  /**
   * A baked google server consented by a pre-identity pod (access token still
   * valid), then reinstalled under the same name with `oauth`.
   */
  async function legacyThenReinstall(flavor: Flavor, oauth: OAuthSpec) {
    const name = `legacy-route-${randomUUID().slice(0, 8)}`
    const gateway = new MockGateway(NS)
    await installServer(gateway, name, bakedOAuth('google', flavor))
    await legacyConsent(db, KEY, gateway, name, USER, {
      accessToken: LEGACY_AT,
      refreshToken: 'LEGACY-RT-google',
      expiresIn: 3600,
    })
    await reinstallServer(gateway, name, oauth)
    await gateway.createResource(
      'contexts',
      { metadata: { name: CONTEXT }, spec: { contextId: CONTEXT, mcpServers: [name] } },
      NS
    )
    return { name, gateway }
  }

  const userToken = (gateway: MockGateway, name: string) =>
    request(createApp(gateway as never))
      .post('/api/v1/mcp-oauth/user-token')
      .set('Authorization', `Bearer ${controlToken()}`)
      .send({ mcpServerName: name, userId: USER })

  const invocable = async (gateway: MockGateway) =>
    (await resolveInvocableMcpServersForContexts(gateway, NS, [CONTEXT], USER, db)).map(s => s.name)

  const sweep = (gateway: MockGateway, name: string) =>
    resolveBatchGrantExistence({ db, gateway, mcpServersNamespace: NS }, [
      { mcpServerName: name, userId: USER },
    ])

  describe.each<Flavor>(['user', 'context'])('%s flavor', flavor => {
    it('user-token: a generic reinstall gets 404 no_grant, not the legacy access token', async () => {
      const { name, gateway } = await legacyThenReinstall(flavor, genericOAuth(flavor))

      const res = await userToken(gateway, name)

      expect(res.status).toBe(404)
      expect(res.body).toEqual({ error: 'no_grant' })
      expect(JSON.stringify(res.body)).not.toContain(LEGACY_AT)
    })

    it('user-token: a same-provider baked reinstall is still served the legacy token', async () => {
      const { name, gateway } = await legacyThenReinstall(flavor, bakedOAuth('google', flavor))

      const res = await userToken(gateway, name)

      expect(res.status).toBe(200)
      expect(res.body.token).toBe(LEGACY_AT)
    })

    it('gate and sweep: a generic reinstall is not connected by the legacy row', async () => {
      const { name, gateway } = await legacyThenReinstall(flavor, genericOAuth(flavor))

      expect(await invocable(gateway)).toEqual([])
      expect(await sweep(gateway, name)).toEqual([
        { mcpServerName: name, userId: USER, exists: false },
      ])
    })

    it('gate and sweep: a same-provider baked reinstall stays connected', async () => {
      const { name, gateway } = await legacyThenReinstall(flavor, bakedOAuth('google', flavor))

      expect(await invocable(gateway)).toEqual([name])
      expect(await sweep(gateway, name)).toEqual([
        { mcpServerName: name, userId: USER, exists: true },
      ])
    })
  })
})
