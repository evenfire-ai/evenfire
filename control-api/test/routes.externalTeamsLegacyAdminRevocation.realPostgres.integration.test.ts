import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { randomBytes } from 'node:crypto'
import { Pool } from 'pg'
import request from 'supertest'
import { initDb } from '../src/db.js'
import { createExternalTeamsRouter } from '../src/routes/external/teams.js'
import { issueExternalUserSession } from '../src/services/auth/externalSessionIssuance.js'
import { verifyExternalSessionToken } from '../src/utils/auth/externalSessionAuthToken.js'

const userId = '11111111-1111-4111-8111-111111111111'
const teamId = '22222222-2222-4222-8222-222222222222'
const targetUserId = '33333333-3333-4333-8333-333333333333'
let staleAdminToken: string

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip
const producerDatabase = vi.hoisted(() => ({ pool: undefined as Pool | undefined }))
const rateLimit = vi.hoisted(() => ({ checkAndIncrement: vi.fn() }))
const runtimePolicy = vi.hoisted(() => ({
  policyVersion: '1',
  policyRevision: 'legacy-admin-route-proof',
  acceptV1: true,
  issueV1: true,
  acceptV2: false,
  issueV2: false,
  renewV2: false,
  switchCompatibility: true,
  computeCatalogShadow: false,
  serveCatalog: false,
  actionContextV2: false,
  rpcDelegationV2: false,
  desktopAllTeamMode: false,
  profileV2Mode: false,
  minimumClientVersion: null,
  enforceMinimumClient: false,
  advertisedCatalogFamilies: [],
}))
const directory = vi.hoisted(() => ({
  createManagedInvitationForUser: vi.fn(),
  createTeamForUser: vi.fn(),
  deleteManagedMemberForUser: vi.fn(),
  findMemberRole: vi.fn(),
  getCurrentTeam: vi.fn(),
  getTeamAgents: vi.fn(),
  getTeamContexts: vi.fn(),
  listMembers: vi.fn(),
  renameTeamForUser: vi.fn(),
  updateManagedMemberRoleForUser: vi.fn(),
}))

vi.mock('../src/db.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/db.js')>()
  return {
    ...actual,
    pool: {
      query: (text: string, values?: unknown[]) => producerDatabase.pool!.query(text, values),
    },
  }
})
vi.mock('../src/services/rateLimiterService.js', () => rateLimit)
vi.mock('../src/services/access/userAccessRuntimePolicy.js', () => ({
  resolveEffectiveUserAccessPolicy: vi.fn().mockResolvedValue(runtimePolicy),
}))
vi.mock('../src/services/directory/index.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/services/directory/index.js')>()),
  ...directory,
}))

type AdminMutation = Readonly<{
  name: string
  invoke: (server: express.Express) => request.Test
  handler: keyof Pick<
    typeof directory,
    'renameTeamForUser' | 'updateManagedMemberRoleForUser' | 'deleteManagedMemberForUser'
  >
}>

const mutations: readonly AdminMutation[] = [
  {
    name: 'rename team',
    invoke: server =>
      request(server).put(`/external/teams/${teamId}/name`).send({ name: 'Renamed' }),
    handler: 'renameTeamForUser',
  },
  {
    name: 'change member role',
    invoke: server =>
      request(server)
        .patch(`/external/teams/${teamId}/members/${targetUserId}/role`)
        .send({ role: 'member' }),
    handler: 'updateManagedMemberRoleForUser',
  },
  {
    name: 'delete member',
    invoke: server => request(server).delete(`/external/teams/${teamId}/members/${targetUserId}`),
    handler: 'deleteManagedMemberForUser',
  },
]

function app() {
  const server = express()
  server.use(express.json())
  server.use(createExternalTeamsRouter({} as never))
  return server
}

