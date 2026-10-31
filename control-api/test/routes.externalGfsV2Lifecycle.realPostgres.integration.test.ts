import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { createPublicKey, randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { Readable } from 'node:stream'
import { Pool, type PoolClient } from 'pg'
import request from 'supertest'
import { GfsServingHandler } from '../../gfs-controller/src/api/serve.js'
import { loadVerificationKey } from '../../gfs-controller/src/auth/keys.js'
import { verifyGfsToken } from '../../gfs-controller/src/auth/verify.js'
import { DbAuditSink, PermissionClient } from '../../gfs-controller/src/authz/permissionClient.js'
import { resolveAuthzContext } from '../../gfs-controller/src/authz/subjectResolver.js'
import type { GfsConfig } from '../../gfs-controller/src/config.js'
import { PgResourceStore } from '../../gfs-controller/src/db/resourceStore.js'
import { GfsServer } from '../../gfs-controller/src/server.js'
import type { DbClient } from '../src/db.js'
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

async function withPoolTransaction<T>(pool: Pool, work: (db: DbClient) => Promise<T>): Promise<T> {
  const client = (await pool.connect()) as PoolClient
  try {
    await client.query('BEGIN')
    const result = await work(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
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
    'CONTROL_API_INTERNAL_SERVICE_TOKENS',
  ] as const
  const previousEnv = new Map<string, string | undefined>()
  let adminPool: Pool | undefined
  let controlPool: Pool | undefined
  let limiterPool: Pool | undefined
  let appServer: ReturnType<express.Express['listen']> | undefined
  let checkpointServer: ReturnType<express.Express['listen']> | undefined
  let gfscServer: GfsServer | undefined
  let gfscPort = 0
  let createUserSession: typeof import('../src/services/auth/userSessionService.js').createUserSession
  let issueExternalUserSession: typeof import('../src/services/auth/externalSessionIssuance.js').issueExternalUserSession
  let revokeAllUserSessions: typeof import('../src/services/auth/userSessionService.js').revokeAllUserSessions
  let revokeUserSession: typeof import('../src/services/auth/userSessionService.js').revokeUserSession
  let transaction: typeof import('../src/db.js').withTransaction
  let authenticateExternalUserSession: typeof import('../src/services/auth/externalSessionAuthentication.js').authenticateExternalUserSession
  let gfsToken: typeof import('../src/auth/gfsToken.js')
  let authorizeActionV2: typeof import('../src/services/access/actionAuthorizer.js').authorizeActionV2
  let prepareActionOperationTarget: typeof import('../src/services/access/actionMessageId.js').prepareActionOperationTarget
  let canonicalEnvironmentId: typeof import('../src/services/access/operationalAccessProjection.js').canonicalEnvironmentId
  let canonicalResourceIdentity: typeof import('../src/services/access/resourceIdentity.js').canonicalResourceIdentity
  let workflowActionDelegationHeader: typeof import('../src/services/workflows/workflowAuthorityBindingService.js').WORKFLOW_ACTION_DELEGATION_HEADER
  let issueUserDelegationV2: typeof import('../src/utils/auth/userDelegationV2Token.js').issueUserDelegationV2
  let gfsVerificationKey: ReturnType<typeof loadVerificationKey>
  let gatewayReads = 0
  let v1Token = ''
  let v2Token = ''

  beforeAll(async () => {
    if (!adminUrl) throw new Error('CONTROL_API_REAL_PG_ADMIN_URL is required by this suite')
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`CREATE DATABASE ${quoteIdentifier(database)}`)

    for (const key of envKeys) previousEnv.set(key, process.env[key])
    process.env.CONTROL_API_PG_CONNECTION_STRING = connectionString
    process.env.CONTROL_API_USER_ACCESS_SESSION_V2_ACCEPTANCE = 'true'
    process.env.CONTROL_API_INTERNAL_SERVICE_TOKENS =
      'gfs-controller=task-local-gfs-checkpoint-service-token'

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
    const actionAuthorizerModule = await import('../src/services/access/actionAuthorizer.js')
    const actionTargetModule = await import('../src/services/access/actionMessageId.js')
    const operationalProjectionModule =
      await import('../src/services/access/operationalAccessProjection.js')
    const resourceIdentityModule = await import('../src/services/access/resourceIdentity.js')
    const actionAuthorityModule =
      await import('../src/services/workflows/workflowAuthorityBindingService.js')
    const delegationModule = await import('../src/utils/auth/userDelegationV2Token.js')
    const routesModule = await import('../src/routes/external/gfs.js')
    const checkpointRouteModule =
      await import('../src/routes/internal/actionAuthorityCheckpoint.js')
    const gfsCheckpointModule = await import('../../gfs-controller/src/auth/actionAuthority.js')
    createUserSession = authModule.createUserSession
    revokeAllUserSessions = authModule.revokeAllUserSessions
    revokeUserSession = authModule.revokeUserSession
    issueExternalUserSession = issuanceModule.issueExternalUserSession
    authenticateExternalUserSession = authnModule.authenticateExternalUserSession
    transaction = dbModule.withTransaction
    gfsToken = tokenModule
    authorizeActionV2 = actionAuthorizerModule.authorizeActionV2
    prepareActionOperationTarget = actionTargetModule.prepareActionOperationTarget
    canonicalEnvironmentId = operationalProjectionModule.canonicalEnvironmentId
    canonicalResourceIdentity = resourceIdentityModule.canonicalResourceIdentity
    workflowActionDelegationHeader = actionAuthorityModule.WORKFLOW_ACTION_DELEGATION_HEADER
    issueUserDelegationV2 = delegationModule.issueUserDelegationV2

    const checkpointGateway = {
      getResourceExact: async () => {
        gatewayReads += 1
        throw new Error('unexpected_kubernetes_lookup_for_gfs_resource')
      },
    }
    const checkpointApp = express()
    checkpointApp.use(express.json())
    checkpointApp.use(
      '/api/v1',
      checkpointRouteModule.createInternalActionAuthorityCheckpointRouter(
        checkpointGateway as never
      )
    )
    checkpointServer = checkpointApp.listen(0, '127.0.0.1')
    await once(checkpointServer, 'listening')
    const checkpointAddress = checkpointServer.address()
    if (!checkpointAddress || typeof checkpointAddress === 'string') {
      throw new Error('GFS authority checkpoint test server did not bind a TCP port')
    }
    const checkpointAuthority = gfsCheckpointModule.createGfsAuthorityCheckpointer({
      baseUrl: `http://127.0.0.1:${checkpointAddress.port}`,
      serviceToken: 'task-local-gfs-checkpoint-service-token',
      timeoutMs: 2_000,
    })

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
    gfsVerificationKey = verificationKey
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
      checkpointAuthority,
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
    app.use(
      routesModule.createExternalGfsRouter({
        getResourceExact: async () => {
          gatewayReads += 1
          throw new Error('unexpected_kubernetes_lookup_for_gfs_resource')
        },
      } as never)
    )
    appServer = app.listen(0, '127.0.0.1')
    await once(appServer, 'listening')
  }, 60_000)

  afterAll(async () => {
    try {
      appServer?.closeAllConnections?.()
      if (appServer) await new Promise<void>(resolve => appServer!.close(() => resolve()))
      checkpointServer?.closeAllConnections?.()
      if (checkpointServer)
        await new Promise<void>(resolve => checkpointServer!.close(() => resolve()))
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

  function mintGfsToken(token: string, actionDelegation?: string) {
    if (!appServer) throw new Error('GFS test app did not start')
    const call = request(appServer)
      .post('/external/gfs/token')
      .set('x-user-session-token', token)
      .set('x-forwarded-for', '127.0.0.1')
    if (actionDelegation) call.set(workflowActionDelegationHeader, actionDelegation)
    return call
  }

  async function issueSelectedGfsReadDelegation(resourceId: string, issuedAtSeconds?: number) {
    const authentication = await authenticateExternalUserSession(v2Token, {
      purpose: 'protected',
    })
    if (authentication.status !== 'authenticated' || authentication.contract !== 'v2') {
      throw new Error('current V2 session did not authenticate for GFS delegation')
    }
    const resource = canonicalResourceIdentity({
      environmentId: canonicalEnvironmentId(),
      type: 'gfs_resource',
      logicalId: resourceId,
    })
    const target = { drive: 'main', resourceId }
    const authorizationOptions = {
      transaction: <T>(work: (db: DbClient) => Promise<T>) =>
        withPoolTransaction(controlPool!, work),
    }
    let result = await authorizeActionV2(
      {
        session: authentication.authorityContext,
        requested: { version: 2 },
        operationId: 'gfs.read',
        resource,
        operationTarget: target,
        allocateChatMessageId: false,
      },
      { authorizationOptions }
    )
    if (result.status === 'access_path_required') {
      const path = result.paths.find(candidate => candidate.kind === 'direct')
      if (!path) throw new Error('GFS direct producer returned no authorized access path')
      result = await authorizeActionV2(
        {
          session: authentication.authorityContext,
          requested: {
            version: 2,
            requestedAccessPathId: path.id,
            expectedAuthorizationRevision: path.authorizationRevision,
          },
          operationId: 'gfs.read',
          resource,
          operationTarget: target,
          allocateChatMessageId: false,
        },
        { authorizationOptions }
      )
    }
    if (result.status !== 'allowed') {
      throw new Error(`GFS producer did not authorize the selected path: ${result.status}`)
    }
    const preparedTarget = prepareActionOperationTarget({
      operationId: 'gfs.read',
      resource,
      operationTarget: target,
    })
    return {
      token: issueUserDelegationV2({
        principal: {
          userId,
          sid: result.context.principal.sid,
          sessionVersion: result.context.principal.sessionVersion,
        },
        operationIds: ['gfs.read'],
        resource,
        preparedTargets: { 'gfs.read': preparedTarget },
        accessPathId: result.context.accessPathId,
        authorizationRevision: result.context.authorizationRevision,
        behaviorBindingHash: result.context.behaviorBindingHash,
        pathKind: result.context.pathKind,
        effectiveTeamId: result.context.effectiveTeamId,
        ...(issuedAtSeconds === undefined ? {} : { issuedAtSeconds }),
      }),
      context: result.context,
    }
  }

  it('keeps legacy V1 reads valid through the real GFSC HTTP and PostgreSQL permission path', async () => {
    const result = await resolve(v1Token, directResourceId)
    expect(result.status).toBe(200)
    expect(result.body.data?.resourceId).toBe(directResourceId)
  })

  it('mints a V1 GFS token that the real GFSC HTTP consumer accepts', async () => {
    const minted = await mintGfsToken(v1Token).send({ drive: 'main', scopes: ['gfs.read'] })
    expect(minted.status).toBe(200)
    expect(typeof minted.body.token).toBe('string')
    const configModule = await import('../src/config.js')
    const claims = verifyGfsToken(minted.body.token, {
      key: gfsVerificationKey,
      audience: configModule.config.gfsTokenAudience,
      issuer: configModule.config.rpcJwtIssuer,
    })
    expect(claims?.principalType).toBe('user')
    expect(claims?.authGeneration).toBeGreaterThan(1)

    const consumed = await fetch(
      `http://127.0.0.1:${gfscPort}/v1/resolve?uri=${encodeURIComponent(`gfs://main/${directResourceId}`)}`,
      { headers: { authorization: `Bearer ${minted.body.token}` } }
    )
    expect(consumed.status).toBe(200)
    const body = (await consumed.json()) as { data?: { resourceId?: string } }
    expect(body.data?.resourceId).toBe(directResourceId)
  })

  it('rejects unbound V2 reads and preserves legacy direct/team access checks', async () => {
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

    const gatewayReadsBefore = gatewayReads
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('unexpected_gfsc_fetch_for_unbound_v2'))
    try {
      const unboundV2 = await resolve(v2Token, directResourceId)
      expect(unboundV2.status).toBe(403)
      expect(unboundV2.body).toEqual({ error: 'action_delegation_required' })
      expect(fetchSpy).not.toHaveBeenCalled()
      expect(gatewayReads).toBe(gatewayReadsBefore)
    } finally {
      fetchSpy.mockRestore()
    }

    const direct = await resolve(v1Token, directResourceId)
    expect(direct.status).toBe(200)
    expect(direct.body.data?.resourceId).toBe(directResourceId)

    const team = await resolve(v1Token, teamResourceId)
    expect(team.status).toBe(200)
    expect(team.body.data?.resourceId).toBe(teamResourceId)

    await controlPool!.query(
      `UPDATE team_members SET status = 'deleted' WHERE team_id = $1 AND user_id = $2`,
      [teamId, userId]
    )
    const revokedTeam = await resolve(v1Token, teamResourceId)
    expect(revokedTeam.status).toBe(403)
    const survivingDirect = await resolve(v1Token, directResourceId)
    expect(survivingDirect.status).toBe(200)
  })

  it('returns a V2 GFS token that the real GFSC HTTP consumer accepts', async () => {
    const delegation = await issueSelectedGfsReadDelegation(directResourceId)
    const mint = mintGfsToken(v2Token, delegation.token).send({
      drive: 'main',
      scopes: ['gfs.read'],
      operationId: 'gfs.read',
      resourceId: directResourceId,
      target: { drive: 'main', resourceId: directResourceId },
    })
    const minted = await mint
    expect(minted.status).toBe(200)
    expect(typeof minted.body.token).toBe('string')
    const configModule = await import('../src/config.js')
    expect(minted.body.expiresInSeconds).toBeGreaterThan(0)
    expect(minted.body.expiresInSeconds).toBeLessThanOrEqual(configModule.config.gfsTokenTtlSeconds)
    const claims = verifyGfsToken(minted.body.token, {
      key: gfsVerificationKey,
      audience: configModule.config.gfsTokenAudience,
      issuer: configModule.config.rpcJwtIssuer,
    })
    expect(claims?.principalType).toBe('user')
    expect(claims?.authGeneration).toBeGreaterThan(1)
    expect(claims?.actionAuthority?.binding).toEqual(
      expect.objectContaining({
        operationId: 'gfs.read',
        resource: expect.objectContaining({ logicalId: directResourceId }),
        target: { drive: 'main', resourceId: directResourceId },
        accessPathId: delegation.context.accessPathId,
        authorizationRevision: delegation.context.authorizationRevision,
      })
    )
    expect(claims?.exp).toBeLessThanOrEqual(claims?.actionAuthority?.sourceExpiresAt ?? 0)
    expect(gatewayReads).toBe(0)

    const consumed = await fetch(
      `http://127.0.0.1:${gfscPort}/v1/resolve?uri=${encodeURIComponent(`gfs://main/${directResourceId}`)}`,
      { headers: { authorization: `Bearer ${minted.body.token}` } }
    )
    expect(consumed.status).toBe(200)
    const body = (await consumed.json()) as { data?: { resourceId?: string } }
    expect(body.data?.resourceId).toBe(directResourceId)

    const mismatched = await mintGfsToken(v2Token, delegation.token).send({
      drive: 'main',
      scopes: ['gfs.read'],
      operationId: 'gfs.read',
      resourceId: teamResourceId,
      target: { drive: 'main', resourceId: teamResourceId },
    })
    expect(mismatched.status).toBe(403)
  })

  it('rejects a real V2 session on mediated capabilities before contacting GFSC', async () => {
    const authentication = await authenticateExternalUserSession(v2Token, {
      purpose: 'protected',
    })
    expect(authentication.status).toBe('authenticated')
    if (authentication.status !== 'authenticated') return
    expect(authentication.contract).toBe('v2')

    if (!appServer) throw new Error('GFS test app did not start')
    const gatewayReadsBefore = gatewayReads
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    try {
      const response = await request(appServer)
        .get('/external/gfs/capabilities')
        .set('x-user-session-token', v2Token)
        .set('x-forwarded-for', '127.0.0.1')

      expect(response.status).toBe(403)
      expect(response.body).toEqual({ error: 'action_delegation_required' })
      expect(fetchSpy).not.toHaveBeenCalled()
      expect(gatewayReads).toBe(gatewayReadsBefore)
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it.each([
    ['omitted', undefined],
    ['forged', 'forged-action-delegation'],
  ] as const)(
    'rejects an %s V2 delegation before issuing a GFS token',
    async (_label, delegation) => {
      const response = await mintGfsToken(v2Token, delegation).send({
        drive: 'main',
        scopes: ['gfs.read'],
        operationId: 'gfs.read',
        resourceId: directResourceId,
        target: { drive: 'main', resourceId: directResourceId },
      })

      expect(response.status).toBe(400)
      expect(response.body).toEqual({ error: 'invalid_action_delegation' })
      expect(response.body.token).toBeUndefined()
    }
  )

  it('rejects an expired signed delegation before issuing a GFS token', async () => {
    const stale = await issueSelectedGfsReadDelegation(
      directResourceId,
      Math.floor(Date.now() / 1000) - 3600
    )
    const response = await mintGfsToken(v2Token, stale.token).send({
      drive: 'main',
      scopes: ['gfs.read'],
      operationId: 'gfs.read',
      resourceId: directResourceId,
      target: { drive: 'main', resourceId: directResourceId },
    })

    expect(response.status).toBe(400)
    expect(response.body).toEqual({ error: 'invalid_action_delegation' })
    expect(response.body.token).toBeUndefined()
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

  it('blocks a previously minted V2 GFS token after its selected permission is revoked', async () => {
    const delegation = await issueSelectedGfsReadDelegation(directResourceId)
    const minted = await mintGfsToken(v2Token, delegation.token).send({
      drive: 'main',
      scopes: ['gfs.read'],
      operationId: 'gfs.read',
      resourceId: directResourceId,
      target: { drive: 'main', resourceId: directResourceId },
    })
    expect(minted.status).toBe(200)

    await controlPool!.query(
      `DELETE FROM gfs_grants
        WHERE drive = 'main' AND resource_id = $1 AND subject_type = 'user' AND subject_id = $2`,
      [directResourceId, userId]
    )
    try {
      const consumed = await fetch(
        `http://127.0.0.1:${gfscPort}/v1/resolve?uri=${encodeURIComponent(`gfs://main/${directResourceId}`)}`,
        { headers: { authorization: `Bearer ${minted.body.token}` } }
      )
      expect(consumed.status).toBe(403)
      expect(await consumed.text()).not.toContain(directResourceId)
    } finally {
      await controlPool!.query(
        `INSERT INTO gfs_grants (drive, resource_id, subject_type, subject_id, permissions)
         VALUES ('main', $1, 'user', $2, ARRAY['read']::text[])`,
        [directResourceId, userId]
      )
    }
  })
})
