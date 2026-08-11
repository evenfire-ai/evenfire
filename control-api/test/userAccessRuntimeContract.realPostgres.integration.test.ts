import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { Pool, type PoolClient } from 'pg'
import { config } from '../src/config.js'
import { type DbClient, initDb } from '../src/db.js'
import { buildAccessCatalog } from '../src/services/access/accessCatalogCoordinator.js'
import { AccessExecutionBudget } from '../src/services/access/accessExecutionBudget.js'
import { resolveLiveAuthorization } from '../src/services/access/liveAuthorizationResolver.js'
import { OperationalAccessIndex } from '../src/services/access/operationalAccessIndex.js'
import {
  canonicalEnvironmentId,
  projectOperationalObject,
} from '../src/services/access/operationalAccessProjection.js'
import { canonicalResourceIdentity } from '../src/services/access/resourceIdentity.js'
import type { ExternalSessionAuthorityContext } from '../src/services/auth/externalSessionAuthentication.js'
import {
  createUserSession,
  renewUserSession,
  revokeUserSession,
} from '../src/services/auth/userSessionService.js'
import { verifyUserSessionV2Token } from '../src/utils/auth/userSessionV2Token.js'

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip
const runtimeRoles = [
  'control_api_runtime',
  'trace_maintenance_runtime',
  'workflow_recipes_runtime',
] as const

