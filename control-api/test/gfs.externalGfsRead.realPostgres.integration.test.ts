import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import express, { type NextFunction, type Request, type Response } from 'express'
import { createPublicKey, randomBytes, randomUUID } from 'node:crypto'
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
import './realPostgres.requirement.ts'

// readGfsc, the shared read-token mint and the session authority helper against
// a real gfsc (verifier, subject resolver, permission store) on real
// PostgreSQL. Sessions and tokens come from the production producers.

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

type Modules = {
  config: typeof import('../src/config.js').config
  authority: typeof import('../src/gfs/externalAuthority.js')
  read: typeof import('../src/gfs/externalGfsRead.js')
  authn: typeof import('../src/services/auth/externalSessionAuthentication.js')
  sessionMiddleware: typeof import('../src/middleware/externalSessionAuth.js')
  gfsToken: typeof import('../src/auth/gfsToken.js')
}

describeRealPostgres('external GFS typed read on real gfsc and PostgreSQL', () => {
  const database = `control_api_gfs_typed_read_${randomBytes(6).toString('hex')}`
  const connectionString = databaseUrl(
    adminUrl ?? 'postgresql://postgres@127.0.0.1/postgres',
    database
  )
  const userId = randomUUID()
  const teamId = randomUUID()
  const rootId = randomUUID()
  const grantedFileId = randomUUID()
  const grantedDirId = randomUUID()
  const ungrantedFileId = randomUUID()
  const deletedFileId = randomUUID()
  const missingId = randomUUID()
  const envKeys = [
    'CONTROL_API_PG_CONNECTION_STRING',
    'CONTROL_API_USER_ACCESS_SESSION_V2_ACCEPTANCE',
  ] as const
  const previousEnv = new Map<string, string | undefined>()
  let adminPool: Pool | undefined
  let controlPool: Pool | undefined
  let limiterPool: Pool | undefined
  let deadPool: Pool | undefined
  let gfscServer: GfsServer | undefined
  let brokenGfscServer: GfsServer | undefined
  let gfscBaseUrl = ''
  let brokenGfscBaseUrl = ''
  let mod: Modules
  let v1Token = ''
  let v2Token = ''

  function gfsServer(
    serving: GfsServingHandler,
    publicKey: string,
    configModule: Modules['config']
  ) {
    return new GfsServer(
      {
        port: 0,
        storageMountPath: '/unused-in-read-test',
        storageRole: 'reader',
        pgConnectionString: connectionString,
        tokenAudience: configModule.gfsTokenAudience,
        publicKey,
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
  }

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
    const userSessions = await import('../src/services/auth/userSessionService.js')
    const issuance = await import('../src/services/auth/externalSessionIssuance.js')
    mod = {
      config: configModule.config,
      authority: await import('../src/gfs/externalAuthority.js'),
      read: await import('../src/gfs/externalGfsRead.js'),
      authn: await import('../src/services/auth/externalSessionAuthentication.js'),
      sessionMiddleware: await import('../src/middleware/externalSessionAuth.js'),
      gfsToken: await import('../src/auth/gfsToken.js'),
    }

    await controlPool.query(
      `INSERT INTO users (id, email, name) VALUES ($1, $2, 'gfs-typed-read-test')`,
      [userId, `${userId}@example.test`]
    )
    await controlPool.query(`INSERT INTO teams (id, name) VALUES ($1, 'gfs-typed-read-team')`, [
      teamId,
    ])
    await controlPool.query(
      `INSERT INTO team_members (team_id, user_id, role, status)
       VALUES ($1, $2, 'member', 'active')`,
      [teamId, userId]
    )
    await dbModule.withTransaction(db =>
      userSessions.revokeAllUserSessions(userId, 'gfs-typed-read-fixture', db)
    )
    await controlPool.query(
      `INSERT INTO gfs_resources (resource_id, drive, name, kind, path_cache)
       VALUES ($1, 'main', 'root', 'directory', '/')`,
      [rootId]
    )
    await controlPool.query(
      `INSERT INTO gfs_resources
         (resource_id, drive, parent_resource_id, name, kind, path_cache)
       VALUES ($1, 'main', $5, 'granted.txt', 'file', '/granted.txt'),
              ($2, 'main', $5, 'granted', 'directory', '/granted'),
              ($3, 'main', $5, 'ungranted.txt', 'file', '/ungranted.txt'),
              ($4, 'main', $5, 'deleted.txt', 'file', '/deleted.txt')`,
      [grantedFileId, grantedDirId, ungrantedFileId, deletedFileId, rootId]
    )
    await controlPool.query(
      `INSERT INTO gfs_grants (drive, resource_id, subject_type, subject_id, permissions)
       VALUES ('main', $1, 'user', $4, ARRAY['read']::text[]),
              ('main', $2, 'user', $4, ARRAY['read']::text[]),
              ('main', $3, 'user', $4, ARRAY['read']::text[])`,
      [grantedFileId, grantedDirId, deletedFileId, userId]
    )
    await controlPool.query(`UPDATE gfs_resources SET deleted_at = now() WHERE resource_id = $1`, [
      deletedFileId,
    ])

    const policy = {
      issueV1: true,
      acceptV1: true,
      issueV2: false,
      acceptV2: true,
    } as import('../src/services/access/userAccessPolicy.js').EffectiveUserAccessPolicy
    v1Token = (
      await issuance.issueExternalUserSession(
        {
          contract: 'v1',
          userId,
          email: `${userId}@example.test`,
          teamId,
          role: 'member',
          authenticationMethods: ['pwd'],
        },
        { policy }
      )
    ).token
    v2Token = (
      await dbModule.withTransaction(db =>
        userSessions.createUserSession(
          { userId, email: `${userId}@example.test`, authenticationMethods: ['pwd'] },
          { db }
        )
      )
    ).token

    const publicKey = String(
      createPublicKey(configModule.config.rpcJwtPrivateKey).export({ type: 'spki', format: 'pem' })
    )
    const verificationKey = loadVerificationKey(publicKey)
    const verifyToken = (token: string) =>
      verifyGfsToken(token, {
        key: verificationKey,
        audience: configModule.config.gfsTokenAudience,
        issuer: configModule.config.rpcJwtIssuer,
      })
    const permissions = new PermissionClient(
      controlPool as never,
      new DbAuditSink(controlPool as never)
    )
    const servingDeps = {
      verifyToken,
      authorize: (context: never, resourceId: string, operation: never) =>
        permissions.authorize(context, resourceId, operation),
      store: new PgResourceStore(controlPool as never),
      blobs: { read: async () => Readable.from([]) },
      rateLimit: {
        reads: { check: () => undefined, limitPerWindow: 1 },
        writes: { check: () => undefined, limitPerWindow: 1 },
      },
    }
    gfscServer = gfsServer(
      new GfsServingHandler({
        ...servingDeps,
        resolveContext: (claims, requestId) =>
          resolveAuthzContext(controlPool as never, claims, requestId),
      } as never),
      publicKey,
      configModule.config
    )
    gfscBaseUrl = `http://127.0.0.1:${await gfscServer.start()}`

    // A gfsc whose permission store is unreachable: its subject resolver fails
    // on a real refused connection and gfsc answers with its own 5xx.
    const refusedUrl = new URL(adminUrl)
    refusedUrl.hostname = '127.0.0.1'
    refusedUrl.port = '1'
    deadPool = new Pool({ connectionString: refusedUrl.toString(), connectionTimeoutMillis: 2_000 })
    deadPool.on('error', () => {})
    brokenGfscServer = gfsServer(
      new GfsServingHandler({
        ...servingDeps,
        resolveContext: (claims, requestId) =>
          resolveAuthzContext(deadPool as never, claims, requestId),
      } as never),
      publicKey,
      configModule.config
    )
    brokenGfscBaseUrl = `http://127.0.0.1:${await brokenGfscServer.start()}`
    configModule.config.gfscBaseUrl = gfscBaseUrl
  }, 60_000)

  afterAll(async () => {
    try {
      await gfscServer?.stop()
      await brokenGfscServer?.stop()
      for (const key of envKeys) {
        const value = previousEnv.get(key)
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      await endPoolAndWaitForClients(controlPool)
      await endPoolAndWaitForClients(limiterPool)
      await endPoolAndWaitForClients(deadPool)
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

  async function authenticated(token: string) {
    const authentication = await mod.authn.authenticateExternalUserSession(token, {
      purpose: 'protected',
    })
    if (authentication.status !== 'authenticated') {
      throw new Error(`session producer did not authenticate: ${authentication.status}`)
    }
    return authentication
  }

  async function readToken(token: string): Promise<string> {
    const authentication = await authenticated(token)
    const authority = await mod.authority.resolveExternalGfsAuthorityForSession(authentication)
    const minted = await mod.read.mintExternalGfsReadToken(authentication, authority, 'main')
    if (!minted) throw new Error('mint refused a current session')
    return minted.token
  }

  function read(resourceId: string, token: string, timeoutMs = 5_000) {
    return mod.read.readGfsc(
      resourceId,
      token,
      randomUUID(),
      new AbortController().signal,
      timeoutMs
    )
  }

  it.each([
    ['v1', () => v1Token],
    ['v2', () => v2Token],
  ])('returns the raw gfsc kind for a granted file and directory (%s session)', async (_, t) => {
    const token = await readToken(t())
    expect(await read(grantedFileId, token)).toEqual({
      status: '2xx',
      kind: 'file',
      principalDenied: false,
      responded: true,
    })
    expect(await read(grantedDirId.replaceAll('-', ''), token)).toEqual({
      status: '2xx',
      kind: 'directory',
      principalDenied: false,
      responded: true,
    })
  })

  it('maps the permission store denial to 403 without principalDenied', async () => {
    expect(await read(ungrantedFileId, await readToken(v1Token))).toEqual({
      status: 403,
      principalDenied: false,
      responded: true,
    })
  })

  it('maps a missing and a deleted resource as gfsc answers them: authorization first', async () => {
    // gfsc authorizes before it looks the resource up, and its permission
    // store ignores tombstoned rows, so neither case reaches 404/410 for a
    // user read; both are a plain denial.
    const token = await readToken(v1Token)
    for (const resourceId of [missingId, deletedFileId]) {
      expect(await read(resourceId, token)).toEqual({
        status: 403,
        principalDenied: false,
        responded: true,
      })
    }
  })

  it('maps a token gfsc cannot verify to 401', async () => {
    const token = await readToken(v1Token)
    const [header, payload, signature] = token.split('.')
    const flipped = `${signature!.slice(0, -2)}${signature!.endsWith('AA') ? 'BB' : 'AA'}`
    expect(await read(grantedFileId, `${header}.${payload}.${flipped}`)).toEqual({
      status: 401,
      principalDenied: false,
      responded: true,
    })
  })

  it('maps a principal gfsc denies to 403 with principalDenied', async () => {
    const lifecycle = await controlPool!.query<{ lifecycle_version: number | string }>(
      `SELECT lifecycle_version FROM users WHERE id = $1`,
      [userId]
    )
    const stale = mod.gfsToken.signGfsToken({
      subject: userId,
      drive: 'main',
      scopes: ['gfs.read'],
      authGeneration: Number(lifecycle.rows[0]?.lifecycle_version) + 1,
      principalType: 'user',
    })
    expect(await read(grantedFileId, stale.token)).toEqual({
      status: 403,
      principalDenied: true,
      responded: true,
    })
  })

  it('maps a gfsc 5xx to transient with a response', async () => {
    const token = await readToken(v1Token)
    mod.config.gfscBaseUrl = brokenGfscBaseUrl
    try {
      const result = await read(grantedFileId, token)
      expect(result).toMatchObject({ status: 'transient', principalDenied: false, responded: true })
      expect((result as { httpStatus?: number }).httpStatus).toBeGreaterThanOrEqual(500)
    } finally {
      mod.config.gfscBaseUrl = gfscBaseUrl
    }
  })

  it('refuses to mint for a revoked V2 session instead of signing', async () => {
    const userSessions = await import('../src/services/auth/userSessionService.js')
    const { withTransaction } = await import('../src/db.js')
    const issued = await withTransaction(db =>
      userSessions.createUserSession(
        { userId, email: `${userId}@example.test`, authenticationMethods: ['pwd'] },
        { db }
      )
    )
    const authentication = await authenticated(issued.token)
    const authority = await mod.authority.resolveExternalGfsAuthorityForSession(authentication)
    await withTransaction(db =>
      userSessions.revokeUserSession(userId, issued.identity.sid, 'logout', db)
    )
    expect(await mod.read.mintExternalGfsReadToken(authentication, authority, 'main')).toBeNull()
  })

  describe('attachExternalGfsAuthority keeps its pre-helper result', () => {
    // The middleware as it read the authority before it delegated to
    // resolveExternalGfsAuthorityForSession: user id and generation from the
    // request claims. It is the reference the migrated middleware must match.
    async function claimsBasedAttach(req: Request, res: Response, next: NextFunction) {
      const claims = (
        req as Request & { externalAuth?: { userId?: string; authGeneration?: number } }
      ).externalAuth
      if (!claims?.userId) {
        res.status(401).json({ error: 'unauthenticated' })
        return
      }
      try {
        const authority = await mod.authority.resolveExternalGfsAuthority(claims.userId)
        if (authority.kind === 'user-session' && claims.authGeneration !== undefined) {
          authority.authGeneration = claims.authGeneration
        }
        ;(req as Request & { gfsAuthority?: unknown }).gfsAuthority = authority
        next()
      } catch (error) {
        next(error)
      }
    }

    function appWith(attach: (req: Request, res: Response, next: NextFunction) => Promise<void>) {
      const app = express()
      app.get(
        '/authority',
        mod.sessionMiddleware.requireValidExternalSessionToken,
        (req, res, next) => void attach(req, res, next),
        (req, res) => {
          res.json((req as Request & { gfsAuthority?: unknown }).gfsAuthority ?? null)
        }
      )
      return app
    }

    it.each([
      ['v1', () => v1Token, true],
      ['v2', () => v2Token, false],
    ])('%s session', async (_, t, carriesGeneration) => {
      const reference = await request(appWith(claimsBasedAttach))
        .get('/authority')
        .set('x-user-session-token', t())
      const migrated = await request(appWith(mod.authority.attachExternalGfsAuthority))
        .get('/authority')
        .set('x-user-session-token', t())
      expect(reference.status).toBe(200)
      expect(migrated.status).toBe(200)
      expect(migrated.body).toEqual(reference.body)
      expect(migrated.body).toMatchObject({ kind: 'user-session', desktopUserId: userId })
      expect('authGeneration' in migrated.body).toBe(carriesGeneration)
    })

    it('answers 401 without an authenticated session, as before', async () => {
      const app = express()
      app.get(
        '/authority',
        (req, res, next) => void mod.authority.attachExternalGfsAuthority(req, res, next)
      )
      const response = await request(app).get('/authority')
      expect(response.status).toBe(401)
      expect(response.body).toEqual({ error: 'unauthenticated' })
    })
  })
})
