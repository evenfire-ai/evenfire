import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { once } from 'node:events'
import {
  type IncomingHttpHeaders,
  type RequestListener,
  type Server,
  createServer,
  request as httpRequest,
} from 'node:http'
import type { AddressInfo } from 'node:net'
import { performance } from 'node:perf_hooks'
// control-api's config needs its signing keys before its modules are loaded below.
import '../../control-api/test/jwtKeys.setup.ts'
import { createApp } from '../src/app.js'
import { config } from '../src/config.js'

// The aggregate bucket is set just above the per-IP one so that a watch request
// charged to it would be observable within one test.
vi.hoisted(() => {
  process.env.EXTERNAL_REST_API_GFS_EDGE_AGGREGATE_RL_PER_MIN = '260'
  process.env.EXTERNAL_REST_API_GFS_EDGE_AUTHENTICATED_IP_RL_PER_MIN = '250'
  process.env.EXTERNAL_REST_API_GFS_EDGE_TOKEN_IP_RL_PER_MIN = '10'
})

// The edge verifies the session locally; only that check is replaced, so the
// whole app (global middleware, routers, client, global handler) runs as built.
vi.mock('../src/authToken.js', () => ({
  verifyToken: (token: string) => {
    const userId = { 'test-token-u1': USER_1, 'test-token-u2': USER_2 }[token]
    return userId
      ? {
          userId,
          email: 'user@example.invalid',
          teamId: null,
          role: 'member',
          exp: 9_999_999_999,
          sessionContract: 'v1',
        }
      : null
  },
}))

const { USER_1, USER_2 } = vi.hoisted(() => ({
  USER_1: '11111111-1111-4111-8111-111111111111',
  USER_2: '22222222-2222-4222-8222-222222222222',
}))

const KEY_1 = `file:gfs://drive-a/${'a'.repeat(32)}`
const KEY_2 = `dir:gfs://drive-a/${'b'.repeat(32)}`
const KEY_3 = `file:gfs://drive-b/${'c'.repeat(32)}`
const CONN_ID = 'f'.repeat(32)

type Reply = {
  status: number
  headers: IncomingHttpHeaders
  body: unknown
  firstLine: string | null
  close(): void
}
type Recorded = { method: string; url: string; headers: IncomingHttpHeaders }
type RawUpstream = { status: number; headers?: Record<string, string>; body?: string }

/**
 * What the real control-api watch router is given in place of its session,
 * registry, limiter, authority and NOTIFY backends. Its own reply writer,
 * classification and method handling run unchanged.
 */
type Scenario = {
  auth: unknown
  listenerReady: boolean
  openReply?: { status: 503 | 429 | 400 | 401; code: string; retryAfterSec?: number }
  limit: unknown
  authorityError?: unknown
  raw?: RawUpstream
  /** Holds the open's 200 back, as a slow open op would. */
  openDelayMs?: number
  /** Puts control-api's own service-credential gate in front of the watch router. */
  serviceGate?: boolean
  /** Hands this error to control-api's global error handler before the watch router runs. */
  thrown?: unknown
}

/** The upstream side of the last stream the fake registry opened. */
const upstreamStream = { opened: 0, goneAt: null as number | null }

function defaultScenario(): Scenario {
  return {
    auth: authenticated(USER_1),
    listenerReady: true,
    limit: { outcome: 'allowed', limit: 10_000, remaining: 9_999, resetMs: 60_000 },
  }
}

function authenticated(userId: string, contract = 'v1') {
  return {
    status: 'authenticated',
    contract,
    authorityContext: { contract, userId, authGeneration: 1 },
  }
}

const eraStatuses: number[] = []

function call(
  url: string,
  method: string,
  opts: { headers?: Record<string, string>; body?: unknown; record?: boolean } = {}
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body)
    const req = httpRequest(
      url,
      {
        method,
        headers: {
          ...(payload === undefined
            ? {}
            : {
                'content-type': 'application/json',
                'content-length': String(Buffer.byteLength(payload)),
              }),
          ...opts.headers,
        },
      },
      res => {
        if (opts.record !== false) eraStatuses.push(res.statusCode ?? 0)
        let buf = ''
        res.setEncoding('utf8')
        const streaming =
          res.statusCode === 200 &&
          String(res.headers['content-type']).startsWith('application/x-ndjson')
        const reply: Reply = {
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: null,
          firstLine: null,
          close: () => req.destroy(),
        }
        res.on('data', (chunk: string) => {
          buf += chunk
          const i = buf.indexOf('\n')
          if (streaming && i >= 0 && reply.firstLine === null) {
            reply.firstLine = buf.slice(0, i)
            resolve(reply)
          }
        })
        res.on('error', () => {})
        if (!streaming) {
          res.on('end', () => {
            try {
              reply.body = buf ? (JSON.parse(buf) as unknown) : null
            } catch {
              reply.body = buf
            }
            resolve(reply)
          })
        }
      }
    )
    req.on('error', reject)
    if (payload !== undefined) req.write(payload)
    req.end()
  })
}

