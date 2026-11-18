import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import express from 'express'
import { once } from 'node:events'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Pool } from 'pg'
import { registryTestDatabase } from './helpers/gfsWatchRegistryEnv.js'
import type { BuiltRegistry, RegistryHarness } from './helpers/gfsWatchRegistryHarness.js'
import { type Loaded, loadHelpers } from './helpers/gfsWatchRegistryLoad.js'
import { type OpenedWatch, openWatch } from './helpers/watchHttp.js'
import './realPostgres.requirement.ts'

// Session currentness of the external user streams, on real PostgreSQL. The
// observer is read-only: it re-reads the authority the initial verifier
// accepted and must never touch the session row. Its decisions are proven
// twice: directly over every representation it supports, and through
// GET /external/gfs/watch, which observes again once the stream is admitted.
// Sessions are issued, renewed and revoked by the production producers.

// Everything below reaches src/db.ts, which binds the core pool when first
// evaluated; it is loaded after the env helper above has pointed it at this
// suite's database.
let createRegistryHarness!: Loaded['createRegistryHarness'], quoteIdent!: Loaded['quoteIdent']
let observer!: typeof import('../src/services/auth/externalSessionCurrentnessObserver.js')
let authn!: typeof import('../src/services/auth/externalSessionAuthentication.js')
let issuance!: typeof import('../src/services/auth/externalSessionIssuance.js')
let userSessions!: typeof import('../src/services/auth/userSessionService.js')
let routes!: typeof import('../src/routes/external/gfsWatch.routes.js')
let correlation!: typeof import('../src/middleware/correlationId.js')
let db!: typeof import('../src/db.js')

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip

type Policy = import('../src/services/access/userAccessPolicy.js').EffectiveUserAccessPolicy
const policy = {
  policyVersion: '1',
  policyRevision: 'currentness-test',
  acceptV1: true,
  issueV1: true,
  acceptV2: true,
  issueV2: true,
  renewV2: true,
  switchCompatibility: true,
  minimumClientVersion: null,
  enforceMinimumClient: false,
} as Policy

