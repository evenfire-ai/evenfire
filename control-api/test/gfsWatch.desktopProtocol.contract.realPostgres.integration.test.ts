import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import express from 'express'
import { once } from 'node:events'
import { type IncomingHttpHeaders, type Server, request as httpRequest } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Pool } from 'pg'
import {
  errorCodeOf,
  parseFrameLine,
  parseRetryAfterMs,
} from '../../desktop-app/src/gfs/watchProtocol.js'
import type { GfsKey } from '../src/services/gfsWatch/keys.js'
import { registryTestDatabase } from './helpers/gfsWatchRegistryEnv.js'
import type { BuiltRegistry, RegistryHarness, TestUser } from './helpers/gfsWatchRegistryHarness.js'
import { type Loaded, loadHelpers } from './helpers/gfsWatchRegistryLoad.js'
import './realPostgres.requirement.ts'

// Producer ↔ consumer contract of the GFS watch. The desktop's watch client is
// tested against a scripted server; this suite is what ties that script to the
// real one. Every frame and error below is produced by the real routes and
// registry on the real stack (real sessions, limiter, NOTIFY path), read off
// the wire as bytes, and handed to the desktop's own parser — so a rename, a
// new required field, or a code spelled differently on either side turns red
// here instead of silently degrading live updates in the field.
// The desktop parser has no imports, so this relative import needs no
// desktop-app dependencies installed.

let createRegistryHarness!: Loaded['createRegistryHarness'], quoteIdent!: Loaded['quoteIdent']
let routes!: typeof import('../src/routes/external/gfsWatch.routes.js')
let correlation!: typeof import('../src/middleware/correlationId.js')
let authn!: typeof import('../src/services/auth/externalSessionAuthentication.js')
let issuance!: typeof import('../src/services/auth/externalSessionIssuance.js')
let accessPolicy!: typeof import('../src/services/access/userAccessRuntimePolicy.js')
let authority!: typeof import('../src/gfs/externalAuthority.js')
let rateLimit!: typeof import('../src/middleware/rateLimitMiddleware.js')

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip

type Stream = {
  status: number
  headers: IncomingHttpHeaders
  /** Every NDJSON line exactly as it crossed the wire, newline excluded. */
  lines: string[]
  close(): void
  waitLine(type: string, ms?: number): Promise<string>
}
type ErrorReply = { status: number; headers: IncomingHttpHeaders; bodyText: string }

function request(
  url: string,
  method: string,
  headers: Record<string, string>,
  body?: unknown
): Promise<Stream | ErrorReply> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const req = httpRequest(
      url,
      {
        method,
        headers: {
          ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
          ...headers,
        },
      },
      res => {
        res.setEncoding('utf8')
        let buf = ''
        const streaming =
          res.statusCode === 200 &&
          String(res.headers['content-type']).startsWith('application/x-ndjson')
        if (!streaming) {
          res.on('data', (c: string) => (buf += c))
          res.on('end', () =>
            resolve({ status: res.statusCode ?? 0, headers: res.headers, bodyText: buf })
          )
          return
        }
        const lines: string[] = []
        res.on('data', (c: string) => {
          buf += c
          let i: number
          while ((i = buf.indexOf('\n')) >= 0) {
            lines.push(buf.slice(0, i))
            buf = buf.slice(i + 1)
          }
        })
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          lines,
          close: () => req.destroy(),
          async waitLine(type, ms = 5_000) {
            const start = Date.now()
            while (Date.now() - start < ms) {
              const hit = lines.find(l => (JSON.parse(l) as { type?: unknown }).type === type)
              if (hit !== undefined) return hit
              await new Promise(r => setTimeout(r, 5))
            }
            throw new Error(`no ${type} line; got ${JSON.stringify(lines)}`)
          },
        })
      }
    )
    req.on('error', reject)
    if (payload !== undefined) req.write(payload)
    req.end()
  })
}

const isStream = (r: Stream | ErrorReply): r is Stream => 'lines' in r

/**
 * The desktop parses the line into a known frame and keeps every field the
 * server sent: nothing is dropped as unknown, invalid, or non-canonical.
 */
function expectDesktopParsesEveryField(line: string) {
  const { schemaVersion, ...wire } = JSON.parse(line) as Record<string, unknown>
  expect(schemaVersion).toBe(1)
  expect(parseFrameLine(line)).toEqual({ kind: 'frame', frame: wire })
}

/**
 * The client reads the GET's code from `x-watch-error` without the body and the
 * PUT's from the `{error}` body; both must decode to the code its status table
 * branches on, and a `Retry-After` must be a floor it understands.
 */
