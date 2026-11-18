/**
 * A user who reaches an allowlisting Context only through an active team (no
 * `user_agents` rows) mints and completes user-scope OAuth consent; a deleted
 * team membership and a retired user are denied with 403, never a 500.
 *
 * Runs the real app against a real Postgres. The provider token endpoint
 * (`globalThis.fetch`) is the only stub.
 *
 *   CONTROL_API_REAL_PG_ADMIN_URL=postgres://<user>:<pass>@<host>:5432/postgres npm test -- \
 *     test/oauth.userConsent.teamAgents.realPostgres.integration.test.ts
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import request from 'supertest'
import { createApp } from '../src/app.js'
import { config } from '../src/config.js'
import type { DbClient } from '../src/db.js'
import { initDb } from '../src/db.js'
import { setTeamAgents } from '../src/services/directory/agentAccess.js'
import { softDeleteMember } from '../src/services/directory/membership.js'
import { createTeamForUser } from '../src/services/directory/teams.js'
import { retireDesktopUser } from '../src/services/directory/users.js'
import {
  seedActiveMember,
  seedAgentHost,
  seedAllowlistedContext,
  seedControlAdmin,
} from './fixtures/contextAllowlist.js'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'
import { MockGateway } from './mockGateway.js'

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
    withTransaction: (work: Parameters<typeof actual.withTransaction>[0]) =>
      actual.withTransaction(work, current()),
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

const NS = config.mcpServersNamespace
const SERVER = 'team-drive'
const CLIENT = 'team-drive-client'
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'

describeRealPostgres('user-scope consent via team agents (real Postgres)', () => {
  const database = `control_api_team_consent_${randomUUID().replace(/-/g, '')}`
  let adminPool: Pool
  let dbPool: Pool
  let db: DbClient
  let operator: string
  let gateway: MockGateway
  let app: ReturnType<typeof createApp>
  let fetchSpy: ReturnType<typeof vi.spyOn>
  const originalBrokerEnabled = config.mcpOauthBrokerEnabled

  beforeAll(async () => {
    if (!adminUrl) throw new Error('CONTROL_API_REAL_PG_ADMIN_URL is required')
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`CREATE DATABASE "${database.replace(/"/g, '""')}"`)
    dbPool = new Pool({ connectionString: databaseUrl(adminUrl, database) })
    await initDb({ connect: () => dbPool.connect() })
    db = { query: (text, values) => dbPool.query(text, values) }
    testDb.pool = dbPool
    config.mcpOauthBrokerEnabled = true
    operator = await seedControlAdmin(db)
  })

  afterAll(async () => {
    try {
      config.mcpOauthBrokerEnabled = originalBrokerEnabled
      testDb.pool = undefined
      if (dbPool) await endPoolAndWaitForClients(dbPool)
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
    gateway = new MockGateway(NS)
    app = createApp(gateway as never)
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      if (String(input) !== TOKEN_ENDPOINT) throw new Error(`unexpected fetch ${String(input)}`)
      return Response.json({ access_token: 'AT-1', expires_in: 3600 })
    })
    await gateway.createResource(
      'mcpservers',
      {
        metadata: { name: SERVER },
        spec: {
          enabled: true,
          image: 'example/team-drive:1',
          transport: { type: 'streamableHttp', url: 'https://team.example.com/mcp' },
          auth: { type: 'oauth' },
          oauth: {
            id: CLIENT,
            provider: 'google',
            clientIdRef: { name: 'google-creds', key: 'client-id' },
            clientSecretRef: { name: 'google-creds', key: 'client-secret' },
            scopes: ['https://www.googleapis.com/auth/drive.readonly'],
            grantScope: 'user',
          },
        },
      },
      NS
    )
    gateway.seedSecret('google-creds', NS, {
      data: {
        'client-id': Buffer.from('GOOGLE_CLIENT_ID').toString('base64'),
        'client-secret': Buffer.from('GOOGLE_CLIENT_SECRET').toString('base64'),
      },
    })
    await seedAllowlistedContext(gateway, 'c1', [SERVER], config.contextsNamespace)
    await seedAgentHost(gateway, 'h1', 'c1')
  })

  afterEach(() => {
    fetchSpy.mockRestore()
  })

  const mint = (userId: string) =>
    request(app)
      .post('/api/v1/internal/mcp-oauth/authorize-url')
      .set('Authorization', 'Bearer dev-rpc-proxy-token')
      .set('x-service-token', 'rpc-proxy')
      .send({ mcpServerName: SERVER, userId })

  const callback = (state: string) =>
    request(app)
      .get(`/api/v1/oauth-callback/${CLIENT}`)
      .query({ code: `CODE-${randomUUID()}`, state })
      .then(res => res)

  async function teamOnlyUser(): Promise<{ user: string; teamId: string }> {
    const user = await seedActiveMember(db, {})
    const team = await createTeamForUser(user, `team-${randomUUID()}`)
    await setTeamAgents(team.id, ['h1'], operator)
    return { user, teamId: team.id }
  }

  async function userGrants(user: string): Promise<number> {
    const grants = await db.query(
      `SELECT count(*)::int AS n FROM oauth_grants
        WHERE recipe_name = $1 AND user_id = $2 AND grant_kind = 'user'`,
      [SERVER, user]
    )
    return (grants.rows[0] as { n: number }).n
  }

  const stateOf = (res: { body: { authorizeUrl: string } }) =>
    new URL(res.body.authorizeUrl).searchParams.get('state') ?? ''

  it('a user who reaches the allowlisting Context only through an active team mints and completes consent; one user grant', async () => {
    const { user } = await teamOnlyUser()
    const res = await mint(user)
    expect(res.status, res.text).toBe(200)
    const done = await callback(stateOf(res))
    expect(done.status, done.text).toBe(200)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(await userGrants(user)).toBe(1)
  })

  it('a deleted team membership denies the mint and a callback minted before the deletion; no exchange, no grant', async () => {
    const { user, teamId } = await teamOnlyUser()
    const minted = await mint(user)
    expect(minted.status, minted.text).toBe(200)
    const state = stateOf(minted)
    await softDeleteMember(teamId, user, operator)
    expect((await mint(user)).status).toBe(403)
    const done = await callback(state)
    expect(done.status, done.text).toBe(403)
    expect(done.body).toEqual({ error: 'context_membership_denied' })
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(await userGrants(user)).toBe(0)
  })

  it('a retired user with live team rows is denied, not a 500', async () => {
    const { user } = await teamOnlyUser()
    await retireDesktopUser(
      { kind: 'control_admin', controlAdminId: operator },
      user,
      'team-agent consent real-pg',
      `retire-${user}`,
      null,
      { retainWithoutLinkHistory: true }
    )
    const res = await mint(user)
    expect(res.status, res.text).toBe(403)
    expect(res.body).toEqual({ error: 'context_membership_denied' })
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(await userGrants(user)).toBe(0)
  })

  it("another user's team rows do not open the Context for a user with no rows", async () => {
    const { user: other } = await teamOnlyUser()
    const user = await seedActiveMember(db, {})
    const denied = await mint(user)
    expect(denied.status, denied.text).toBe(403)
    expect(denied.body).toEqual({ error: 'context_membership_denied' })
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(await userGrants(user)).toBe(0)
    const allowed = await mint(other)
    expect(allowed.status, allowed.text).toBe(200)
  })
})
