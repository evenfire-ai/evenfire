import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import express from 'express'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { type IncomingHttpHeaders, type Server, request as httpRequest } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Pool } from 'pg'
import type { GfsKey } from '../src/services/gfsWatch/keys.js'
import { registryTestDatabase } from './helpers/gfsWatchRegistryEnv.js'
import type { BuiltRegistry, RegistryHarness, TestUser } from './helpers/gfsWatchRegistryHarness.js'
import { type Loaded, loadHelpers } from './helpers/gfsWatchRegistryLoad.js'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'
import './realPostgres.requirement.ts'

// The watch routes over HTTP, on the registry harness's real stack: sessions
// issued and authenticated by the production producers, the real limiter on
// the test database's rate_limit_buckets, the real NOTIFY path and gfsc's own
// verifier behind readGfsc. Every assertion is on what a client sees: status,
// headers, body and stream frames.

// Everything below reaches src/db.ts, which binds the core pool when first
// evaluated; it is loaded after the env helper above has pointed it at this
// suite's database.
let createRegistryHarness!: Loaded['createRegistryHarness'], quoteIdent!: Loaded['quoteIdent']
let routes!: typeof import('../src/routes/external/gfsWatch.routes.js')
let gfsRoutes!: typeof import('../src/routes/external/gfs.js')
let externalIndex!: typeof import('../src/routes/external/index.js')
let correlation!: typeof import('../src/middleware/correlationId.js')
let rateLimit!: typeof import('../src/middleware/rateLimitMiddleware.js')
let watchLimits!: typeof import('../src/middleware/externalWatchRateLimit.js')
let authn!: typeof import('../src/services/auth/externalSessionAuthentication.js')
let issuance!: typeof import('../src/services/auth/externalSessionIssuance.js')
let accessPolicy!: typeof import('../src/services/access/userAccessRuntimePolicy.js')
let sessionFailure!: typeof import('../src/services/auth/sessionDatabaseFailure.js')
let authority!: typeof import('../src/gfs/externalAuthority.js')
let watchProcess!: typeof import('../src/services/gfsWatch/process.js')
let serverModule!: typeof import('../src/server.js')
let userSessions!: typeof import('../src/services/auth/userSessionService.js')
let db!: typeof import('../src/db.js')

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip

type Frame = Record<string, unknown>
type Reply = {
  status: number
  headers: IncomingHttpHeaders
  body: unknown
  frames: Frame[]
  ended: () => boolean
  close(): void
  waitFrame(type: string, pred?: (f: Frame) => boolean, ms?: number): Promise<Frame>
}

const statuses: number[] = []

/** One HTTP call; an NDJSON 200 resolves on its head and keeps collecting frames. */
function call(
  url: string,
  method: string,
  opts: { headers?: Record<string, string>; body?: unknown; rawBody?: string } = {}
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload =
      opts.rawBody ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body))
    const req = httpRequest(
      url,
      {
        method,
        headers: {
          ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
          ...opts.headers,
        },
      },
      res => {
        statuses.push(res.statusCode ?? 0)
        const frames: Frame[] = []
        let buf = ''
        let done = false
        res.on('end', () => (done = true))
        res.on('close', () => (done = true))
        res.setEncoding('utf8')
        const streaming =
          res.statusCode === 200 &&
          String(res.headers['content-type']).startsWith('application/x-ndjson')
        res.on('data', (chunk: string) => {
          buf += chunk
          if (!streaming) return
          let i: number
          while ((i = buf.indexOf('\n')) >= 0) {
            frames.push(JSON.parse(buf.slice(0, i)) as Frame)
            buf = buf.slice(i + 1)
          }
        })
        const r: Reply = {
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: null,
          frames,
          ended: () => done,
          close: () => req.destroy(),
          async waitFrame(type, pred = () => true, ms = 5_000) {
            const start = Date.now()
            while (Date.now() - start < ms) {
              const f = frames.find(x => x.type === type && pred(x))
              if (f) return f
              await new Promise(r => setTimeout(r, 5))
            }
            throw new Error(`no ${type} frame; got ${JSON.stringify(frames)}`)
          },
        }
        if (streaming) resolve(r)
        else
          res.on('end', () => {
            try {
              r.body = buf ? (JSON.parse(buf) as unknown) : null
            } catch {
              r.body = buf
            }
            resolve(r)
          })
      }
    )
    req.on('error', reject)
    if (payload !== undefined) req.write(payload)
    req.end()
  })
}

function expectWatchError(r: Reply, status: number, code: string) {
  expect({ status: r.status, header: r.headers['x-watch-error'], body: r.body }).toEqual({
    status,
    header: code,
    body: { error: code },
  })
}