function expectDesktopDecodesError(r: ErrorReply, status: number, code: string) {
  expect(r.status).toBe(status)
  const header = r.headers['x-watch-error']
  expect(errorCodeOf({ header: typeof header === 'string' ? header : null })).toBe(code)
  expect(errorCodeOf({ bodyText: r.bodyText })).toBe(code)
  const retryAfter = r.headers['retry-after']
  if (retryAfter !== undefined) {
    expect(parseRetryAfterMs(String(retryAfter), 0)).toBe(Number(retryAfter) * 1_000)
  }
}

describeRealPostgres('GFS watch wire contract: real producer, desktop parser', () => {
  let adminPool: Pool | undefined
  let h: RegistryHarness
  let b: BuiltRegistry | undefined
  const servers: Server[] = []
  const streams: Stream[] = []

  beforeAll(async () => {
    ;({ createRegistryHarness, quoteIdent } = await loadHelpers())
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`CREATE DATABASE ${quoteIdent(registryTestDatabase)}`)
    h = await createRegistryHarness(adminUrl!)
    routes = await import('../src/routes/external/gfsWatch.routes.js')
    correlation = await import('../src/middleware/correlationId.js')
    authn = await import('../src/services/auth/externalSessionAuthentication.js')
    issuance = await import('../src/services/auth/externalSessionIssuance.js')
    accessPolicy = await import('../src/services/access/userAccessRuntimePolicy.js')
    authority = await import('../src/gfs/externalAuthority.js')
    rateLimit = await import('../src/middleware/rateLimitMiddleware.js')
  }, 120_000)

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

  afterEach(async () => {
    for (const s of streams.splice(0)) s.close()
    for (const s of servers.splice(0)) {
      s.closeAllConnections()
      await new Promise<void>(resolve => s.close(() => resolve()))
    }
    await b?.stop()
    b = undefined
    h.decisions.clear()
  })

  async function mount(
    deps: Parameters<typeof routes.createExternalGfsWatchRouter>[0] = {},
    build?: Parameters<RegistryHarness['build']>[0]
  ): Promise<string> {
    b ??= await h.build(build)
    const reg = b.registry
    const app = express()
    app.use(express.json())
    app.use(correlation.correlationIdMiddleware)
    app.use(routes.createExternalGfsWatchRouter({ registry: () => reg, ...deps }))
    const server = app.listen(0, '127.0.0.1')
    servers.push(server)
    await once(server, 'listening')
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}/external/gfs/watch`
  }

  const session = (user: TestUser, extra: Record<string, string> = {}) => ({
    'x-user-session-token': user.token,
    ...extra,
  })
  const query = (keys: GfsKey[]) => keys.map(k => `k=${encodeURIComponent(k)}`).join('&')

  async function open(url: string, user: TestUser, keys: GfsKey[]): Promise<Stream> {
    const r = await request(`${url}?${query(keys)}`, 'GET', session(user))
    if (!isStream(r)) throw new Error(`open answered ${r.status} ${r.bodyText}`)
    streams.push(r)
    return r
  }

  async function fail(r: Promise<Stream | ErrorReply>): Promise<ErrorReply> {
    const reply = await r
    if (isStream(reply)) {
      streams.push(reply)
      throw new Error('expected an error reply, got a stream')
    }
    return reply
  }

  async function policyWith(
    overrides: Partial<
      import('../src/services/access/userAccessPolicy.js').EffectiveUserAccessPolicy
    >
  ) {
    return { ...(await accessPolicy.resolveEffectiveUserAccessPolicy()), ...overrides }
  }

  async function fire() {
    await b!.advance(300)
    await b!.settle()
  }

  it('every frame type the server writes reaches the desktop parser intact', async () => {
    const url = await mount()
    const user = await h.createUser()
    const dir = await h.tree.add('directory')
    const file = await h.tree.add('file', dir)
    await h.authz.grant(dir, 'user', user.userId)
    await h.barrier()
    const kf = h.key('file', file)
    const kd = h.key('dir', dir)

    const s = await open(url, user, [kf])
    const ready = JSON.parse(await s.waitLine('ready')) as { connId: string }
    const put = await request(url, 'PUT', session(user), {
      connId: ready.connId,
      seq: 1,
      keys: [kf, kd],
    })
    expect(put.status).toBe(202)
    await s.waitLine('subscriptions')

    await h.tree.rename(file)
    await h.barrier()
    await fire()
    await s.waitLine('changed')

    await h.tree.rename(dir)
    await h.barrier()
    await fire()
    await s.waitLine('roots_changed')

    await b!.advance(b!.registry.heartbeatMs)
    await b!.settle()
    await s.waitLine('heartbeat')

    await h.lifecycle.revokeAll(user.userId)
    await h.barrier()
    await fire()
    const closing = JSON.parse(await s.waitLine('stream.closing')) as { reason: string }
    expect(closing.reason).toBe('session_expired')

    const types = s.lines.map(l => (JSON.parse(l) as { type: string }).type)
    expect(new Set(types)).toEqual(
      new Set(['ready', 'subscriptions', 'changed', 'roots_changed', 'heartbeat', 'stream.closing'])
    )
    for (const line of s.lines) expectDesktopParsesEveryField(line)
  })

  it('a reauthorize close reaches the desktop parser intact', async () => {
    const url = await mount()
    const user = await h.createUser()
    const f = await h.tree.add('file')
    const s = await open(url, user, [])
    const ready = JSON.parse(await s.waitLine('ready')) as { connId: string }
    h.decisions.set(h.toRid(f), 'principal_denied')
    await request(url, 'PUT', session(user), {
      connId: ready.connId,
      seq: 1,
      keys: [h.key('file', f)],
    })
    const closing = await s.waitLine('stream.closing')
    expect(JSON.parse(closing)).toMatchObject({ reason: 'reauthorize' })
    for (const line of s.lines) expectDesktopParsesEveryField(line)
  })

  it('the open and PUT error codes the desktop branches on decode from header and body', async () => {
    const user = await h.createUser()
    const putBody = { connId: 'a'.repeat(32), seq: 1, keys: [] }

    let url = await mount()
    expectDesktopDecodesError(await fail(request(url, 'GET', {})), 401, 'session_invalid')
    expectDesktopDecodesError(
      await fail(request(`${url}?k=file:gfs://main/nothex`, 'GET', session(user))),
      400,
      'bad_request'
    )
    expectDesktopDecodesError(
      await fail(request(url, 'PUT', session(user), { connId: 'x', seq: 0, keys: 'no' })),
      400,
      'bad_request'
    )

    const held = await h.createUser()
    b!.registry.hold(held.userId)
    expectDesktopDecodesError(
      await fail(request(url, 'GET', session(held))),
      503,
      'watch_reauthorize'
    )

    const v2Policy = await policyWith({ acceptV1: true, acceptV2: true, issueV2: true })
    url = await mount({
      authenticate: (token, options) =>
        authn.authenticateExternalUserSession(token, { ...options, policy: v2Policy }),
    })
    const v2 = await issuance.issueExternalUserSession(
      {
        contract: 'v2',
        userId: user.userId,
        email: `${user.userId}@example.test`,
        teamId: null,
        role: 'member',
        authenticationMethods: ['pwd'],
      },
      { policy: v2Policy }
    )
    for (const method of ['GET', 'PUT'] as const) {
      expectDesktopDecodesError(
        await fail(
          request(
            url,
            method,
            { 'x-user-session-token': v2.token },
            method === 'PUT' ? putBody : undefined
          )
        ),
        409,
        'session_contract_unsupported'
      )
    }

    const minPolicy = await policyWith({
      enforceMinimumClient: true,
      minimumClientVersion: '9.0.0',
    })
    url = await mount({
      authenticate: (token, options) =>
        authn.authenticateExternalUserSession(token, { ...options, policy: minPolicy }),
    })
    expectDesktopDecodesError(
      await fail(request(url, 'GET', session(user, { 'x-evenfire-client-version': '1.0.0' }))),
      426,
      'upgrade_required'
    )

    url = await mount({
      openLimiter: rateLimit.createRateLimitCheck({
        bucketType: 'external_user',
        maxPerMinute: 1_000,
        onBackendUnavailable: 'closed',
      }),
    })
    const busy = await h.createUser()
    for (let i = 0; i < 8; i += 1) {
      const s = await open(url, busy, [])
      await s.waitLine('ready')
    }
    expectDesktopDecodesError(await fail(request(url, 'GET', session(busy))), 429, 'admission_full')

    await b!.stop()
    b = undefined
    // The open resolves the authority inside the registry, the PUT in the router.
    const retired: typeof authority.resolveExternalGfsAuthorityForSession = a =>
      authority.resolveExternalGfsAuthority(a.authorityContext.userId, {
        linkingEnabled: false,
        resolveActiveLink: async () => null,
        isDesktopUserActive: async () => false,
      })
    url = await mount({ resolveAuthority: retired }, { resolveAuthority: retired })
    for (const method of ['GET', 'PUT'] as const) {
      expectDesktopDecodesError(
        await fail(request(url, method, session(user), method === 'PUT' ? putBody : undefined)),
        403,
        'desktop_user_retired'
      )
    }
  })
})