async function listen(handler: RequestListener | express.Express): Promise<Server> {
  const server = createServer(handler as RequestListener)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return server
}

function urlOf(server: Server): string {
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections()
  await new Promise<void>(resolve => server.close(() => resolve()))
}

function watchError(r: Reply) {
  return { status: r.status, header: r.headers['x-watch-error'], body: r.body }
}

describe('GFS watch through external-rest-api', () => {
  const originalControlApiBaseUrl = config.controlApiBaseUrl
  let scenario: Scenario = defaultScenario()
  const upstreamRequests: Recorded[] = []
  let redirectTargetHits = 0
  let upstream: Server
  let era: Server
  let resetIngress: () => void

  beforeAll(async () => {
    const watchRoutes = await import('../../control-api/src/routes/external/gfsWatch.routes.js')
    const gfsRoutes = await import('../../control-api/src/routes/external/gfs.js')
    const authority = await import('../../control-api/src/gfs/externalAuthority.js')
    const { requireInternalToken, requireInternalService } =
      await import('../../control-api/src/middleware/internalServiceAuth.js')
    const { clerumErrorHandler } = await import('../../control-api/src/http/errorHandler.js')
    const { RegistryUnavailableError } =
      await import('../../control-api/src/services/registryClient.js')
    ;(globalThis as { __registryUnavailable?: unknown }).__registryUnavailable =
      RegistryUnavailableError
    resetIngress = gfsRoutes.__resetExternalGfsIngressRateLimitForTests
    ;(globalThis as { __watchAuthority?: unknown }).__watchAuthority = authority

    const app = express()
    app.use((req, _res, next) => {
      upstreamRequests.push({ method: req.method, url: req.originalUrl, headers: req.headers })
      next()
    })
    app.get('/redirect-target', (_req, res) => {
      redirectTargetHits += 1
      res.status(200).json({ ok: true })
    })
    app.use((req, res, next) => {
      const raw = scenario.raw
      if (!raw || req.path === '/redirect-target') return next()
      req.resume()
      res.statusCode = raw.status
      for (const [name, value] of Object.entries(raw.headers ?? {})) res.setHeader(name, value)
      res.end(raw.body ?? '')
    })
    app.use((req, _res, next) => {
      if (scenario.thrown === undefined) return next()
      req.resume()
      next(scenario.thrown)
    })
    // The gates control-api's app mounts ahead of every /external route.
    app.use((req, res, next) =>
      scenario.serviceGate ? requireInternalToken(req, res, next) : next()
    )
    app.use('/external', (req, res, next) =>
      scenario.serviceGate ? requireInternalService('external-rest-api')(req, res, next) : next()
    )
    app.use(express.json())
    app.use(
      watchRoutes.createExternalGfsWatchRouter({
        authenticate: (async () => scenario.auth) as never,
        registry: (() => ({
          listenerReady: () => scenario.listenerReady,
          now: () => performance.now(),
          open: async ({
            socket,
          }: {
            socket: {
              writeHead(s: number, h: Record<string, string>): void
              write(c: string): void
              onGone(listener: () => void): void
            }
          }) => {
            if (scenario.openReply) return { kind: 'reply', ...scenario.openReply }
            upstreamStream.opened += 1
            let gone = false
            socket.onGone(() => {
              if (gone) return
              gone = true
              upstreamStream.goneAt = performance.now()
            })
            if (scenario.openDelayMs) {
              await new Promise(r => setTimeout(r, scenario.openDelayMs))
              if (gone) return { kind: 'none' }
            }
            socket.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8' })
            socket.write(`${JSON.stringify({ type: 'ready', schemaVersion: 1 })}\n`)
            return { kind: 'stream' }
          },
        })) as never,
        openLimiter: async () => scenario.limit as never,
        putLimiter: async () => scenario.limit as never,
        resolveAuthority: (async () => {
          if (scenario.authorityError) throw scenario.authorityError
          return {}
        }) as never,
        notify: async () => undefined,
      })
    )
    app.use(
      (err: unknown, req: express.Request, res: express.Response, next: express.NextFunction) =>
        scenario.thrown === undefined ? next(err) : clerumErrorHandler(err, req, res, next)
    )
    upstream = await listen(app)
    config.controlApiBaseUrl = urlOf(upstream)
  })

  beforeEach(async () => {
    scenario = defaultScenario()
    upstreamStream.opened = 0
    upstreamStream.goneAt = null
    upstreamRequests.length = 0
    redirectTargetHits = 0
    resetIngress()
    era = await listen(createApp())
  })

  afterEach(async () => {
    config.controlApiBaseUrl = urlOf(upstream)
    await close(era)
  })

  afterAll(async () => {
    config.controlApiBaseUrl = originalControlApiBaseUrl
    await close(upstream)
    // No path of the watch answers 500 at this edge.
    expect(eraStatuses.filter(s => s === 500)).toEqual([])
  })

  const watchUrl = (query = '') => `${urlOf(era)}/api/v1/me/gfs/watch${query}`
  const bearer = (token = 'test-token-u1') => ({ authorization: `Bearer ${token}` })
  const putBody = { connId: CONN_ID, seq: 1, keys: [KEY_1] }
  const watchCalls = () => upstreamRequests.filter(r => r.url.startsWith('/external/gfs/watch'))

  describe('open', () => {
    it('sends every k to control-api in order, with the client address and the edge request id', async () => {
      const q = [KEY_1, KEY_2, KEY_3].map(k => `k=${encodeURIComponent(k)}`).join('&')
      const r = await call(watchUrl(`?${q}`), 'GET', {
        headers: { ...bearer(), 'x-forwarded-for': '198.51.100.9, 203.0.113.7' },
      })
      r.close()

      expect(r.status).toBe(200)
      expect(JSON.parse(r.firstLine!)).toEqual({ type: 'ready', schemaVersion: 1 })
      expect(r.headers['x-accel-buffering']).toBe('no')
      const [sent] = watchCalls()
      const params = new URL(sent!.url, 'http://x').searchParams
      expect(params.getAll('k')).toEqual([KEY_1, KEY_2, KEY_3])
      // trust proxy 1: the address the single trusted hop attested, never the
      // value the client wrote in front of it.
      expect(sent!.headers['x-forwarded-for']).toBe('203.0.113.7')
      expect(sent!.headers['x-request-id']).toBe(r.headers['x-request-id'])
      expect(sent!.headers['x-user-session-token']).toBe('test-token-u1')
    })

    const distinctKeys = (n: number) =>
      Array.from({ length: n }, (_, i) => `file:gfs://drive-a/${i.toString(16).padStart(32, '0')}`)
    const keysQuery = (keys: string[]) =>
      `?${keys.map(k => `k=${encodeURIComponent(k)}`).join('&')}`

    it('opens with the 64 keys of a full set, all of them reaching control-api in order', async () => {
      const keys = distinctKeys(64)
      const r = await call(watchUrl(keysQuery(keys)), 'GET', { headers: bearer() })
      r.close()

      expect(r.status).toBe(200)
      expect(JSON.parse(r.firstLine!)).toEqual({ type: 'ready', schemaVersion: 1 })
      expect(new URL(watchCalls()[0]!.url, 'http://x').searchParams.getAll('k')).toEqual(keys)
    })

    it('relays the 400 bad_request control-api answers for 65 keys', async () => {
      const keys = distinctKeys(65)
      const r = await call(watchUrl(keysQuery(keys)), 'GET', { headers: bearer() })

      expect(watchError(r)).toEqual({
        status: 400,
        header: 'bad_request',
        body: { error: 'bad_request' },
      })
      expect(new URL(watchCalls()[0]!.url, 'http://x').searchParams.getAll('k')).toEqual(keys)
    })

    it('opens with no keys when the query has no k', async () => {
      const r = await call(watchUrl(), 'GET', { headers: bearer() })
      r.close()
      expect(r.status).toBe(200)
      expect(new URL(watchCalls()[0]!.url, 'http://x').searchParams.getAll('k')).toEqual([])
    })

    it('answers 400 bad_request for a k that is not a string or a list of strings, without calling control-api', async () => {
      for (const q of ['?k[a]=x', `?k=${encodeURIComponent(KEY_1)}&k[a]=x`]) {
        const r = await call(watchUrl(q), 'GET', { headers: bearer() })
        expect(watchError(r)).toEqual({
          status: 400,
          header: 'bad_request',
          body: { error: 'bad_request' },
        })
      }
      expect(watchCalls()).toEqual([])
    })

    it('relays a 503 watch_reauthorize with its body and Retry-After', async () => {
      scenario.openReply = { status: 503, code: 'watch_reauthorize', retryAfterSec: 2 }
      const r = await call(watchUrl(), 'GET', { headers: bearer() })
      expect(watchError(r)).toEqual({
        status: 503,
        header: 'watch_reauthorize',
        body: { error: 'watch_reauthorize' },
      })
      expect(r.headers['retry-after']).toBe('2')
    })
  })

  describe('error code header', () => {
    type Case = { name: string; arrange: () => void; query?: string }
    const cases = (): Case[] => [
      { name: 'invalid key', arrange: () => {}, query: '?k=not-a-key' },
      { name: 'invalid session', arrange: () => (scenario.auth = { status: 'invalid' }) },
      {
        name: 'retired user (PUT authority)',
        arrange: () => {
          const { ExternalGfsAuthorityError } = (
            globalThis as {
              __watchAuthority: typeof import('../../control-api/src/gfs/externalAuthority.js')
            }
          ).__watchAuthority
          scenario.authorityError = new ExternalGfsAuthorityError(403, 'desktop_user_retired')
        },
      },
      {
        name: 'V2 session',
        arrange: () => (scenario.auth = authenticated(USER_1, 'v2')),
      },
      {
        name: 'client upgrade required',
        arrange: () => (scenario.auth = { status: 'upgrade_required' }),
      },
      {
        name: 'limiter denied',
        arrange: () =>
          (scenario.limit = {
            outcome: 'denied',
            limit: 1,
            retryAfterSeconds: 7,
            resetMs: 7_000,
          }),
      },
      { name: 'listener down', arrange: () => (scenario.listenerReady = false) },
    ]

    for (const method of ['GET', 'PUT'] as const) {
      it(`${method}: every error reaches the client with the code control-api wrote`, async () => {
        const seen = new Set<string>()
        for (const c of cases()) {
          if (method === 'GET' && c.name.includes('PUT authority')) continue
          if (method === 'PUT' && c.name === 'listener down') continue
          if (method === 'PUT' && c.query) continue
          scenario = defaultScenario()
          c.arrange()
          const opts = {
            headers: bearer(),
            ...(method === 'PUT' ? { body: putBody } : {}),
          }
          const direct = await call(
            `${urlOf(upstream)}/external/gfs/watch${c.query ?? ''}`,
            method,
            { ...opts, headers: { 'x-user-session-token': 'test-token-u1' }, record: false }
          )
          resetIngress()
          const viaEdge = await call(watchUrl(c.query), method, opts)

          expect(direct.status, c.name).toBeGreaterThanOrEqual(400)
          expect(direct.headers['x-watch-error'], c.name).toBe(
            (direct.body as { error: string }).error
          )
          expect(watchError(viaEdge), c.name).toEqual(watchError(direct))
          expect(viaEdge.headers['retry-after'], c.name).toBe(direct.headers['retry-after'])
          seen.add(String(direct.status))
        }
        expect([...seen].sort()).toEqual(
          method === 'GET'
            ? ['400', '401', '409', '426', '429', '503']
            : ['401', '403', '409', '426', '429']
        )
      })
    }

    it('relays a 401 or 403 the watch route wrote, with its x-watch-error', async () => {
      scenario.auth = { status: 'invalid' }
      const open = await call(watchUrl(), 'GET', { headers: bearer() })
      const put = await call(watchUrl(), 'PUT', { headers: bearer(), body: putBody })
      for (const r of [open, put]) {
        expect(watchError(r)).toEqual({
          status: 401,
          header: 'session_invalid',
          body: { error: 'session_invalid' },
        })
      }

      scenario = defaultScenario()
      const { ExternalGfsAuthorityError } = (
        globalThis as {
          __watchAuthority: typeof import('../../control-api/src/gfs/externalAuthority.js')
        }
      ).__watchAuthority
      scenario.authorityError = new ExternalGfsAuthorityError(403, 'desktop_user_retired')
      const retired = await call(watchUrl(), 'PUT', { headers: bearer(), body: putBody })
      expect(watchError(retired)).toEqual({
        status: 403,
        header: 'desktop_user_retired',
        body: { error: 'desktop_user_retired' },
      })
    })

    it('relays 426 upgrade_required on both routes instead of turning it into a reopen', async () => {
      scenario.auth = { status: 'upgrade_required' }
      const open = await call(watchUrl(), 'GET', { headers: bearer() })
      const put = await call(watchUrl(), 'PUT', { headers: bearer(), body: putBody })
      for (const r of [open, put]) {
        expect(watchError(r)).toEqual({
          status: 426,
          header: 'upgrade_required',
          body: { error: 'upgrade_required' },
        })
      }
    })
  })

  describe('answers that do not come from the watch route', () => {
    const reopen = { status: 503, header: 'watch_reopen', body: { error: 'watch_reopen' } }
    const raws = (): Array<[string, RawUpstream]> => [
      [
        '302 with Location',
        {
          status: 302,
          headers: { location: `${urlOf(upstream)}/redirect-target` },
        },
      ],
      ['302 without Location', { status: 302 }],
      [
        '415',
        {
          status: 415,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ error: 'unsupported_media_type' }),
        },
      ],
      ['404', { status: 404, headers: { 'content-type': 'text/html' } }],
      [
        '405',
        {
          status: 405,
          headers: { 'content-type': 'application/json', 'x-watch-error': 'method_not_allowed' },
          body: JSON.stringify({ error: 'method_not_allowed' }),
        },
      ],
    ]

    for (const method of ['GET', 'PUT'] as const) {
      it(`${method}: turns a redirect or an unlisted status into 503 watch_reopen and never follows it`, async () => {
        for (const [name, raw] of raws()) {
          scenario.raw = raw
          const r = await call(watchUrl(), method, {
            headers: bearer(),
            ...(method === 'PUT' ? { body: putBody } : {}),
          })
          expect(watchError(r), name).toEqual(reopen)
          expect(r.headers['retry-after'], name).toBe('2')
        }
        expect(redirectTargetHits).toBe(0)
      })
    }

    it('turns the 401 of control-api refusing this edge’s credential into 503 watch_reopen', async () => {
      // A rotated credential the funnel does not accept yet: the user's session
      // is still valid, so the client must retry instead of ending it.
      const originalServiceToken = config.controlApiServiceToken
      config.controlApiServiceToken = `rotated-${'x'.repeat(32)}`
      scenario.serviceGate = true
      try {
        const direct = await call(`${urlOf(upstream)}/external/gfs/watch`, 'GET', {
          headers: {
            authorization: `Bearer ${config.controlApiServiceToken}`,
            'x-service-token': config.controlApiServiceName,
          },
          record: false,
        })
        expect(direct.status).toBe(401)
        expect(direct.headers['x-watch-error']).toBeUndefined()

        const open = await call(watchUrl(), 'GET', { headers: bearer() })
        const put = await call(watchUrl(), 'PUT', { headers: bearer(), body: putBody })
        for (const r of [open, put]) {
          expect(watchError(r)).toEqual(reopen)
          expect(r.headers['retry-after']).toBe('2')
        }
        expect(watchCalls().length).toBeGreaterThanOrEqual(3)
      } finally {
        config.controlApiServiceToken = originalServiceToken
      }
    })

    // A JSON failure control-api writes outside the watch route, e.g. from its
    // global error handler: same status family as the contract, no x-watch-error.
    for (const method of ['GET', 'PUT'] as const) {
      it(`${method}: turns a 403, 500 or 503 JSON without x-watch-error into 503 watch_reopen`, async () => {
        const RegistryUnavailable = (globalThis as { __registryUnavailable: new () => Error })
          .__registryUnavailable
        const thrown: Array<[string, unknown, number]> = [
          [
            '403 forwarded client error',
            Object.assign(new Error('Forbidden'), { status: 403 }),
            403,
          ],
          ['500 unhandled error', new Error('database unreachable'), 500],
          ['503 registry unavailable', new RegistryUnavailable(), 503],
        ]
        for (const [name, error, status] of thrown) {
          scenario = defaultScenario()
          scenario.thrown = error
          const opts = { headers: bearer(), ...(method === 'PUT' ? { body: putBody } : {}) }
          const direct = await call(`${urlOf(upstream)}/external/gfs/watch`, method, {
            ...opts,
            headers: { 'x-user-session-token': 'test-token-u1' },
            record: false,
          })
          expect(direct.status, name).toBe(status)
          expect(String(direct.headers['content-type']), name).toMatch(/^application\/json/)
          expect(typeof (direct.body as { error?: unknown }).error, name).toBe('string')
          expect(direct.headers['x-watch-error'], name).toBeUndefined()

          resetIngress()
          const r = await call(watchUrl(), method, opts)
          expect(watchError(r), name).toEqual(reopen)
          expect(r.headers['retry-after'], name).toBe('2')
        }
      })
    }

    it('PUT: any answer with a non-JSON body is 503 watch_reopen, never a 502, 500 or 200', async () => {
      const html = { 'content-type': 'text/html' }
      const nonJson: Array<[string, RawUpstream]> = [
        [
          '302 with a text body',
          {
            status: 302,
            headers: {
              location: `${urlOf(upstream)}/redirect-target`,
              'content-type': 'text/plain',
            },
            body: 'Found. Redirecting to /redirect-target',
          },
        ],
        ['413 HTML page', { status: 413, headers: html, body: '<html>Too Large</html>' }],
        ['404 HTML page', { status: 404, headers: html, body: '<html>Not Found</html>' }],
        ['503 HTML page', { status: 503, headers: html, body: '<html>Unavailable</html>' }],
        ['200 text', { status: 200, headers: { 'content-type': 'text/plain' }, body: 'ok' }],
      ]
      for (const [name, raw] of nonJson) {
        scenario.raw = raw
        const r = await call(watchUrl(), 'PUT', { headers: bearer(), body: putBody })
        expect(watchError(r), name).toEqual(reopen)
        expect(r.headers['retry-after'], name).toBe('2')
      }
      expect(redirectTargetHits).toBe(0)
    })

    it('GET: a non-JSON error page at a status the contract relays is 503 watch_reopen, never relayed', async () => {
      // The stream client wraps a non-JSON body as {error: <raw text>} instead of
      // raising the synthetic 502 PUT gets, so on GET only the missing
      // x-watch-error keeps a funnel page from reaching the client as a verdict.
      const html = { 'content-type': 'text/html' }
      const pages: Array<[string, RawUpstream]> = [
        ['400 HTML page', { status: 400, headers: html, body: '<html>Bad Request</html>' }],
        ['401 HTML page', { status: 401, headers: html, body: '<html>Unauthorized</html>' }],
        ['403 HTML page', { status: 403, headers: html, body: '<html>Forbidden</html>' }],
        ['502 HTML page', { status: 502, headers: html, body: '<html>Bad Gateway</html>' }],
        ['503 HTML page', { status: 503, headers: html, body: '<html>Unavailable</html>' }],
      ]
      for (const [name, raw] of pages) {
        scenario.raw = raw
        const r = await call(watchUrl(), 'GET', { headers: bearer() })
        expect(watchError(r), name).toEqual(reopen)
        expect(r.headers['retry-after'], name).toBe('2')
      }
      expect(watchCalls()).toHaveLength(pages.length)
    })

    it('answers 503 watch_reopen when control-api cannot be reached', async () => {
      const unreachable = await listen(() => {})
      const address = urlOf(unreachable)
      await close(unreachable)
      config.controlApiBaseUrl = address
      const defectLog = vi.spyOn(console, 'error').mockImplementation(() => {})

      try {
        const open = await call(watchUrl(), 'GET', { headers: bearer() })
        const put = await call(watchUrl(), 'PUT', { headers: bearer(), body: putBody })
        for (const r of [open, put]) {
          expect(watchError(r)).toEqual(reopen)
          expect(r.headers['retry-after']).toBe('2')
        }
        // An unreachable funnel is an expected outage, not a handler defect.
        expect(defectLog).not.toHaveBeenCalled()
      } finally {
        defectLog.mockRestore()
      }
    })
  })

  describe('methods', () => {
    it('answers HEAD 405 with Allow and sends nothing to control-api', async () => {
      const r = await call(watchUrl(), 'HEAD', { headers: bearer() })
      expect(r.status).toBe(405)
      expect(r.headers.allow).toBe('GET, PUT')
      expect(r.headers['x-watch-error']).toBe('method_not_allowed')
      expect(upstreamRequests).toEqual([])
    })

    it('answers the other methods 405 too, without reaching the GFS router', async () => {
      for (const method of ['POST', 'DELETE', 'PATCH']) {
        const r = await call(watchUrl(), method, { headers: bearer(), body: {} })
        expect(watchError(r), method).toEqual({
          status: 405,
          header: 'method_not_allowed',
          body: { error: 'method_not_allowed' },
        })
        expect(r.headers.allow).toBe('GET, PUT')
      }
      expect(upstreamRequests).toEqual([])
    })
  })

  describe('credentials', () => {
    // No origin or cookie either, so the browser mutation guard lets the PUT
    // through and the edge's own session check is the one that answers.
    it('answers GET and PUT without credentials 401 at the edge, sending nothing to control-api', async () => {
      const open = await call(watchUrl(), 'GET')
      const put = await call(watchUrl(), 'PUT', { body: putBody })
      for (const r of [open, put]) {
        expect({ status: r.status, body: r.body }).toEqual({
          status: 401,
          body: { error: 'Unauthorized' },
        })
      }
      expect(watchCalls()).toEqual([])
    })
  })

  describe('client leaving', () => {
    async function until(pred: () => boolean, ms: number): Promise<boolean> {
      const start = performance.now()
      while (performance.now() - start < ms) {
        if (pred()) return true
        await new Promise(r => setTimeout(r, 5))
      }
      return pred()
    }

    it('closes the control-api stream once the client leaves an open stream', async () => {
      const r = await call(watchUrl(), 'GET', { headers: bearer() })
      expect(r.status).toBe(200)
      const closedAt = performance.now()
      r.close()

      expect(await until(() => upstreamStream.goneAt !== null, 1_000)).toBe(true)
      expect(upstreamStream.goneAt! - closedAt).toBeLessThanOrEqual(200)
    })

    it('abandons the control-api request when the client leaves before its answer', async () => {
      scenario.openDelayMs = 1_000
      const req = httpRequest(watchUrl(), { method: 'GET', headers: bearer() })
      req.on('error', () => {})
      req.end()
      expect(await until(() => upstreamStream.opened === 1, 1_000)).toBe(true)
      const closedAt = performance.now()
      req.destroy()

      expect(await until(() => upstreamStream.goneAt !== null, 1_000)).toBe(true)
      expect(upstreamStream.goneAt! - closedAt).toBeLessThanOrEqual(200)
    })
    it('abandons the control-api request on the response closing alone, without an aborted request', async () => {
      // Node emits a request's 'aborted' only while its body is unread. The JSON
      // body parser reads this one to its end, so the socket going away reaches
      // the handler only as the response's 'close'.
      scenario.openDelayMs = 1_000
      const payload = '{}'
      const req = httpRequest(watchUrl(), {
        method: 'GET',
        headers: {
          ...bearer(),
          'content-type': 'application/json',
          'content-length': String(payload.length),
        },
      })
      req.on('error', () => {})
      req.end(payload)
      expect(await until(() => upstreamStream.opened === 1, 1_000)).toBe(true)
      const closedAt = performance.now()
      req.destroy()

      expect(await until(() => upstreamStream.goneAt !== null, 1_000)).toBe(true)
      expect(upstreamStream.goneAt! - closedAt).toBeLessThanOrEqual(200)
    })
  })

  describe('PUT', () => {
    it('relays the 202 of an accepted command with the client address', async () => {
      const r = await call(watchUrl(), 'PUT', {
        headers: { ...bearer(), 'x-forwarded-for': '203.0.113.8' },
        body: putBody,
      })
      expect({ status: r.status, body: r.body }).toEqual({ status: 202, body: { seq: 1 } })
      const [sent] = watchCalls()
      expect(sent!.method).toBe('PUT')
      expect(sent!.headers['x-forwarded-for']).toBe('203.0.113.8')
      expect(sent!.headers['x-request-id']).toBe(r.headers['x-request-id'])
    })

    it('relays the 400 bad_request control-api answers for a command over 64 keys', async () => {
      // Relayed, the client resets the poisoned command; turned into a reopen, it
      // would resend it on a slow loop.
      const keys = Array.from(
        { length: 65 },
        (_, i) => `file:gfs://drive-a/${i.toString(16).padStart(32, '0')}`
      )
      const body = { ...putBody, keys }
      const direct = await call(`${urlOf(upstream)}/external/gfs/watch`, 'PUT', {
        headers: { 'x-user-session-token': 'test-token-u1' },
        body,
        record: false,
      })
      expect(watchError(direct)).toEqual({
        status: 400,
        header: 'bad_request',
        body: { error: 'bad_request' },
      })

      resetIngress()
      upstreamRequests.length = 0
      const viaEdge = await call(watchUrl(), 'PUT', { headers: bearer(), body })
      expect(watchError(viaEdge)).toEqual(watchError(direct))
      expect(viaEdge.headers['retry-after']).toBeUndefined()
      expect(watchCalls()).toHaveLength(1)
    })

    it('passes the browser mutation guard with a Bearer token even from a foreign origin', async () => {
      const foreign = { origin: 'https://foreign.example', cookie: 'x=1' }
      const withBearer = await call(watchUrl(), 'PUT', {
        headers: { ...bearer(), ...foreign },
        body: putBody,
      })
      expect(withBearer.status).toBe(202)
      // Without it the guard refuses before the watch route runs.
      const withoutBearer = await call(watchUrl(), 'PUT', { headers: foreign, body: putBody })
      expect(withoutBearer.status).toBe(403)
    })
  })

  describe('edge buckets', () => {
    it('charges a user’s PUTs to the watch user bucket, not to the GFS aggregate one', async () => {
      const statuses: number[] = []
      const buckets: unknown[] = []
      for (let i = 0; i < 300; i += 1) {
        const r = await call(watchUrl(), 'PUT', {
          headers: { ...bearer(), 'x-forwarded-for': '203.0.113.10' },
          body: { ...putBody, seq: i + 1 },
        })
        statuses.push(r.status)
        if (r.status === 429) buckets.push((r.body as { rateLimitBucket: string }).rateLimitBucket)
      }
      expect(statuses.filter(s => s === 202)).toHaveLength(240)
      // The 241st is refused by the user bucket; past the per-IP budget (250)
      // that one answers first.
      expect(statuses[240]).toBe(429)
      expect(buckets.slice(0, 10)).toEqual(Array(10).fill('watch-user'))
      expect(new Set(buckets.slice(10))).toEqual(new Set(['watch-ip']))
      expect(watchCalls()).toHaveLength(240)

      // One user's spent budget must not stall the live updates of the others
      // behind the same edge.
      const otherUserPut = await call(watchUrl(), 'PUT', {
        headers: { ...bearer('test-token-u2'), 'x-forwarded-for': '198.51.100.21' },
        body: putBody,
      })
      expect({ status: otherUserPut.status, body: otherUserPut.body }).toEqual({
        status: 202,
        body: { seq: 1 },
      })
      expect(watchCalls()).toHaveLength(241)

      const otherUserRead = await call(`${urlOf(era)}/api/v1/me/gfs/roots`, 'GET', {
        headers: { ...bearer('test-token-u2'), 'x-forwarded-for': '198.51.100.20' },
      })
      expect(otherUserRead.status).not.toBe(429)
    })

    it('charges a user’s opens to the same buckets, the user one first and then the per-IP one', async () => {
      const statuses: number[] = []
      const buckets: unknown[] = []
      for (let i = 0; i < 260; i += 1) {
        const r = await call(watchUrl(), 'GET', {
          headers: { ...bearer(), 'x-forwarded-for': '203.0.113.11' },
        })
        r.close()
        statuses.push(r.status)
        if (r.status === 429) buckets.push((r.body as { rateLimitBucket: string }).rateLimitBucket)
      }
      expect(statuses.filter(s => s === 200)).toHaveLength(240)
      expect(statuses[240]).toBe(429)
      expect(buckets.slice(0, 10)).toEqual(Array(10).fill('watch-user'))
      expect(new Set(buckets.slice(10))).toEqual(new Set(['watch-ip']))
      expect(watchCalls()).toHaveLength(240)

      const otherUserOpen = await call(watchUrl(), 'GET', {
        headers: { ...bearer('test-token-u2'), 'x-forwarded-for': '198.51.100.22' },
      })
      otherUserOpen.close()
      expect(otherUserOpen.status).toBe(200)
      expect(JSON.parse(otherUserOpen.firstLine!)).toEqual({ type: 'ready', schemaVersion: 1 })
      expect(watchCalls()).toHaveLength(241)
    })
  })
})
