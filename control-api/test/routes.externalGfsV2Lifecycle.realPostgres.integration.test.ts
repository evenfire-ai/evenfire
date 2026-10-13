import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import express from 'express'
import { createPublicKey, randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { Readable } from 'node:stream'
import { Pool } from 'pg'
import request from 'supertest'
import { GfsServingHandler } from '../../gfs-controller/src/api/serve.js'
import { loadVerificationKey } from '../../gfs-controller/src/auth/keys.js'
import { verifyGfsToken } from '../../gfs-controller/src/auth/verify.js'
import { DbAuditSink, PermissionClient } from '../../gfs-controller/src/authz/permissionClient.js'
import { resolveAuthzContext } from '../../gfs-controller/src/authz/subjectResolver.js'
import type { GfsConfig } from '../../gfs-controller/src/config.js'
import { PgResourceStore } from '../../gfs-controller/src/db/resourceStore.js'
import { GfsServer } from '../../gfs-controller/src/server.js'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip

function databaseUrl(baseUrl: string, database: string): string {
  const url = new URL(baseUrl)
  url.pathname = `/${database}`
  return url.toString()
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

describeRealPostgres('external GFS session generation on real PostgreSQL', () => {
  const database = `control_api_gfs_v2_generation_${randomBytes(6).toString('hex')}`
  const connectionString = databaseUrl(
    adminUrl ?? 'postgresql://postgres@127.0.0.1/postgres',
    database
  )
  const userId = randomUUID()
  const teamId = randomUUID()
  const directResourceId = randomUUID()
  const teamResourceId = randomUUID()
  const envKeys = [
    'CONTROL_API_PG_CONNECTION_STRING',
    'CONTROL_API_USER_ACCESS_SESSION_V2_ACCEPTANCE',
  ] as const
  const previousEnv = new Map<string, string | undefined>()
  let adminPool: Pool | undefined
  let controlPool: Pool | undefined
  let limiterPool: Pool | undefined
  let appServer: ReturnType<express.Express['listen']> | undefined
  let gfscServer: GfsServer | undefined
  let gfscPort = 0
  let createUserSession: typeof import('../src/services/auth/userSessionService.js').createUserSession
  let issueExternalUserSession: typeof import('../src/services/auth/externalSessionIssuance.js').issueExternalUserSession
  let revokeAllUserSessions: typeof import('../src/services/auth/userSessionService.js').revokeAllUserSessions
  let revokeUserSession: typeof import('../src/services/auth/userSessionService.js').revokeUserSession
  let transaction: typeof import('../src/db.js').withTransaction
  let authenticateExternalUserSession: typeof import('../src/services/auth/externalSessionAuthentication.js').authenticateExternalUserSession
  let gfsToken: typeof import('../src/auth/gfsToken.js')
  let v1Token = ''
  let v2Token = ''

  beforeAll(async () => {
    if (!adminUrl) throw new Error('CONTROL_API_REAL_PG_ADMIN_URL is required by this suite')
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`CREATE DATABASE ${quoteIdentifier(database)}`)

    for (const key of envKeys) previousEnv.set(key, process.env[key])
    process.env.CONTROL_API_PG_CONNECTION_STRING = connectionString
    process.env.CONTROL_API_USER_ACCESS_SESSION_V2_ACCEPTANCE = 'true'

    const dbModule = await import('../src/db.js')
    controlPool = dbModule.pool as unknown as Pool
    limiterPool = dbModule.rateLimitPool as unknown as Pool
    controlPool.on('error', () => {})
    limiterPool.on('error', () => {})
    const migrationPool = new Pool({ connectionString })
    await dbModule.initDb({ connect: () => migrationPool.connect() })
    await endPoolAndWaitForClients(migrationPool)

    const configModule = await import('../src/config.js')
    const authModule = await import('../src/services/auth/userSessionService.js')
    const issuanceModule = await import('../src/services/auth/externalSessionIssuance.js')
    const authnModule = await import('../src/services/auth/externalSessionAuthentication.js')
    const tokenModule = await import('../src/auth/gfsToken.js')
    const routesModule = await import('../src/routes/external/gfs.js')
    createUserSession = authModule.createUserSession
    revokeAllUserSessions = authModule.revokeAllUserSessions
    revokeUserSession = authModule.revokeUserSession
    issueExternalUserSession = issuanceModule.issueExternalUserSession
    authenticateExternalUserSession = authnModule.authenticateExternalUserSession
    transaction = dbModule.withTransaction
    gfsToken = tokenModule

    await controlPool.query(
      `INSERT INTO users (id, email, name) VALUES ($1, $2, 'gfs-generation-test')`,
      [userId, `${userId}@example.test`]
    )
    await controlPool.query(`INSERT INTO teams (id, name) VALUES ($1, 'gfs-generation-team')`, [
      teamId,
    ])
    await controlPool.query(
      `INSERT INTO team_members (team_id, user_id, role, status)
       VALUES ($1, $2, 'member', 'active')`,
      [teamId, userId]
    )
    await transaction(db => revokeAllUserSessions(userId, 'gfs-generation-fixture', db))

    const rootResourceId = randomUUID()
    await controlPool.query(
      `INSERT INTO gfs_resources (resource_id, drive, name, kind, path_cache)
       VALUES ($1, 'main', 'root', 'directory', '/')`,
      [rootResourceId]
    )
    await controlPool.query(
      `INSERT INTO gfs_resources
         (resource_id, drive, parent_resource_id, name, kind, path_cache)
       VALUES ($1, 'main', $3, 'direct.txt', 'file', '/direct.txt'),
              ($2, 'main', $3, 'team.txt', 'file', '/team.txt')`,
      [directResourceId, teamResourceId, rootResourceId]
    )
    await controlPool.query(
      `INSERT INTO gfs_grants (drive, resource_id, subject_type, subject_id, permissions)
       VALUES ('main', $1, 'user', $2, ARRAY['read']::text[]),
              ('main', $3, 'team', $4, ARRAY['read']::text[])`,
      [directResourceId, userId, teamResourceId, teamId]
    )

    const testPolicy = {
      issueV1: true,
      acceptV1: true,
      issueV2: false,
      acceptV2: true,
    } as import('../src/services/access/userAccessPolicy.js').EffectiveUserAccessPolicy
    const issuedV1 = await issueExternalUserSession(
      {
        contract: 'v1',
        userId,
        email: `${userId}@example.test`,
        teamId,
        role: 'member',
        authenticationMethods: ['pwd'],
      },
      { policy: testPolicy }
    )
    v1Token = issuedV1.token
    const issuedV2 = await transaction(db =>
      createUserSession(
        { userId, email: `${userId}@example.test`, authenticationMethods: ['pwd'] },
        { db }
      )
    )
    v2Token = issuedV2.token

    const publicKey = createPublicKey(configModule.config.rpcJwtPrivateKey).export({
      type: 'spki',
      format: 'pem',
    })
    const verificationKey = loadVerificationKey(String(publicKey))
    const permissions = new PermissionClient(
      controlPool as never,
      new DbAuditSink(controlPool as never)
    )
    const serving = new GfsServingHandler({
      verifyToken: token =>
        verifyGfsToken(token, {
          key: verificationKey,
          audience: configModule.config.gfsTokenAudience,
          issuer: configModule.config.rpcJwtIssuer,
        }),
      resolveContext: (claims, requestId) =>
        resolveAuthzContext(controlPool as never, claims, requestId),
      authorize: (context, resourceId, operation) =>
        permissions.authorize(context, resourceId, operation),
      store: new PgResourceStore(controlPool as never),
      blobs: { read: async () => Readable.from([]) },
      rateLimit: {
        reads: { check: () => undefined, limitPerWindow: 1 },
        writes: { check: () => undefined, limitPerWindow: 1 },
      },
    })
    gfscServer = new GfsServer(
      {
        port: 0,
        storageMountPath: '/unused-in-read-test',
        storageRole: 'reader',
        pgConnectionString: connectionString,
        tokenAudience: configModule.config.gfsTokenAudience,
        publicKey: String(publicKey),
        driveName: 'main',
        decisionCacheTtlMs: 0,
        credentialProbeIntervalMs: 60_000,
        blobCleanupSafetyWindowMs: 60_000,
        blobCleanupIntervalMs: 60_000,
        blobCleanupBatchSize: 1,
        agentReadRlPerMinPerReplica: 1,
        agentWriteRlPerMinPerReplica: 1,
        syncCopyMaxObjects: 1,
        syncCopyMaxBytes: 1,
        syncCopyTimeoutMs: 1_000,
        syncRenameMaxObjects: 1,
        syncRenameTimeoutMs: 1_000,
        uploadV2: {} as GfsConfig['uploadV2'],
        devMode: true,
      } as GfsConfig,
      { isStorageMounted: async () => true, pingPermissionStore: async () => undefined },
      serving
    )
    gfscPort = await gfscServer.start()
    configModule.config.gfscBaseUrl = `http://127.0.0.1:${gfscPort}`

    const app = express()
    app.use(express.json())
    app.use(routesModule.createExternalGfsRouter())
    appServer = app.listen(0, '127.0.0.1')
    await once(appServer, 'listening')
  }, 60_000)

  afterAll(async () => {
    try {
      appServer?.closeAllConnections?.()
      if (appServer) await new Promise<void>(resolve => appServer!.close(() => resolve()))
      await gfscServer?.stop()
      for (const key of envKeys) {
        const value = previousEnv.get(key)
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      await endPoolAndWaitForClients(controlPool)
      await endPoolAndWaitForClients(limiterPool)
      if (adminPool) {
        await adminPool.query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
            WHERE datname = $1 AND pid <> pg_backend_pid()`,
          [database]
        )
        await adminPool.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(database)}`)
      }
    } finally {
      await adminPool?.end()
    }
  })

  async function resolve(token: string, resourceId: string) {
    if (!appServer) throw new Error('GFS test app did not start')
    const client = request(appServer)
    return client
      .get(`/external/gfs/resolve?uri=${encodeURIComponent(`gfs://main/${resourceId}`)}`)
      .set('x-user-session-token', token)
      .set('x-forwarded-for', '127.0.0.1')
  }

  async function mintGfsToken(token: string) {
    if (!appServer) throw new Error('GFS test app did not start')
    return request(appServer)
      .post('/external/gfs/token')
      .set('x-user-session-token', token)
      .set('x-forwarded-for', '127.0.0.1')
      .send({ drive: 'main', scopes: ['gfs.read'] })
  }

  it('keeps legacy V1 reads valid through the real GFSC HTTP and PostgreSQL permission path', async () => {
    const result = await resolve(v1Token, directResourceId)
    expect(result.status).toBe(200)
    expect(result.body.data?.resourceId).toBe(directResourceId)
  })

  it('mints a current V2 generation for GFSC and preserves direct/team access checks', async () => {
    const authentication = await authenticateExternalUserSession(v2Token, { purpose: 'protected' })
    expect(authentication.status).toBe('authenticated')
    if (authentication.status !== 'authenticated') return
    expect(authentication.contract).toBe('v2')
    expect(authentication.claims.authGeneration).toBeUndefined()
    const lifecycle = await controlPool!.query<{ lifecycle_version: number | string }>(
      `SELECT lifecycle_version FROM users WHERE id = $1`,
      [userId]
    )
    expect(Number(lifecycle.rows[0]?.lifecycle_version)).toBeGreaterThan(1)

    const staleGeneration = gfsToken.signGfsToken({
      subject: userId,
      drive: 'main',
      scopes: ['gfs.read'],
      authGeneration: Number(lifecycle.rows[0]?.lifecycle_version) - 1,
      principalType: 'user',
    })
    const staleGenerationResult = await fetch(
      `http://127.0.0.1:${gfscPort}/v1/resolve?uri=${encodeURIComponent(`gfs://main/${directResourceId}`)}`,
      { headers: { authorization: `Bearer ${staleGeneration.token}` } }
    )
    expect([401, 403]).toContain(staleGenerationResult.status)

    const direct = await resolve(v2Token, directResourceId)
    if (direct.status === 403) {
      expect(direct.body).toMatchObject({ error: { code: 'forbidden' } })
    }
    expect(direct.status).toBe(200)
    expect(direct.body.data?.resourceId).toBe(directResourceId)

    const team = await resolve(v2Token, teamResourceId)
    expect(team.status).toBe(200)
    expect(team.body.data?.resourceId).toBe(teamResourceId)

    await controlPool!.query(
      `UPDATE team_members SET status = 'deleted' WHERE team_id = $1 AND user_id = $2`,
      [teamId, userId]
    )
    const revokedTeam = await resolve(v2Token, teamResourceId)
    expect(revokedTeam.status).toBe(403)
    const survivingDirect = await resolve(v2Token, directResourceId)
    expect(survivingDirect.status).toBe(200)
  })

  it('returns a V2 GFS token that the real GFSC HTTP consumer accepts', async () => {
    const minted = await mintGfsToken(v2Token)
    expect(minted.status).toBe(200)
    expect(typeof minted.body.token).toBe('string')
    const configModule = await import('../src/config.js')
    expect(minted.body.expiresInSeconds).toBe(configModule.config.gfsTokenTtlSeconds)

    const consumed = await fetch(
      `http://127.0.0.1:${gfscPort}/v1/resolve?uri=${encodeURIComponent(`gfs://main/${directResourceId}`)}`,
      { headers: { authorization: `Bearer ${minted.body.token}` } }
    )
    expect(consumed.status).toBe(200)
    const body = (await consumed.json()) as { data?: { resourceId?: string } }
    expect(body.data?.resourceId).toBe(directResourceId)
  })

  it('does not use a revoked V2 session as a legacy fallback', async () => {
    const issued = await transaction(db =>
      createUserSession(
        { userId, email: `${userId}@example.test`, authenticationMethods: ['pwd'] },
        { db }
      )
    )
    const authentication = await authenticateExternalUserSession(issued.token, {
      purpose: 'protected',
    })
    if (authentication.status !== 'authenticated' || authentication.contract !== 'v2') {
      throw new Error('current V2 producer did not create an accepted V2 session')
    }
    await transaction(db => revokeUserSession(userId, issued.identity.sid, 'logout', db))
    const result = await resolve(issued.token, directResourceId)
    expect(result.status).toBe(401)
    const mintAfterRevocation = await mintGfsToken(issued.token)
    expect(mintAfterRevocation.status).toBe(401)
  })
})