function databaseUrl(baseUrl: string, database: string): string {
  const value = new URL(baseUrl)
  value.pathname = `/${database}`
  return value.toString()
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

describeRealPostgres('legacy V1 live-admin revocation on real external team routes', () => {
  const database = `control_api_legacy_admin_${randomBytes(6).toString('hex')}`
  const connectionString = databaseUrl(
    adminUrl ?? 'postgresql://postgres@127.0.0.1/postgres',
    database
  )
  let adminPool: Pool
  let databasePool: Pool

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`CREATE DATABASE ${quoteIdentifier(database)}`)
    databasePool = new Pool({ connectionString })
    producerDatabase.pool = databasePool
    await initDb({ connect: () => databasePool.connect() })
    await databasePool.query(
      `INSERT INTO users(id, email, name)
       VALUES ($1, 'admin@example.test', 'Legacy Admin')`,
      [userId]
    )
    await databasePool.query(`INSERT INTO teams(id, name) VALUES ($1, 'Legacy Team')`, [teamId])
    await databasePool.query(
      `INSERT INTO team_members(team_id, user_id, role, status)
       VALUES ($1, $2, 'admin', 'active')`,
      [teamId, userId]
    )

    const issued = await issueExternalUserSession(
      {
        contract: 'v1',
        userId,
        email: 'admin@example.test',
        teamId,
        role: 'admin',
        authGeneration: 1,
        authenticationMethods: ['pwd'],
      },
      { policy: runtimePolicy }
    )
    staleAdminToken = issued.token
    expect(staleAdminToken).not.toBe('same-valid-v1-token-minted-while-admin')
    expect(verifyExternalSessionToken(staleAdminToken)).toMatchObject({
      userId,
      teamId,
      role: 'admin',
      authGeneration: 1,
    })
  })

  afterAll(async () => {
    await databasePool?.end()
    if (adminPool) {
      await adminPool.query(
        `SELECT pg_terminate_backend(pid)
           FROM pg_stat_activity
          WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [database]
      )
      await adminPool.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(database)}`)
      await adminPool.end()
    }
  })

  beforeEach(async () => {
    vi.clearAllMocks()
    await databasePool.query(
      `INSERT INTO users(id, email, name)
       VALUES ($1, 'admin@example.test', 'Legacy Admin')
       ON CONFLICT (id) DO UPDATE
         SET lifecycle_state = 'active', lifecycle_version = 1`,
      [userId]
    )
    await databasePool.query(
      `INSERT INTO teams(id, name)
       VALUES ($1, 'Legacy Team')
       ON CONFLICT (id) DO NOTHING`,
      [teamId]
    )
    await databasePool.query(
      `INSERT INTO team_members(team_id, user_id, role, status)
       VALUES ($1, $2, 'admin', 'active')
       ON CONFLICT (team_id, user_id) DO UPDATE
         SET role = 'admin', status = 'active', updated_at = NOW()`,
      [teamId, userId]
    )
    rateLimit.checkAndIncrement.mockResolvedValue({
      allowed: true,
      count: 1,
      remaining: 9,
      resetMs: Date.now() + 60_000,
      windowStartMs: Date.now(),
    })
    directory.renameTeamForUser.mockResolvedValue({ team: { id: teamId, name: 'Renamed' } })
    directory.updateManagedMemberRoleForUser.mockResolvedValue({
      membership: { userId: targetUserId, teamId, role: 'member' },
    })
    directory.deleteManagedMemberForUser.mockResolvedValue({ deleted: { userId: targetUserId } })
  })

  for (const mutation of mutations) {
    it.each([
      ['demoted', 'demote'],
      ['membership removed', 'remove'],
    ] as const)(`rejects ${mutation.name} with the same token after %s`, async (_state, action) => {
      if (action === 'demote') {
        await databasePool.query(
          `UPDATE team_members SET role = 'member', updated_at = NOW()
            WHERE team_id = $1 AND user_id = $2`,
          [teamId, userId]
        )
      } else {
        await databasePool.query(
          `UPDATE team_members SET status = 'deleted', updated_at = NOW()
            WHERE team_id = $1 AND user_id = $2`,
          [teamId, userId]
        )
      }

      const response = await mutation.invoke(app()).set('x-user-session-token', staleAdminToken)

      expect(response.status).toBe(403)
      expect(directory[mutation.handler]).not.toHaveBeenCalled()
    })

    it(`allows ${mutation.name} only when the same token resolves to a current admin`, async () => {
      const response = await mutation.invoke(app()).set('x-user-session-token', staleAdminToken)

      expect(response.status).toBe(200)
      expect(directory[mutation.handler]).toHaveBeenCalledOnce()
    })
  }
})