describeRealPostgres('GFS watch routes on real Postgres', () => {
  let adminPool: Pool | undefined
  let h: RegistryHarness
  let b: BuiltRegistry | undefined
  const servers: Server[] = []
  let unhandled: unknown[] = []
  const onUnhandled = (e: unknown) => unhandled.push(e)

  beforeAll(async () => {
    ;({ createRegistryHarness, quoteIdent } = await loadHelpers())
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`CREATE DATABASE ${quoteIdent(registryTestDatabase)}`)
    h = await createRegistryHarness(adminUrl!)
    routes = await import('../src/routes/external/gfsWatch.routes.js')
    gfsRoutes = await import('../src/routes/external/gfs.js')
    externalIndex = await import('../src/routes/external/index.js')
    correlation = await import('../src/middleware/correlationId.js')
    rateLimit = await import('../src/middleware/rateLimitMiddleware.js')
    watchLimits = await import('../src/middleware/externalWatchRateLimit.js')
    authn = await import('../src/services/auth/externalSessionAuthentication.js')
    issuance = await import('../src/services/auth/externalSessionIssuance.js')
    accessPolicy = await import('../src/services/access/userAccessRuntimePolicy.js')
    sessionFailure = await import('../src/services/auth/sessionDatabaseFailure.js')
    authority = await import('../src/gfs/externalAuthority.js')
    watchProcess = await import('../src/services/gfsWatch/process.js')
    serverModule = await import('../src/server.js')
    userSessions = await import('../src/services/auth/userSessionService.js')
    db = await import('../src/db.js')
    process.on('unhandledRejection', onUnhandled)
    process.on('uncaughtException', onUnhandled)
  }, 120_000)

  afterAll(async () => {
    try {
      process.off('unhandledRejection', onUnhandled)
      process.off('uncaughtException', onUnhandled)
      watchProcess?.stopGfsWatchRegistry()
      await watchProcess?.closeGfsWatchPool().catch(() => {})
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
    // The contract has no 500 on any path.
    expect(statuses.filter(s => s >= 500 && s !== 503)).toEqual([])
  })

  beforeEach(() => {
    gfsRoutes.__resetExternalGfsIngressRateLimitForTests()
  })

  afterEach(async () => {
    for (const s of servers.splice(0)) {
      s.closeAllConnections()
      await new Promise<void>(resolve => s.close(() => resolve()))
    }
    await b?.stop()
    b = undefined
    h.decisions.clear()
    expect(unhandled).toEqual([])
    unhandled = []
  })

  async function listen(app: express.Express): Promise<string> {
    const server = app.listen(0, '127.0.0.1')
    servers.push(server)
    await once(server, 'listening')
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}/external/gfs/watch`
  }

  async function mount(
    deps: Parameters<typeof routes.createExternalGfsWatchRouter>[0] = {},
    opts: { gfsRouter?: boolean; build?: Parameters<RegistryHarness['build']>[0] } = {}
  ): Promise<string> {
    b ??= await h.build(opts.build)
    const reg = b.registry
    const app = express()
    app.use(express.json())
    app.use(correlation.correlationIdMiddleware)
    app.use(routes.createExternalGfsWatchRouter({ registry: () => reg, ...deps }))
    if (opts.gfsRouter) app.use(gfsRoutes.createExternalGfsRouter())
    return listen(app)
  }

  const session = (user: TestUser, extra: Record<string, string> = {}) => ({
    'x-user-session-token': user.token,
    ...extra,
  })
  const query = (keys: GfsKey[]) =>
    keys.length === 0 ? '' : `?${keys.map(k => `k=${encodeURIComponent(k)}`).join('&')}`

  async function openReady(url: string, user: TestUser, keys: GfsKey[] = []) {
    const r = await call(`${url}${query(keys)}`, 'GET', { headers: session(user) })
    expect(r.status).toBe(200)
    const ready = await r.waitFrame('ready')
    return { r, ready, connId: ready.connId as string }
  }

  async function policyWith(
    overrides: Partial<
      import('../src/services/access/userAccessPolicy.js').EffectiveUserAccessPolicy
    >
  ) {
    return { ...(await accessPolicy.resolveEffectiveUserAccessPolicy()), ...overrides }
  }

  // ─── Happy path ──────────────────────────────────────────────────────────

  it('opens a stream and changes its set in place with a PUT routed by NOTIFY (end to end)', async () => {
    const url = await mount()
    const user = await h.createUser()
    const dir = await h.tree.add('directory')
    const file = await h.tree.add('file', dir)
    const kf = h.key('file', file)
    const kd = h.key('dir', dir)
    const { r, ready, connId } = await openReady(url, user, [kf])
    expect(r.headers['content-type']).toBe('application/x-ndjson; charset=utf-8')
    expect(r.headers['cache-control']).toBe('no-cache, no-transform')
    expect(r.headers['x-accel-buffering']).toBe('no')
    expect(r.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/)
    expect(ready).toMatchObject({
      schemaVersion: 1,
      accepted: [kf],
      rejected: [],
      deferred: [],
      heartbeatMs: b!.registry.heartbeatMs,
    })
    expect(connId).toMatch(/^[0-9a-f]{32}$/)

    const putRequestId = randomUUID()
    const put = await call(url, 'PUT', {
      headers: session(user, { 'x-request-id': putRequestId }),
      body: { connId, seq: 1, keys: [kf, kd] },
    })
    expect(put.status).toBe(202)
    expect(put.body).toEqual({ seq: 1 })
    expect(put.headers['x-watch-error']).toBeUndefined()
    const subs = await r.waitFrame('subscriptions', f => f.seq === 1)
    expect(new Set(subs.accepted as string[])).toEqual(new Set([kf, kd]))
    expect(subs.deferred).toEqual([])
    // The command carries the PUT's request id: the delta's read to gfsc uses it.
    expect(h.reads.filter(x => x.rid32 === h.toRid(dir)).map(x => x.requestId)).toEqual([
      putRequestId,
    ])
    r.close()
  })

  // The registry runs on a virtual clock here, so no heartbeat or drain timer
  // can close the connection: only the response's own close event frees it.
  it('frees the admitted connection as client_gone as soon as the client drops the stream', async () => {
    const url = await mount()
    const user = await h.createUser()
    const gone = async () =>
      (await h.modules.metrics.gfsWatchDisconnectsTotal.get()).values.find(
        v => v.labels.reason === 'client_gone'
      )?.value ?? 0
    const before = await gone()
    const { r, connId } = await openReady(url, user)
    expect(b!.registry.state.byConnId.has(connId)).toBe(true)

    r.close()
    for (let i = 0; i < 200 && b!.registry.state.byConnId.size > 0; i += 1) {
      await new Promise(x => setTimeout(x, 5))
    }
    expect(b!.registry.state.byConnId.size).toBe(0)
    expect((await gone()) - before).toBe(1)
    // The slot is free: the same user is admitted again.
    const again = await openReady(url, user)
    again.r.close()
  })

  it('accepts 64 keys in the query string', async () => {
    const url = await mount()
    const user = await h.createUser()
    const files = await Promise.all(Array.from({ length: 64 }, () => h.tree.add('file')))
    const keys = files.map(f => h.key('file', f))
    const { r, ready } = await openReady(url, user, keys)
    expect((ready.accepted as string[]).length).toBe(64)
    r.close()
  })

  // ─── Status table of the open ────────────────────────────────────────────

  it('rejects a missing, oversized, unknown or revoked session token with 401 session_invalid', async () => {
    const url = await mount()
    const user = await h.createUser()
    expectWatchError(await call(url, 'GET'), 401, 'session_invalid')
    expectWatchError(
      await call(url, 'GET', { headers: { 'x-user-session-token': 'x'.repeat(4097) } }),
      401,
      'session_invalid'
    )
    expectWatchError(
      await call(url, 'GET', { headers: { 'x-user-session-token': 'not-a-session' } }),
      401,
      'session_invalid'
    )
    await db.withTransaction(tx => userSessions.revokeAllUserSessions(user.userId, 'test', tx))
    expectWatchError(await call(url, 'GET', { headers: session(user) }), 401, 'session_invalid')
    expect(b!.registry.state.byConnId.size).toBe(0)
  })

  it('rejects a non-canonical key or a set over the ceiling with 400 bad_request', async () => {
    const url = await mount()
    const user = await h.createUser()
    expectWatchError(
      await call(`${url}?k=file:gfs://main/nothex`, 'GET', { headers: session(user) }),
      400,
      'bad_request'
    )
    const many = Array.from({ length: 65 }, () => h.key('file', randomUUID()))
    expectWatchError(
      await call(`${url}${query(many)}`, 'GET', { headers: session(user) }),
      400,
      'bad_request'
    )
    expectWatchError(
      await call(`${url}?k[a]=1`, 'GET', { headers: session(user) }),
      400,
      'bad_request'
    )
  })

  it('refuses a V2 session with 409 session_contract_unsupported', async () => {
    const policy = await policyWith({ acceptV1: true, acceptV2: true, issueV2: true })
    const url = await mount({
      authenticate: (token, options) =>
        authn.authenticateExternalUserSession(token, { ...options, policy }),
    })
    const user = await h.createUser()
    const v2 = await issuance.issueExternalUserSession(
      {
        contract: 'v2',
        userId: user.userId,
        email: `${user.userId}@example.test`,
        teamId: null,
        role: 'member',
        authenticationMethods: ['pwd'],
      },
      { policy }
    )
    expect(v2.contract).toBe('v2')
    expectWatchError(
      await call(url, 'GET', { headers: { 'x-user-session-token': v2.token } }),
      409,
      'session_contract_unsupported'
    )
    expectWatchError(
      await call(url, 'PUT', {
        headers: { 'x-user-session-token': v2.token },
        body: { connId: 'a'.repeat(32), seq: 1, keys: [] },
      }),
      409,
      'session_contract_unsupported'
    )
  })

  it('answers 426 upgrade_required below the minimum client version it reads from the header', async () => {
    const policy = await policyWith({ enforceMinimumClient: true, minimumClientVersion: '9.0.0' })
    const url = await mount({
      authenticate: (token, options) =>
        authn.authenticateExternalUserSession(token, { ...options, policy }),
    })
    const user = await h.createUser()
    expectWatchError(
      await call(url, 'GET', { headers: session(user, { 'x-evenfire-client-version': '1.0.0' }) }),
      426,
      'upgrade_required'
    )
    const ok = await call(url, 'GET', {
      headers: session(user, { 'x-evenfire-client-version': '9.0.0' }),
    })
    expect(ok.status).toBe(200)
    ok.close()
  })

  it('answers a session database outage with 503 session_backend_unavailable, Retry-After 2 and no-store', async () => {
    const dead = new Pool({
      connectionString: 'postgres://nobody@127.0.0.1:1/none',
      connectionTimeoutMillis: 500,
    })
    dead.on('error', () => {})
    try {
      const url = await mount({
        authenticate: () =>
          sessionFailure.runExternalSessionDatabaseOperation(() => dead.query('SELECT 1')),
      })
      const user = await h.createUser()
      for (const r of [
        await call(url, 'GET', { headers: session(user) }),
        await call(url, 'PUT', {
          headers: session(user),
          body: { connId: 'a'.repeat(32), seq: 1, keys: [] },
        }),
      ]) {
        expectWatchError(r, 503, 'session_backend_unavailable')
        expect(r.headers['retry-after']).toBe('2')
        expect(r.headers['cache-control']).toBe('no-store')
      }
    } finally {
      await endPoolAndWaitForClients(dead)
    }
  })

  it('turns a defect in the session, the limiter or the authority into 503 watch_reopen, never a 500 (T-SB32)', async () => {
    const user = await h.createUser()
    const defect = () => Promise.reject(new TypeError('defect'))
    const expectReopen = async (url: string) => {
      const r = await call(url, 'GET', { headers: session(user) })
      expectWatchError(r, 503, 'watch_reopen')
      expect(r.headers['retry-after']).toBe('2')
    }
    await expectReopen(await mount({ authenticate: defect }))
    await expectReopen(await mount({ openLimiter: defect }))
    await b!.stop()
    b = await h.build({ resolveAuthority: defect })
    await expectReopen(await mount())
    // The defect never leaves an admitted connection behind.
    expect(b!.registry.state.byConnId.size).toBe(0)
  })

  it('a throw while arming the deadline answers 503 watch_reopen, not the Express 500', async () => {
    const url = await mount({
      registry: () => {
        throw new TypeError('registry defect')
      },
    })
    const user = await h.createUser()
    expectWatchError(await call(url, 'GET', { headers: session(user) }), 503, 'watch_reopen')
  })

  it('a synchronous throw outside any step is caught by safe() and answers 503 watch_reopen', async () => {
    const url = await mount({
      notify: () => {
        throw new TypeError('sync defect')
      },
    })
    const user = await h.createUser()
    expectWatchError(
      await call(url, 'PUT', {
        headers: session(user),
        body: { connId: 'a'.repeat(32), seq: 1, keys: [] },
      }),
      503,
      'watch_reopen'
    )
  })

  it('passes the authority decision through: 403 desktop_user_retired, 503 gfs_authority_unavailable', async () => {
    const user = await h.createUser()
    const retired: typeof authority.resolveExternalGfsAuthorityForSession = a =>
      authority.resolveExternalGfsAuthority(a.authorityContext.userId, {
        linkingEnabled: false,
        resolveActiveLink: async () => null,
        isDesktopUserActive: async () => false,
      })
    const down: typeof authority.resolveExternalGfsAuthorityForSession = a =>
      authority.resolveExternalGfsAuthority(a.authorityContext.userId, {
        linkingEnabled: false,
        resolveActiveLink: async () => null,
        isDesktopUserActive: () => Promise.reject(new Error('lifecycle lookup failed')),
      })
    b = await h.build({ resolveAuthority: retired })
    let url = await mount()
    expectWatchError(
      await call(url, 'GET', { headers: session(user) }),
      403,
      'desktop_user_retired'
    )
    await b.stop()
    b = await h.build({ resolveAuthority: down })
    url = await mount()
    const r = await call(url, 'GET', { headers: session(user) })
    expectWatchError(r, 503, 'gfs_authority_unavailable')
    expect(r.headers['retry-after']).toBe('2')
  })

  it('answers 503 watch_listener_unavailable while the listener is down', async () => {
    const url = await mount()
    const user = await h.createUser()
    b!.registry.stop()
    const r = await call(url, 'GET', { headers: session(user) })
    expectWatchError(r, 503, 'watch_listener_unavailable')
    expect(r.headers['retry-after']).toBe('2')
    // Refused before the open limiter: a down listener does not spend the user's budget.
    const rows = await h.writer.query(`SELECT 1 FROM rate_limit_buckets WHERE bucket_key = $1`, [
      watchLimits.gfsWatchOpenBucketKey(user.userId),
    ])
    expect(rows.rowCount).toBe(0)
  })

  it('answers 503 watch_reauthorize to a retained user, 429 admission_full with Retry-After 5 past the per-user ceiling', async () => {
    const url = await mount({
      openLimiter: rateLimit.createRateLimitCheck({
        bucketType: 'external_user',
        maxPerMinute: 1_000,
        onBackendUnavailable: 'closed',
      }),
    })
    const held = await h.createUser()
    b!.registry.hold(held.userId)
    const r = await call(url, 'GET', { headers: session(held) })
    expectWatchError(r, 503, 'watch_reauthorize')
    expect(r.headers['retry-after']).toBe('2')

    const user = await h.createUser()
    const open: Reply[] = []
    for (let i = 0; i < 8; i += 1) open.push((await openReady(url, user)).r)
    const full = await call(url, 'GET', { headers: session(user) })
    expectWatchError(full, 429, 'admission_full')
    expect(full.headers['retry-after']).toBe('5')
    for (const o of open) o.close()
  })

  it('applies the open limiter per user: 429 rate_limited with its headers, 503 rate_limit_unavailable without a count', async () => {
    const url = await mount({
      openLimiter: rateLimit.createRateLimitCheck({
        ...watchLimits.externalUserStreamOpenRateLimitOptions(),
        maxPerMinute: 1,
      }),
    })
    const user = await h.createUser()
    const first = await openReady(url, user)
    const denied = await call(url, 'GET', { headers: session(user) })
    expectWatchError(denied, 429, 'rate_limited')
    expect(Number(denied.headers['retry-after'])).toBeGreaterThanOrEqual(1)
    expect(denied.headers['ratelimit-limit'] ?? denied.headers['ratelimit']).toBeDefined()
    first.r.close()

    const other = await h.createUser()
    await h.writer.query('ALTER TABLE rate_limit_buckets RENAME TO rate_limit_buckets_off')
    try {
      const r = await call(url, 'GET', { headers: session(other) })
      expectWatchError(r, 503, 'rate_limit_unavailable')
      expect(r.headers['retry-after']).toBeDefined()
      expect(r.headers['cache-control']).toBe('no-store')
    } finally {
      await h.writer.query('ALTER TABLE rate_limit_buckets_off RENAME TO rate_limit_buckets')
    }
  })

  it('answers HEAD with 405 and Allow: GET, PUT without opening a stream', async () => {
    const url = await mount()
    const user = await h.createUser()
    const r = await call(url, 'HEAD', { headers: session(user) })
    expect(r.status).toBe(405)
    expect(r.headers.allow).toBe('GET, PUT')
    expect(r.headers['x-watch-error']).toBe('method_not_allowed')
    expect(b!.registry.state.byConnId.size).toBe(0)
  })

  // ─── PUT ─────────────────────────────────────────────────────────────────

  it('validates the PUT body before authenticating: 400 bad_request', async () => {
    let authenticated = 0
    const url = await mount({
      authenticate: (token, options) => {
        authenticated += 1
        return authn.authenticateExternalUserSession(token, options)
      },
    })
    const user = await h.createUser()
    const k = h.key('file', randomUUID())
    for (const body of [
      { connId: 'A'.repeat(32), seq: 1, keys: [] },
      { connId: 'a'.repeat(31), seq: 1, keys: [] },
      { connId: 'a'.repeat(32), seq: 0, keys: [] },
      { connId: 'a'.repeat(32), seq: 1.5, keys: [] },
      { connId: 'a'.repeat(32), seq: 2 ** 53, keys: [] },
      { connId: 'a'.repeat(32), seq: 1, keys: k },
      { connId: 'a'.repeat(32), seq: 1, keys: ['file:gfs://main/zz'] },
      { connId: 'a'.repeat(32), seq: 1 },
      // Duplicates of one valid key: the client sends a set of at most 64,
      // so a longer array is refused before any per-key work.
      { connId: 'a'.repeat(32), seq: 1, keys: Array.from({ length: 65 }, () => k) },
      [],
    ]) {
      expectWatchError(await call(url, 'PUT', { headers: session(user), body }), 400, 'bad_request')
    }
    expectWatchError(
      await call(url, 'PUT', { body: { connId: 'a'.repeat(32), seq: 1, keys: [] } }),
      401,
      'session_invalid'
    )
    expect(authenticated).toBe(0)
  })

  it('accepts a PUT of 64 distinct keys, the largest set a client sends', async () => {
    const url = await mount()
    const user = await h.createUser()
    const keys = Array.from({ length: 64 }, () => h.key('file', randomUUID()))
    const r = await call(url, 'PUT', {
      headers: session(user),
      body: { connId: 'a'.repeat(32), seq: 1, keys },
    })
    expect(r.status).toBe(202)
  })

  it('charges the PUT limiter before resolving the authority (denied PUTs do no authority work)', async () => {
    let resolved = 0
    const url = await mount({
      putLimiter: rateLimit.createRateLimitCheck({
        bucketType: watchLimits.GFS_WATCH_PUT_BUCKET_TYPE,
        maxPerMinute: 1,
        onBackendUnavailable: 'closed',
      }),
      resolveAuthority: a => {
        resolved += 1
        return authority.resolveExternalGfsAuthorityForSession(a)
      },
    })
    const user = await h.createUser()
    const body = { connId: 'a'.repeat(32), seq: 1, keys: [] }
    expect((await call(url, 'PUT', { headers: session(user), body })).status).toBe(202)
    const denied = await call(url, 'PUT', { headers: session(user), body: { ...body, seq: 2 } })
    expectWatchError(denied, 429, 'rate_limited')
    expect(Number(denied.headers['retry-after'])).toBeGreaterThanOrEqual(1)
    expect(resolved).toBe(1)
  })

  it('counts PUTs in their own bucket, apart from opens', async () => {
    const url = await mount()
    const user = await h.createUser()
    const body = { connId: 'a'.repeat(32), seq: 1, keys: [] }
    expect((await call(url, 'PUT', { headers: session(user), body })).status).toBe(202)
    const rows = await h.writer.query<{ bucket_key: string }>(
      `SELECT bucket_key FROM rate_limit_buckets WHERE bucket_key LIKE $1`,
      [`user:${user.userId}:%`]
    )
    expect(rows.rows.map(x => x.bucket_key)).toEqual([
      watchLimits.gfsWatchPutBucketKey(user.userId),
    ])
    const { values } = await h.modules.metrics.rateLimitHitsTotal.get()
    expect(
      values.some(
        v => v.labels.bucket_type === watchLimits.GFS_WATCH_PUT_BUCKET_TYPE && v.value > 0
      )
    ).toBe(true)
  })

  it('passes a retired user on PUT through as 403 desktop_user_retired', async () => {
    const url = await mount({
      resolveAuthority: a =>
        authority.resolveExternalGfsAuthority(a.authorityContext.userId, {
          linkingEnabled: false,
          resolveActiveLink: async () => null,
          isDesktopUserActive: async () => false,
        }),
    })
    const user = await h.createUser()
    expectWatchError(
      await call(url, 'PUT', {
        headers: session(user),
        body: { connId: 'a'.repeat(32), seq: 1, keys: [] },
      }),
      403,
      'desktop_user_retired'
    )
  })

  it('answers 503 watch_reopen when the NOTIFY outlives the PUT deadline', async () => {
    const url = await mount({ notify: () => new Promise(() => {}), putServerDeadlineMs: 200 })
    const user = await h.createUser()
    const started = Date.now()
    const r = await call(url, 'PUT', {
      headers: session(user),
      body: { connId: 'a'.repeat(32), seq: 1, keys: [] },
    })
    expectWatchError(r, 503, 'watch_reopen')
    expect(Date.now() - started).toBeLessThan(3_000)
  })

  // A step that never settles must still lose to the server deadline. The
  // call races its own bound so a hang fails on the assertion, not on the
  // test timeout.
  async function callWithin(ms: number, ...args: Parameters<typeof call>) {
    let timer!: NodeJS.Timeout
    const bound = new Promise<'hung'>(resolve => (timer = setTimeout(() => resolve('hung'), ms)))
    try {
      return await Promise.race([call(...args), bound])
    } finally {
      clearTimeout(timer)
    }
  }
  const never = () => new Promise<never>(() => {})
  const putBody = { connId: 'a'.repeat(32), seq: 1, keys: [] }

  for (const [method, stepName, deps] of [
    ['GET', 'session', { authenticate: never, openServerDeadlineMs: 200 }],
    ['GET', 'open limiter', { openLimiter: never, openServerDeadlineMs: 200 }],
    ['PUT', 'session', { authenticate: never, putServerDeadlineMs: 200 }],
    ['PUT', 'PUT limiter', { putLimiter: never, putServerDeadlineMs: 200 }],
    ['PUT', 'authority', { resolveAuthority: never, putServerDeadlineMs: 200 }],
  ] as const) {
    it(`answers ${method} with 503 watch_reopen at the deadline when the ${stepName} never settles`, async () => {
      const url = await mount(deps)
      const user = await h.createUser()
      const started = Date.now()
      const r = await callWithin(3_000, url, method, {
        headers: session(user),
        ...(method === 'PUT' ? { body: putBody } : {}),
      })
      expect(r).not.toBe('hung')
      expectWatchError(r as Reply, 503, 'watch_reopen')
      expect((r as Reply).headers['retry-after']).toBe('2')
      expect(Date.now() - started).toBeGreaterThanOrEqual(150)
      expect(b!.registry.state.byConnId.size).toBe(0)
    })
  }

  it('a NOTIFY error is a 503 watch_reopen', async () => {
    const url = await mount({ notify: () => Promise.reject(new TypeError('defect')) })
    const user = await h.createUser()
    expectWatchError(
      await call(url, 'PUT', {
        headers: session(user),
        body: { connId: 'a'.repeat(32), seq: 1, keys: [] },
      }),
      503,
      'watch_reopen'
    )
  })

  it('a PUT for a connection the user does not own changes nothing on the stream', async () => {
    const url = await mount()
    const owner = await h.createUser()
    const intruder = await h.createUser()
    const f = await h.tree.add('file')
    const { r, connId } = await openReady(url, owner)
    const dropped = async () =>
      (await h.modules.metrics.gfsWatchCmdDroppedTotal.get()).values.find(
        v => v.labels.reason === 'binding_mismatch'
      )?.value ?? 0
    const before = await dropped()
    const put = await call(url, 'PUT', {
      headers: session(intruder),
      body: { connId, seq: 1, keys: [h.key('file', f)] },
    })
    expect(put.status).toBe(202)
    await h.barrier()
    await b!.settle()
    // The command reached the owner and was refused there, so the empty
    // stream below is the binding check's doing and not a lost NOTIFY.
    expect((await dropped()) - before).toBe(1)
    expect(r.frames.filter(x => x.type === 'subscriptions')).toEqual([])
    r.close()
  })

  // ─── Ingress, mounting ───────────────────────────────────────────────────

  async function withIngressLimit(limit: number, run: () => Promise<void>) {
    const config = h.modules.config.config
    const previous = config.externalGfsIngressRlPerMin
    config.externalGfsIngressRlPerMin = limit
    try {
      await run()
    } finally {
      config.externalGfsIngressRlPerMin = previous
    }
  }

  it('shares the ingress budget with the GFS router and charges a watch request once', async () => {
    await withIngressLimit(2, async () => {
      const url = await mount({}, { gfsRouter: true })
      const base = url.replace(/\/external\/gfs\/watch$/, '')
      // A method the watch does not serve is answered here, charged once,
      // instead of running the GFS router's session chain.
      const other = await call(url, 'POST', { body: {} })
      expectWatchError(other, 405, 'method_not_allowed')
      expect(other.headers.allow).toBe('GET, PUT')
      expectWatchError(await call(url, 'GET'), 401, 'session_invalid')
      const exhausted = await call(url, 'PUT', {
        body: { connId: 'a'.repeat(32), seq: 1, keys: [] },
      })
      expect(exhausted.status).toBe(429)
      expect(exhausted.headers['x-watch-error']).toBe('rate_limited')
      expect(exhausted.body).toMatchObject({ error: 'rate_limited' })
      expect(Number(exhausted.headers['retry-after'])).toBeGreaterThanOrEqual(1)
      const exhaustedGfs = await call(`${base}/external/gfs/not-classified`, 'GET')
      expect(exhaustedGfs.status).toBe(429)
      expect(exhaustedGfs.headers['x-watch-error']).toBeUndefined()
    })
  })

  it("answers OPTIONS with 405 Allow: GET, PUT through the ingress limiter, not with Express's automatic 200", async () => {
    await withIngressLimit(1, async () => {
      const url = await mount({}, { gfsRouter: true })
      const first = await call(url, 'OPTIONS')
      expectWatchError(first, 405, 'method_not_allowed')
      expect(first.headers.allow).toBe('GET, PUT')
      const second = await call(url, 'OPTIONS')
      expect(second.status).toBe(429)
      expect(second.headers['x-watch-error']).toBe('rate_limited')
    })
  })

  it('marks the ingress 429 on every spelling the watch route matches: trailing slash, case', async () => {
    await withIngressLimit(1, async () => {
      const url = await mount({}, { gfsRouter: true })
      expectWatchError(await call(url, 'GET'), 401, 'session_invalid')
      for (const spelling of [`${url}/`, url.replace(/watch$/, 'WATCH')]) {
        const r = await call(spelling, 'GET')
        expect(r.status).toBe(429)
        expect(r.headers['x-watch-error']).toBe('rate_limited')
        expect(r.body).toMatchObject({ error: 'rate_limited' })
      }
    })
  })

  it('mounts the watch router ahead of the GFS router', () => {
    type Layer = { handle: { stack?: Layer[] }; route?: { path: string } }
    const router = externalIndex.createExternalRouter({} as never) as unknown as {
      stack: Layer[]
    }
    const serves = (layer: Layer, path: string) =>
      (layer.handle.stack ?? []).some(inner => inner.route?.path === path)
    const watchAt = router.stack.findIndex(l => serves(l, '/external/gfs/watch'))
    const gfsAt = router.stack.findIndex(l => serves(l, '/external/gfs/token'))
    expect(watchAt).toBeGreaterThanOrEqual(0)
    expect(gfsAt).toBeGreaterThan(watchAt)
  })

  // ─── Process lifecycle ───────────────────────────────────────────────────

  /** Sets config fields for `run` and restores them after, whatever `run` does. */
  async function withConfig(
    overrides: Partial<RegistryHarness['modules']['config']['config']>,
    run: () => Promise<void>
  ) {
    const config = h.modules.config.config
    const previous = Object.fromEntries(
      Object.keys(overrides).map(k => [k, config[k as keyof typeof config]])
    )
    Object.assign(config, overrides)
    try {
      await run()
    } finally {
      Object.assign(config, previous)
    }
  }

  // The process registry is built once per module load, on the first
  // gfsWatchProcess() call, so this is the only test that can observe the
  // config it is built from. Both caps are set apart (process 2, principal 1)
  // so each 429 below is answered by exactly one of them.
  it('the process registry takes its config; shutdown closes every stream with server_shutdown and then ends the watch pool', async () => {
    await withConfig(
      {
        gfsWatchHeartbeatMs: 7_000,
        gfsWatchMaxConnections: 2,
        gfsWatchMaxConnectionsPerPrincipal: 1,
      },
      async () => {
        const proc = watchProcess.gfsWatchProcess()
        watchProcess.startGfsWatchProcess()
        for (let i = 0; i < 500 && !proc.registry.listenerReady(); i += 1) {
          await new Promise(r => setTimeout(r, 10))
        }
        expect(proc.registry.listenerReady()).toBe(true)
        // The production wiring: default dependencies, the process registry.
        const app = express()
        app.use(express.json())
        app.use(correlation.correlationIdMiddleware)
        app.use(routes.createExternalGfsWatchRouter())
        const url = await listen(app)
        const first = await h.createUser()
        const second = await h.createUser()
        const third = await h.createUser()
        const f = await h.tree.add('file')
        const { r, ready } = await openReady(url, first, [h.key('file', f)])
        expect(ready.heartbeatMs).toBe(7_000)
        // Per-principal cap: the same user's second stream, one stream open in the process.
        expectWatchError(await call(url, 'GET', { headers: session(first) }), 429, 'admission_full')
        const { r: r2 } = await openReady(url, second, [h.key('file', f)])
        // Process cap: a user with no stream open, two streams open in the process.
        expectWatchError(await call(url, 'GET', { headers: session(third) }), 429, 'admission_full')
        expect(proc.watchPool.totalCount).toBeGreaterThan(0)

        await new serverModule.ControlApiServer({} as never, 0).stop()
        for (const stream of [r, r2]) {
          const closing = await stream.waitFrame('stream.closing')
          expect(closing.reason).toBe('server_shutdown')
          for (let i = 0; i < 200 && !stream.ended(); i += 1) {
            await new Promise(x => setTimeout(x, 5))
          }
          expect(stream.ended()).toBe(true)
        }
        expect(proc.registry.state.byConnId.size).toBe(0)

        await watchProcess.closeGfsWatchPool()
        expect(proc.watchPool.totalCount).toBe(0)
        expect((proc.watchPool as unknown as { ended: boolean }).ended).toBe(true)
      }
    )
  })
})