function databaseUrl(baseUrl: string, database: string): string {
  const value = new URL(baseUrl)
  value.pathname = `/${database}`
  return value.toString()
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

describeRealPostgres('user-access runtime role contract on real PostgreSQL', () => {
  const database = `control_api_user_access_runtime_${randomBytes(6).toString('hex')}`
  const connectionString = databaseUrl(
    adminUrl ?? 'postgresql://postgres@127.0.0.1/postgres',
    database
  )
  const userId = randomUUID()
  const environmentId = canonicalEnvironmentId()
  const authority: ExternalSessionAuthorityContext = {
    contract: 'v1',
    userId,
    tokenHash: randomBytes(32).toString('hex'),
    issuedAt: Math.floor(Date.now() / 1_000),
  }
  let adminPool: Pool
  let databasePool: Pool

  const runAsControlApiRuntime = async <T>(work: (db: DbClient) => Promise<T>): Promise<T> => {
    const client = (await databasePool.connect()) as PoolClient
    try {
      await client.query('BEGIN')
      await client.query('SET LOCAL ROLE control_api_runtime')
      const value = await work(client)
      await client.query('COMMIT')
      return value
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`DROP ROLE IF EXISTS ${runtimeRoles.join(', ')}`)
    await adminPool.query(`CREATE DATABASE ${quoteIdentifier(database)}`)
    databasePool = new Pool({ connectionString })
    await initDb({ connect: () => databasePool.connect() })
    await databasePool.query(
      `INSERT INTO users(id, email, name) VALUES ($1, $2, 'Runtime Contract User')`,
      [userId, `${userId}@example.test`]
    )
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
      await adminPool.query(`DROP ROLE IF EXISTS ${runtimeRoles.join(', ')}`)
      await adminPool.end()
    }
  })

  it('creates, renews, reads, and revokes user sessions as the runtime role', async () => {
    const issued = await runAsControlApiRuntime(db =>
      createUserSession(
        {
          userId,
          email: `${userId}@example.test`,
          authenticationMethods: ['password'],
        },
        { db }
      )
    )
    const issuedClaims = verifyUserSessionV2Token(issued.token)
    expect(issuedClaims).not.toBeNull()

    const renewed = await runAsControlApiRuntime(db =>
      renewUserSession(issuedClaims!, {
        db,
        now: new Date((issuedClaims!.iat + 1) * 1_000),
      })
    )
    expect(renewed).toMatchObject({ expiresInSeconds: 60 * 60 })
    if (!('token' in renewed)) throw new Error('runtime renewal did not issue a token')
    const renewedClaims = verifyUserSessionV2Token(renewed.token)
    expect(renewedClaims?.jti).not.toBe(issuedClaims?.jti)

    await expect(
      runAsControlApiRuntime(db =>
        revokeUserSession(userId, renewed.identity.sid, 'runtime_contract', db)
      )
    ).resolves.toBe(true)
    const row = await databasePool.query<{ revoked: boolean }>(
      `SELECT revoked_at IS NOT NULL AS revoked
         FROM external_user_sessions
        WHERE sid = $1`,
      [renewed.identity.sid]
    )
    expect(row.rows).toEqual([{ revoked: true }])
  })

  it('projects operational state and bumps authorization revisions as the runtime role', async () => {
    const projection = projectOperationalObject({
      environmentId,
      plural: 'hosts',
      namespace: config.hostsNamespace,
      object: {
        metadata: {
          name: 'runtime-host',
          namespace: config.hostsNamespace,
          uid: 'runtime-host-uid',
          resourceVersion: '1',
          generation: 1,
        },
        spec: { enabled: true, contextRef: 'runtime-context' },
      },
      behaviorFingerprintKey: config.sessionJwtPrivateKey,
      relationshipNamespaces: {
        context: config.contextsNamespace,
        mcpServer: config.mcpServersNamespace,
        sharedFilesystem: config.sharedFilesystemsNamespace,
      },
    })
    const budget = AccessExecutionBudget.create('catalog')
    const index = new OperationalAccessIndex(databasePool, runAsControlApiRuntime)
    try {
      const generation = await index.beginRelist({
        environmentId,
        sourceFamily: 'host',
        budget,
      })
      await index.stageRelistPage({
        environmentId,
        sourceFamily: 'host',
        stagingGeneration: generation,
        projections: [projection],
        budget,
      })
      await index.promoteRelist({
        environmentId,
        sourceFamily: 'host',
        stagingGeneration: generation,
        resourceVersion: '1',
        budget,
      })
    } finally {
      budget.close()
    }

    const stored = await databasePool.query<{ resources: string; revisions: string }>(
      `SELECT
         (SELECT count(*)::text FROM operational_resource_index
           WHERE environment_id = $1 AND resource_type = 'host') AS resources,
         (SELECT count(*)::text FROM authorization_resource_revisions
           WHERE environment_id = $1 AND resource_type = 'host') AS revisions`,
      [environmentId]
    )
    expect(stored.rows).toEqual([{ resources: '1', revisions: '1' }])
  })

  it('reads catalog and resolver authority as the runtime role', async () => {
    const catalog = await buildAccessCatalog(
      { session: authority, families: ['user'], limit: 10 },
      { transaction: runAsControlApiRuntime }
    )
    expect(catalog.complete).toBe(true)
    expect(catalog.items).toHaveLength(1)

    const resolved = await resolveLiveAuthorization(
      {
        session: authority,
        requiredCapability: 'user.profile.read',
        resource: canonicalResourceIdentity(catalog.items[0]!.resource),
        requestedAccessPathId: catalog.items[0]!.accessPaths[0]!.accessPathId,
      },
      { transaction: runAsControlApiRuntime }
    )
    expect(resolved.status).toBe('allowed')
  })

  it('denies the session tables to unrelated roles and PUBLIC', async () => {
    const publicPrivilege = await databasePool.query<{ allowed: boolean }>(
      `SELECT EXISTS (
         SELECT 1
           FROM pg_class relation
           CROSS JOIN LATERAL aclexplode(
             COALESCE(relation.relacl, acldefault('r', relation.relowner))
           ) privilege
          WHERE relation.oid = 'public.external_user_sessions'::regclass
            AND privilege.grantee = 0
            AND privilege.privilege_type = 'SELECT'
       ) AS allowed`
    )
    expect(publicPrivilege.rows).toEqual([{ allowed: false }])

    const unrelated = await databasePool.connect()
    try {
      await unrelated.query('BEGIN')
      await unrelated.query('SET LOCAL ROLE workflow_recipes_runtime')
      await expect(unrelated.query('SELECT sid FROM external_user_sessions')).rejects.toMatchObject(
        { code: '42501' }
      )
    } finally {
      await unrelated.query('ROLLBACK')
      unrelated.release()
    }
  })
})
