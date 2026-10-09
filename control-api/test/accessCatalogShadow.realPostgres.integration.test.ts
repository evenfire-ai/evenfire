import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { type DbClient, initDb } from '../src/db.js'
import { buildAccessCatalog } from '../src/services/access/accessCatalogCoordinator.js'
import { compareAccessCatalogShadow } from '../src/services/access/accessCatalogShadow.js'
import {
  runAccessDatabaseQuery,
  withAccessDatabaseTransaction,
} from '../src/services/access/accessDatabaseQuery.js'
import { AccessExecutionBudget } from '../src/services/access/accessExecutionBudget.js'
import type { ExternalSessionAuthorityContext } from '../src/services/auth/externalSessionAuthentication.js'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip

function databaseUrl(baseUrl: string, database: string): string {
  const value = new URL(baseUrl)
  value.pathname = `/${database}`
  return value.toString()
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

describeRealPostgres('aggregate shadow physical statement budget on real PostgreSQL', () => {
  const database = `control_api_shadow_budget_${randomBytes(6).toString('hex')}`
  const memberUserId = randomUUID()
  const noMembershipUserId = randomUUID()
  const memberTeamIds = Array.from({ length: 100 }, () => randomUUID())
  const resourceIds = Array.from({ length: 100 }, () => randomUUID())
  const memberSession: ExternalSessionAuthorityContext = {
    contract: 'v1',
    userId: memberUserId,
    tokenHash: 'shadow-member-token',
    issuedAt: Math.floor(Date.now() / 1_000),
    authGeneration: 1,
  }
  const noMembershipSession: ExternalSessionAuthorityContext = {
    contract: 'v1',
    userId: noMembershipUserId,
    tokenHash: 'shadow-no-membership-token',
    issuedAt: Math.floor(Date.now() / 1_000),
    authGeneration: 1,
  }
  let adminPool: Pool
  let databasePool: Pool

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`CREATE DATABASE ${quoteIdentifier(database)}`)
    databasePool = new Pool({ connectionString: databaseUrl(adminUrl!, database) })
    await initDb({ connect: () => databasePool.connect() })
    await databasePool.query(
      `INSERT INTO users(id, email, name) VALUES
         ($1, $2, 'Shadow Member'), ($3, $4, 'Shadow Direct User')`,
      [
        memberUserId,
        `${memberUserId}@example.test`,
        noMembershipUserId,
        `${noMembershipUserId}@example.test`,
      ]
    )
    for (let index = 0; index < memberTeamIds.length; index += 1) {
      const teamId = memberTeamIds[index]!
      const resourceId = resourceIds[index]!
      await databasePool.query(`INSERT INTO teams(id, name) VALUES ($1, $2)`, [
        teamId,
        `Shadow Team ${index}`,
      ])
      await databasePool.query(
        `INSERT INTO team_members(team_id, user_id, role, status)
         VALUES ($1, $2, 'member', 'active')`,
        [teamId, memberUserId]
      )
      await databasePool.query(
        `INSERT INTO gfs_resources(resource_id, drive, parent_resource_id, name, kind)
         VALUES ($1, $2, CASE WHEN $4::integer = 0 THEN NULL ELSE $5::uuid END, $3, 'directory')`,
        [
          resourceId,
          `shadow-${database}`,
          index === 0 ? '/' : `member-${index}`,
          index,
          resourceIds[0],
        ]
      )
      await databasePool.query(
        `INSERT INTO gfs_grants(drive, resource_id, subject_type, subject_id, permissions)
         VALUES ($1, $2, 'team', $3::text, ARRAY['read']::text[])`,
        [`shadow-${database}`, resourceId, teamId]
      )
    }
    await databasePool.query(
      `INSERT INTO gfs_grants(drive, resource_id, subject_type, subject_id, permissions)
       VALUES ($1, $2, 'user', $3::text, ARRAY['read']::text[]),
              ($1, $2, 'user', $4::text, ARRAY['read']::text[])`,
      [`shadow-${database}`, resourceIds[0], memberUserId, noMembershipUserId]
    )
  })

  afterAll(async () => {
    try {
      await endPoolAndWaitForClients(databasePool)
      if (!adminPool) return
      await adminPool.query(
        `SELECT pg_terminate_backend(pid)
         FROM pg_stat_activity
        WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [database]
      )
      await adminPool.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(database)}`)
    } finally {
      await adminPool?.end()
    }
  })

  it('executes and charges a real shadow SQL statement only when capacity is reserved', async () => {
    const budget = AccessExecutionBudget.create('catalog', {
      limits: { databaseStatements: 109 },
    })
    let statements = 0
    try {
      await expect(
        compareAccessCatalogShadow(
          {
            session: {
              contract: 'v1',
              userId: '10000000-0000-4000-8000-000000000001',
              tokenHash: 'shadow-test',
              issuedAt: 1,
              authGeneration: 1,
            },
            family: 'team',
            legacyLogicalIds: [],
            legacyComplete: true,
          },
          {
            enabled: true,
            budget,
            buildCatalog: async (_input, options) => {
              const query = await withAccessDatabaseTransaction(
                options.budget!,
                async db => {
                  statements += 1
                  return runAccessDatabaseQuery(
                    db,
                    options.budget!,
                    'SELECT 1 WHERE $1::int = 1',
                    [1],
                    {
                      chargeProducer: false,
                    }
                  )
                },
                { connectionPool: databasePool, mode: 'caller_configured' }
              )
              expect(query.rows).toHaveLength(1)
              return {
                contractVersion: '2',
                authorizationRevision: 'shadow',
                sourceStateRevision: 'shadow',
                complete: true,
                partialErrors: [],
                items: [],
                nextCursor: null,
              }
            },
          }
        )
      ).resolves.toBe('match')
      expect(statements).toBe(1)
      expect(budget.remaining('databaseStatements')).toBe(106)
    } finally {
      budget.close()
    }
  })

  async function buildRealCatalog(
    input: Parameters<typeof buildAccessCatalog>[0],
    options: NonNullable<Parameters<typeof buildAccessCatalog>[1]>
  ) {
    const budget = options.budget
    if (!budget) throw new Error('shadow_budget_missing')
    const transaction = <T>(work: (db: DbClient) => Promise<T>) =>
      withAccessDatabaseTransaction(budget, work, {
        connectionPool: databasePool,
        mode: 'caller_configured',
      })
    return buildAccessCatalog(input, { ...options, transaction })
  }

  it('completes the 100-membership direct-GFS shadow and charges COMMIT', async () => {
    const budget = AccessExecutionBudget.create('catalog', {
      limits: { databaseStatements: 109 },
      teamGfsMembershipAdmissionLimit: 100,
    })
    try {
      await expect(
        compareAccessCatalogShadow(
          {
            session: memberSession,
            family: 'gfs_resource',
            legacyLogicalIds: resourceIds,
            legacyComplete: true,
          },
          { enabled: true, budget, buildCatalog: buildRealCatalog }
        )
      ).resolves.toBe('match')
      expect(budget.remaining('databaseStatements')).toBe(0)
      expect(42 - budget.remaining('producerCalls')).toBeLessThanOrEqual(6)
    } finally {
      budget.close()
    }
  })

  it('completes a direct-GFS shadow for a user with no team memberships', async () => {
    const budget = AccessExecutionBudget.create('catalog', {
      limits: { databaseStatements: 109 },
      teamGfsMembershipAdmissionLimit: 100,
    })
    try {
      await expect(
        compareAccessCatalogShadow(
          {
            session: noMembershipSession,
            family: 'gfs_resource',
            legacyLogicalIds: [resourceIds[0]!],
            legacyComplete: true,
          },
          { enabled: true, budget, buildCatalog: buildRealCatalog }
        )
      ).resolves.toBe('match')
      expect(budget.remaining('databaseStatements')).toBeGreaterThan(0)
      expect(budget.remaining('databaseStatements')).toBeLessThan(109)
    } finally {
      budget.close()
    }
  })
})
