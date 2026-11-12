/**
 * The broker's user rule (`POST /mcp-oauth/user-token`, per-user servers): a
 * token is served only to an active user who enters the calling Host, either
 * directly (`user_agents`) or through an active team membership whose team has
 * the Host (`team_agents`). Context membership alone does not count.
 *
 * Runs through the real app against a real Postgres: the rule is a join over
 * `users.lifecycle_state`, `team_members.status` and a UUID column, which a
 * mocked pool cannot exercise. Memberships are written by the production
 * writers (seedActiveMember → setUserAgents/setUserContexts, createTeamForUser,
 * setTeamAgents, softDeleteMember, retireDesktopUser); grants by
 * `upsertOAuthGrant`.
 *
 *   CONTROL_API_REAL_PG_ADMIN_URL=postgres://<user>:<pass>@<host>:5432 npm test -- \
 *     test/routes.mcpOauth.brokerBinding.realPostgres.integration.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fc from 'fast-check'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import request from 'supertest'
import { createApp } from '../src/app.js'
import { config } from '../src/config.js'
import type { DbClient } from '../src/db.js'
import { initDb } from '../src/db.js'
import { deriveOAuthEncryptionKey } from '../src/oauth/encryption.js'
import { upsertOAuthGrant } from '../src/oauth/store.js'
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
import { mintHccControlToken } from './fixtures/hccControlToken.js'
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

const KEY = deriveOAuthEncryptionKey(config.oauthEncryptionKey)
const NS = config.mcpServersNamespace
const HOST = 'agent-host'
// Another agent of the same Context: entering it must not open HOST.
const SIBLING_HOST = 'sibling-host'
const CONTEXT = 'ctx-binding'
const SERVER = 'gdrive'

describeRealPostgres('broker user rule: entry to the calling Host (real Postgres)', () => {
  const database = `control_api_broker_binding_${randomUUID().replace(/-/g, '')}`
  let adminPool: Pool
  let dbPool: Pool
  let db: DbClient
  let gateway: MockGateway
  let app: ReturnType<typeof createApp>
  let token: string
  let operator: string
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
    await gateway.createResource(
      'mcpservers',
      {
        metadata: { name: SERVER },
        spec: {
          contextRef: CONTEXT,
          auth: { type: 'oauth' },
          oauth: {
            id: 'google-drive',
            provider: 'google',
            clientIdRef: { name: 'google-creds', key: 'client-id' },
            clientSecretRef: { name: 'google-creds', key: 'client-secret' },
            grantScope: 'user',
          },
        },
      },
      NS
    )
    await seedAgentHost(gateway, HOST, CONTEXT)
    await seedAgentHost(gateway, SIBLING_HOST, CONTEXT)
    await seedAllowlistedContext(gateway, CONTEXT, [SERVER], config.contextsNamespace)
    token = await mintHccControlToken(app, gateway, HOST)
  })

  /** A connected grant for `userId`, sealed to the installed server. */
  async function connect(userId: string): Promise<void> {
    const cr = (await gateway.getResource('mcpservers', SERVER, NS)) as {
      metadata: { uid: string }
    }
    await upsertOAuthGrant(db, KEY, {
      grantKind: 'user',
      ownerKind: 'mcpserver',
      recipeNamespace: NS,
      recipeName: SERVER,
      userId,
      oauthClientId: 'google-drive',
      provider: 'google',
      accessToken: `AT-${userId}`,
      accessTokenExpiresInSec: 3600,
      crUid: cr.metadata.uid,
    })
  }

  const mint = (userId: string) =>
    request(app)
      .post('/api/v1/mcp-oauth/user-token')
      .set('Authorization', `Bearer ${token}`)
      .send({ mcpServerName: SERVER, userId })

  async function expectServed(userId: string): Promise<void> {
    const res = await mint(userId)
    expect(res.status).toBe(200)
    expect(res.body.token).toBe(`AT-${userId}`)
  }

  async function expectNoGrant(userId: string): Promise<void> {
    const res = await mint(userId)
    expect(res.status).toBe(404)
    expect(res.text).toBe('{"error":"no_grant"}')
  }

  async function teamWithHost(userId: string, agents: string[]): Promise<string> {
    const team = await createTeamForUser(userId, `team-${randomUUID()}`)
    await setTeamAgents(team.id, agents, operator)
    return team.id
  }

  async function retire(userId: string): Promise<void> {
    await retireDesktopUser(
      { kind: 'control_admin', controlAdminId: operator },
      userId,
      'broker binding real-pg',
      `retire-${userId}`,
      null,
      { retainWithoutLinkHistory: true }
    )
  }

  it('R7d: served when the user has the Host assigned directly (I-6)', async () => {
    const user = await seedActiveMember(db, { agents: [HOST] })
    await connect(user)
    await expectServed(user)
  })

  it('R7d: served when the user enters the Host through an active team (I-6)', async () => {
    const user = await seedActiveMember(db, {})
    await teamWithHost(user, [HOST])
    await connect(user)
    await expectServed(user)
  })

  it('R7: a user of another agent of the same Context gets no_grant (I-3)', async () => {
    const user = await seedActiveMember(db, { contexts: [CONTEXT], agents: [SIBLING_HOST] })
    await connect(user)
    await expectNoGrant(user)
  })

  it('R7a: Context membership alone (user_contexts) does not open the Host', async () => {
    const user = await seedActiveMember(db, { contexts: [CONTEXT] })
    await connect(user)
    await expectNoGrant(user)
  })

  it('R7b: a retired user gets no_grant although the grant remains', async () => {
    const user = await seedActiveMember(db, { agents: [HOST] })
    await connect(user)
    await retire(user)
    await expectNoGrant(user)
  })

  it('R7c: a deleted team membership no longer opens the Host', async () => {
    const user = await seedActiveMember(db, {})
    const teamId = await teamWithHost(user, [HOST])
    await connect(user)
    await softDeleteMember(teamId, user, operator)
    await expectNoGrant(user)
  })

  it('R7e: ids that are not canonical UUIDs are a definitive no_grant, never a 5xx', async () => {
    const user = await seedActiveMember(db, { agents: [HOST] })
    // The braced and hyphen-less spellings of an entitled user's id are valid
    // Postgres uuid input; each carries its own grant so only the format rule
    // can refuse them.
    const variants = [
      'U024BE7LH',
      'alice@example.test',
      'e2e-vitest-runtime',
      `{${user}}`,
      user.replace(/-/g, ''),
    ]
    for (const id of variants) {
      await connect(id)
      const res = await mint(id)
      expect(res.status, id).toBe(404)
      expect(res.text, id).toBe('{"error":"no_grant"}')
    }
  })

  it('R7e: an upper-case UUID is evaluated, not rejected by format', async () => {
    const user = await seedActiveMember(db, { agents: [HOST] })
    const upper = user.toUpperCase()
    await connect(upper)
    await expectServed(upper)
  })

  // R7g / P-I3, P-I6: the route agrees with the reference model
  // active ∧ (HOST ∈ user_agents ∨ ∃ active membership whose team has HOST)
  // over generated memberships written by the production writers.
  it('R7g: the served set equals the reference model for generated memberships', async () => {
    const membershipArb = fc.record({
      active: fc.boolean(),
      direct: fc.boolean(),
      contextMember: fc.boolean(),
      teams: fc.array(fc.record({ membershipActive: fc.boolean(), teamHasHost: fc.boolean() }), {
        maxLength: 2,
      }),
    })
    await fc.assert(
      fc.asyncProperty(fc.array(membershipArb, { minLength: 1, maxLength: 3 }), async users => {
        await dbPool.query('DELETE FROM oauth_grants')
        for (const m of users) {
          const userId = await seedActiveMember(db, {
            agents: m.direct ? [HOST] : [SIBLING_HOST],
            contexts: m.contextMember ? [CONTEXT] : [],
          })
          for (const t of m.teams) {
            const teamId = await teamWithHost(userId, t.teamHasHost ? [HOST] : [SIBLING_HOST])
            if (!t.membershipActive) await softDeleteMember(teamId, userId, operator)
          }
          if (!m.active) await retire(userId)
          await connect(userId)

          const expected =
            m.active && (m.direct || m.teams.some(t => t.membershipActive && t.teamHasHost))
          const res = await mint(userId)
          expect(res.status).toBe(expected ? 200 : 404)
          if (!expected) expect(res.text).toBe('{"error":"no_grant"}')
        }
      }),
      { numRuns: 25 }
    )
  }, 120_000)
})
