import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { type DbClient, initDb, pool } from '../src/db.js'
import {
  AccessCatalogRequestError,
  buildAccessCatalog,
} from '../src/services/access/accessCatalogCoordinator.js'
import { resolveLiveAuthorization } from '../src/services/access/liveAuthorizationResolver.js'
import { canonicalResourceIdentity } from '../src/services/access/resourceIdentity.js'
import type { ExternalSessionAuthorityContext } from '../src/services/auth/externalSessionAuthentication.js'
import { createUserSession } from '../src/services/auth/userSessionService.js'
import { retireDesktopUser } from '../src/services/directory/users.js'

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

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(value => {
    resolve = value
  })
  return { promise, resolve }
}

describeRealPostgres('final catalog and resolve lifecycle authority on real PostgreSQL', () => {
  const database = `control_api_final_authority_${randomBytes(6).toString('hex')}`
  const connectionString = databaseUrl(
    adminUrl ?? 'postgresql://postgres@127.0.0.1/postgres',
    database
  )
  let adminPool: Pool
  let databasePool: Pool
  let corePoolConnectSpy: ReturnType<typeof vi.spyOn>

  async function createUser(
    label: string,
    lifecycleVersion = 1
  ): Promise<{
    userId: string
    email: string
    session: ExternalSessionAuthorityContext
    retirementActorId: string
  }> {
    const userId = randomUUID()
    const retirementActorId = randomUUID()
    const email = `${label}-${userId}@example.test`
    await databasePool.query(
      `INSERT INTO users(id, email, name, lifecycle_state, lifecycle_version)
       VALUES ($1, $2, $3, 'active', $4)`,
      [userId, email, label, lifecycleVersion]
    )
    await databasePool.query(
      `INSERT INTO control_admin_users(id, username, password_hash, role, status)
       VALUES ($1, $2, 'r6-final-authority-proof', 'admin', 'active')`,
      [retirementActorId, `r6-final-authority-${retirementActorId}`]
    )
    await databasePool.query(
      `INSERT INTO gfs_desktop_operator_links(
         id, lineage_id, generation, user_id, control_admin_id, state, source, created_by, row_version
       ) VALUES (
         gen_random_uuid(), gen_random_uuid(), 1, $1::uuid, $2::uuid,
         'active', 'initial_setup', $2::uuid, 1
       )`,
      [userId, retirementActorId]
    )
    return {
      userId,
      email,
      retirementActorId,
      session: {
        contract: 'v1',
        userId,
        tokenHash: randomBytes(32).toString('hex'),
        issuedAt: Math.floor(Date.now() / 1_000),
        authGeneration: lifecycleVersion,
      },
    }
  }

  function transaction() {
    return async <T>(work: (db: DbClient) => Promise<T>): Promise<T> => {
      const client = await databasePool.connect()
      try {
        await client.query('BEGIN')
        const result = await work(client as unknown as DbClient)
        await client.query('COMMIT')
        return result
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }
    }
  }

  function transactionPausedBeforeAuthoritySnapshot(
    started: ReturnType<typeof deferred>,
    release: ReturnType<typeof deferred>
  ) {
    return async <T>(work: (db: DbClient) => Promise<T>): Promise<T> => {
      const client = await databasePool.connect()
      try {
        await client.query('BEGIN')
        started.resolve()
        await release.promise
        const result = await work(client as unknown as DbClient)
        await client.query('COMMIT')
        return result
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }
    }
  }

  async function retire(userId: string, retirementActorId: string): Promise<void> {
    await retireDesktopUser(
      { kind: 'control_admin', controlAdminId: retirementActorId },
      userId,
      'final authority lifecycle race proof',
      `r6-final-authority-${randomUUID()}`,
      `r6-final-authority-request-${randomUUID()}`
    )
  }

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`DROP ROLE IF EXISTS ${runtimeRoles.join(', ')}`)
    await adminPool.query(`CREATE DATABASE ${quoteIdentifier(database)}`)
    databasePool = new Pool({ connectionString })
    await initDb({ connect: () => databasePool.connect() })
    corePoolConnectSpy = vi
      .spyOn(pool, 'connect')
      .mockImplementation((() => databasePool.connect()) as typeof pool.connect)
  })

  afterAll(async () => {
    corePoolConnectSpy?.mockRestore()
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

  it('accepts only the current canonical V1 lifecycle generation', async () => {
    const current = await createUser('current-generation')
    await expect(
      buildAccessCatalog(
        { session: current.session, families: ['user'], limit: 10 },
        { transaction: transaction() }
      )
    ).resolves.toMatchObject({ complete: true })

    const mismatch = await createUser('generation-mismatch', 2)
    const generationOneRepresentation: ExternalSessionAuthorityContext = {
      ...mismatch.session,
      authGeneration: 1,
    }
    await expect(
      buildAccessCatalog(
        { session: generationOneRepresentation, families: ['user'], limit: 10 },
        { transaction: transaction() }
      )
    ).rejects.toEqual(
      expect.objectContaining<AccessCatalogRequestError>({ code: 'session_not_live' })
    )

    const originalIncarnation = await createUser('missing-generation-canonicalized')
    await expect(
      buildAccessCatalog(
        {
          session: { ...originalIncarnation.session, authGeneration: 1 },
          families: ['user'],
          limit: 10,
        },
        { transaction: transaction() }
      )
    ).resolves.toMatchObject({ complete: true })
  })

  it('denies inactive V2 and missing-user authority in the final snapshot', async () => {
    const inactive = await createUser('inactive-v2')
    const issued = await createUserSession(
      {
        userId: inactive.userId,
        email: inactive.email,
        authenticationMethods: ['pwd'],
      },
      { db: databasePool }
    )
    await retire(inactive.userId, inactive.retirementActorId)
    const v2: ExternalSessionAuthorityContext = {
      contract: 'v2',
      userId: inactive.userId,
      sid: issued.identity.sid,
      jti: issued.identity.jti,
      sessionVersion: issued.identity.sessionVersion,
    }
    await expect(
      buildAccessCatalog(
        { session: v2, families: ['user'], limit: 10 },
        { transaction: transaction() }
      )
    ).rejects.toEqual(
      expect.objectContaining<AccessCatalogRequestError>({ code: 'session_not_live' })
    )

    const missing: ExternalSessionAuthorityContext = {
      contract: 'v1',
      userId: randomUUID(),
      tokenHash: randomBytes(32).toString('hex'),
      issuedAt: Math.floor(Date.now() / 1_000),
      authGeneration: 1,
    }
    await expect(
      buildAccessCatalog(
        { session: missing, families: ['user'], limit: 10 },
        { transaction: transaction() }
      )
    ).rejects.toEqual(
      expect.objectContaining<AccessCatalogRequestError>({ code: 'authority_unavailable' })
    )
  })

  it('denies catalog when retirement commits after admission but before final authority', async () => {
    const principal = await createUser('catalog-retirement-race')
    const started = deferred()
    const release = deferred()
    const pending = buildAccessCatalog(
      { session: principal.session, families: ['user'], limit: 10 },
      { transaction: transactionPausedBeforeAuthoritySnapshot(started, release) }
    )
    await started.promise
    await retire(principal.userId, principal.retirementActorId)
    release.resolve()
    await expect(pending).rejects.toEqual(
      expect.objectContaining<AccessCatalogRequestError>({ code: 'session_not_live' })
    )
  })

  it('denies resolve when retirement commits after admission but before final authority', async () => {
    const principal = await createUser('resolve-retirement-race')
    const catalog = await buildAccessCatalog(
      { session: principal.session, families: ['user'], limit: 10 },
      { transaction: transaction() }
    )
    const item = catalog.items[0]
    expect(item).toBeDefined()
    const started = deferred()
    const release = deferred()
    const pending = resolveLiveAuthorization(
      {
        session: principal.session,
        requiredCapability: 'user.profile.read',
        resource: canonicalResourceIdentity(item!.resource),
        requestedAccessPathId: item!.accessPaths[0]!.accessPathId,
      },
      { transaction: transactionPausedBeforeAuthoritySnapshot(started, release) }
    )
    await started.promise
    await retire(principal.userId, principal.retirementActorId)
    release.resolve()
    await expect(pending).resolves.toEqual({ status: 'denied', code: 'session_not_live' })
  })
})