describeRealPostgres('external stream session currentness on real PostgreSQL', () => {
  let adminPool: Pool | undefined
  let h: RegistryHarness
  let b: BuiltRegistry | undefined
  const servers: Server[] = []
  const opened: OpenedWatch[] = []

  beforeAll(async () => {
    ;({ createRegistryHarness, quoteIdent } = await loadHelpers())
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`CREATE DATABASE ${quoteIdent(registryTestDatabase)}`)
    h = await createRegistryHarness(adminUrl!)
    observer = await import('../src/services/auth/externalSessionCurrentnessObserver.js')
    authn = await import('../src/services/auth/externalSessionAuthentication.js')
    issuance = await import('../src/services/auth/externalSessionIssuance.js')
    userSessions = await import('../src/services/auth/userSessionService.js')
    routes = await import('../src/routes/external/gfsWatch.routes.js')
    correlation = await import('../src/middleware/correlationId.js')
    db = await import('../src/db.js')
  }, 120_000)

  afterEach(async () => {
    for (const o of opened.splice(0)) o.close()
    for (const s of servers.splice(0)) {
      s.closeAllConnections()
      await new Promise<void>(resolve => s.close(() => resolve()))
    }
    await b?.stop()
    b = undefined
  })

  afterAll(async () => {
    try {
      await h?.teardown()
      if (adminPool) {
        await adminPool.query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
            WHERE datname = $1 AND pid <> pg_backend_pid()`,
          [registryTestDatabase]
        )
        await adminPool.query(`DROP DATABASE IF EXISTS ${quoteIdent(registryTestDatabase)}`)
      }
    } finally {
      await adminPool?.end()
    }
  })

  async function authenticate(token: string) {
    const result = await authn.authenticateExternalUserSession(token, {
      purpose: 'protected',
      policy,
    })
    if (result.status !== 'authenticated') {
      throw new Error(`test producer failed to authenticate: ${result.status}`)
    }
    return result
  }

  const observe = (authentication: unknown, sessionDb: Pick<Pool, 'query'> = h.writer) =>
    observer.observeExternalSessionCurrentness(authentication as never, { db: sessionDb } as never)

  async function generationOf(userId: string): Promise<number> {
    const r = await h.writer.query<{ v: string }>(
      `SELECT lifecycle_version::text AS v FROM users WHERE id = $1`,
      [userId]
    )
    return Number(r.rows[0]?.v)
  }

  async function mount(
    deps: Parameters<typeof routes.createExternalGfsWatchRouter>[0] = {},
    build: Parameters<RegistryHarness['build']>[0] = {}
  ): Promise<string> {
    b = await h.build(build)
    const reg = b.registry
    const app = express()
    app.use(correlation.correlationIdMiddleware)
    app.use(routes.createExternalGfsWatchRouter({ registry: () => reg, ...deps }))
    const server = app.listen(0, '127.0.0.1')
    servers.push(server)
    await once(server, 'listening')
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}/external/gfs/watch`
  }

  async function open(url: string, token: string): Promise<OpenedWatch> {
    const o = await openWatch(url, { 'x-user-session-token': token })
    opened.push(o)
    return o
  }

  const unavailableDb = {
    query: async () => {
      const error = new Error('connection refused') as Error & { code: string }
      error.code = 'ECONNREFUSED'
      throw error
    },
  }

  // ─── The observer ────────────────────────────────────────────────────────

  it('keeps an authenticated V2 session current above lifecycle generation one, without touching its row', async () => {
    const user = await h.createUser()
    const email = `${user.userId}@example.test`
    const create = () =>
      db.withTransaction(tx =>
        userSessions.createUserSession(
          { userId: user.userId, email, authenticationMethods: ['pwd'] },
          { db: tx }
        )
      )
    const sessionA = await create()
    const sessionB = await create()
    const authenticationA = await authenticate(sessionA.token)
    const authenticationB = await authenticate(sessionB.token)
    expect(await generationOf(user.userId)).toBeGreaterThan(1)
    expect(authenticationB.contract).toBe('v2')

    const rowOf = (sid: string) =>
      h.writer.query(
        `SELECT last_used_at, idle_expires_at, current_jti, session_version, revoked_at
           FROM external_user_sessions WHERE sid = $1`,
        [sid]
      )
    const beforeObserve = await rowOf(sessionB.identity.sid)
    await expect(observe(authenticationB)).resolves.toMatchObject({ status: 'current' })
    expect((await rowOf(sessionB.identity.sid)).rows[0]).toEqual(beforeObserve.rows[0])

    await db.withTransaction(tx =>
      userSessions.revokeUserSession(user.userId, sessionA.identity.sid, 'individual_logout', tx)
    )
    await expect(observe(authenticationA)).resolves.toMatchObject({ status: 'denied' })
    await expect(observe(authenticationB)).resolves.toMatchObject({ status: 'current' })

    const renewed = await db.withTransaction(tx =>
      userSessions.renewUserSession(
        authenticationB.tokenClaims as import('../src/utils/auth/userSessionV2Token.js').UserSessionV2Claims,
        { db: tx }
      )
    )
    if (!('token' in renewed)) throw new Error('real producer did not renew the V2 session')
    const successor = await authenticate(renewed.token)
    await expect(observe(authenticationB)).resolves.toMatchObject({ status: 'current' })

    await h.writer.query(
      `UPDATE external_user_sessions
          SET prior_jti_expires_at = clock_timestamp() - interval '1 second'
        WHERE sid = $1`,
      [sessionB.identity.sid]
    )
    await expect(observe(authenticationB)).resolves.toMatchObject({
      status: 'denied',
      reason: 'v2_representation_superseded',
    })
    await expect(observe(successor)).resolves.toMatchObject({ status: 'current' })

    await db.withTransaction(tx =>
      userSessions.revokeAllUserSessions(user.userId, 'revoke_all', tx)
    )
    await expect(observe(successor)).resolves.toMatchObject({ status: 'denied' })
  })

  it('keeps a V1 session current at the new generation and observes fingerprint logout', async () => {
    const user = await h.createUser()
    const representation = await db.withTransaction(tx =>
      issuance.issueExternalUserSession(
        {
          contract: 'v1',
          userId: user.userId,
          email: `${user.userId}@example.test`,
          teamId: user.teamId,
          role: 'member',
          authenticationMethods: ['pwd'],
        },
        { db: tx, policy }
      )
    )
    const authentication = await authenticate(representation.token)
    expect(authentication.contract).toBe('v1')
    expect(await generationOf(user.userId)).toBeGreaterThan(1)
    await expect(observe(authentication)).resolves.toMatchObject({ status: 'current' })
    await db.withTransaction(tx =>
      userSessions.revokeLegacyUserSession(
        representation.token,
        authentication.tokenClaims as never,
        'individual_logout',
        tx
      )
    )
    await expect(observe(authentication)).resolves.toMatchObject({
      status: 'denied',
      reason: 'legacy_representation_revoked',
    })
  })

  it('classifies only a database transport failure as unavailable', async () => {
    const user = await h.createUser()
    const authentication = await user.authenticate()
    await expect(observe(authentication, unavailableDb as never)).resolves.toMatchObject({
      status: 'unavailable',
    })
  })

  // ─── Through /external/gfs/watch ─────────────────────────────────────────

  it('opens the watch for a V1 session above generation one: the admission observation is current', async () => {
    const url = await mount()
    const user = await h.createUser()
    expect(await generationOf(user.userId)).toBeGreaterThan(1)
    const o = await open(url, user.token)
    expect(o.status).toBe(200)
    expect(o.firstFrame).toMatchObject({ type: 'ready' })
  })

  it('refuses the watch with 401 when the V1 session is logged out between authentication and admission', async () => {
    // The real verifier accepts the token; the fingerprint logout commits
    // before the registry admits the stream, so only the observer can see it.
    const url = await mount({
      authenticate: async (token, options) => {
        const accepted = await authn.authenticateExternalUserSession(token, options)
        if (accepted.status === 'authenticated') {
          await db.withTransaction(tx =>
            userSessions.revokeLegacyUserSession(
              token,
              accepted.tokenClaims as never,
              'individual_logout',
              tx
            )
          )
        }
        return accepted
      },
    })
    const user = await h.createUser()
    const o = await open(url, user.token)
    expect({ status: o.status, header: o.headers['x-watch-error'], body: o.body }).toEqual({
      status: 401,
      header: 'session_invalid',
      body: { error: 'session_invalid' },
    })
    expect(b!.registry.state.byConnId.size).toBe(0)
  })

  it('answers the watch 503 session_backend_unavailable when the admission observation cannot reach its database', async () => {
    const url = await mount(
      {},
      {
        observeCurrentness: a =>
          observer.observeExternalSessionCurrentness(a, { db: unavailableDb as never }),
      }
    )
    const user = await h.createUser()
    const o = await open(url, user.token)
    expect({ status: o.status, header: o.headers['x-watch-error'], body: o.body }).toEqual({
      status: 503,
      header: 'session_backend_unavailable',
      body: { error: 'session_backend_unavailable' },
    })
    expect(o.headers['retry-after']).toBe('2')
    expect(o.headers['cache-control']).toBe('no-store')
    expect(b!.registry.state.byConnId.size).toBe(0)
  })
})
