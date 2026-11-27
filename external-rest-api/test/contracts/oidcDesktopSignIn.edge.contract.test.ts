import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import request from 'supertest'
import {
  type ControlApiRecord,
  FIXTURE_EXPIRES_AT,
  controlApiAnswers,
  controlApiRecord,
  controlApiRecordNames,
} from '../helpers/controlApiDesktopSignInRecords.js'

/**
 * Stage 2 of the Desktop sign-in contract chain. Every answer control-api recorded (stage 1,
 * control-api/test/fixtures/oidc-desktop-sign-in/) is replayed through the whole edge app,
 * `createApp()`, and what the edge sends is recorded to edge.json. Profile UI and Desktop tests
 * read only that file.
 *
 * Each recorded answer is first checked against its row in the table below: what the edge must
 * answer for it. The table is this test's own claim about the contract, never the edge's output
 * pasted back.
 */

/**
 * The edge's configured public URL: `desktop_code_issued` carries it as `environment`. Desktop's
 * tests compare a code's environment with this same value.
 */
const EDGE_PUBLIC_BASE_URL = 'https://edge-fixture.example.test'

/**
 * One fixed instant for the whole recording. The re-stamped `expiresAt`, the session cookie's
 * `Expires` and the redeem limiter's window all derive from it, so the file is the same on every
 * run.
 */
const RECORDED_AT = new Date('2026-11-25T12:00:00.000Z')
/** What the control-api reader re-stamps `FIXTURE_EXPIRES_AT` to at RECORDED_AT. */
const STAMPED_EXPIRES_AT = new Date(RECORDED_AT.getTime() + 600_000).toISOString()

/** Redeems per minute for one client: the 61st in one window is refused. */
const REDEEM_PER_CLIENT_LIMIT = 60
/** /oidc/profile-flow requests per minute for one client: the 61st in one window is refused. */
const PROFILE_FLOW_PER_CLIENT_LIMIT = 60

type EdgeClient = ReturnType<typeof request>
type EdgeCookie = Readonly<{ name: string; value: string; attributes: string[] }>
type EdgeRecord = Readonly<{
  status: number
  body: unknown
  setCookie: Array<{ name: string; attributes: string[] }>
  retryAfter: string | null
}>

/** An edge route and the control-api route it calls. */
type EdgeRoute = Readonly<{
  method: 'GET' | 'POST'
  path: string
  upstreamPath: string
  send: (edge: EdgeClient) => request.Test
}>

/** A row: what the edge must answer, given control-api's recorded answer. */
type Row = Readonly<{
  status: number
  body: unknown
  /** Each Set-Cookie the row sets, by name, with the value it must carry. */
  cookies?: Readonly<Record<string, string>>
  /** Attributes each of those cookies must carry. */
  cookieAttributes?: readonly string[]
  /** Whether the row carries Retry-After. */
  retryAfter?: boolean
}>

type Replay = Readonly<{
  route: EdgeRoute
  /**
   * Set when the record comes from another control-api path: control-api's catch-all 404 stands
   * for what a control-api older than the route answers.
   */
  olderControlApi?: true
  row: (upstream: ControlApiRecord) => Row
}>

const BROWSER_BINDING = 'B'.repeat(43)
const STATE = 'S'.repeat(43)
/** A fresh RFC 7636 verifier for each run, and its S256 challenge. */
const CODE_VERIFIER = randomBytes(32).toString('base64url')
const CODE_CHALLENGE = createHash('sha256').update(CODE_VERIFIER).digest('base64url')

/** Deployed edges serve HTTPS behind one proxy, so the session cookie carries Secure. */
const proto = (test: request.Test) => test.set('X-Forwarded-Proto', 'https')

function post(path: string, body: () => object): EdgeRoute['send'] {
  return edge => proto(edge.post(path).send(body()))
}

function get(path: string): EdgeRoute['send'] {
  return edge => proto(edge.get(path))
}

const ATTEMPTS = '/api/v1/oidc/profile-flow/attempts'
const COMPLETE = '/api/v1/oidc/profile-flow/complete'
const CANCEL = '/api/v1/oidc/profile-flow/cancel'
const CONFIGURATION = '/api/v1/oidc/profile-flow/configuration'
const REDEEM = '/api/v1/oidc/desktop-sign-in/redeem'
const METHODS = '/api/v1/auth/methods'

const routes = {
  configuration: {
    method: 'GET',
    path: CONFIGURATION,
    upstreamPath: '/external/oidc/profile-flow/configuration',
    send: get(CONFIGURATION),
  },
  plainAttempt: {
    method: 'POST',
    path: ATTEMPTS,
    upstreamPath: '/external/oidc/profile-flow/attempts',
    send: post(ATTEMPTS, () => ({ browserBinding: BROWSER_BINDING })),
  },
  desktopAttempt: {
    method: 'POST',
    path: ATTEMPTS,
    upstreamPath: '/external/oidc/profile-flow/attempts',
    send: post(ATTEMPTS, () => ({
      browserBinding: BROWSER_BINDING,
      desktopSignIn: { codeChallenge: CODE_CHALLENGE },
    })),
  },
  complete: {
    method: 'POST',
    path: COMPLETE,
    upstreamPath: '/external/oidc/profile-flow/complete',
    send: post(COMPLETE, () => ({
      state: STATE,
      code: 'fixture-provider-code',
      browserBinding: BROWSER_BINDING,
    })),
  },
  cancel: {
    method: 'POST',
    path: CANCEL,
    upstreamPath: '/external/oidc/profile-flow/cancel',
    send: post(CANCEL, () => ({ state: STATE, browserBinding: BROWSER_BINDING })),
  },
  // Desktop's main process sends neither Origin nor Sec-Fetch-Site. The code is the one
  // control-api minted at /complete, as Desktop receives it.
  redeem: {
    method: 'POST',
    path: REDEEM,
    upstreamPath: '/external/oidc/desktop-sign-in/redeem',
    send: post(REDEEM, () => ({
      code: controlApiRecord('POST /external/oidc/profile-flow/complete desktop-code-issued').body
        .code,
      codeVerifier: CODE_VERIFIER,
    })),
  },
  methods: {
    method: 'GET',
    path: METHODS,
    upstreamPath: '/external/auth/methods',
    send: get(METHODS),
  },
} satisfies Record<string, EdgeRoute>

/** The re-stamped expiry the edge must relay: never the sentinel, always now + 600 s. */
function stampedExpiresAt(upstream: ControlApiRecord): unknown {
  expect(upstream.body.expiresAt).toBe(STAMPED_EXPIRES_AT)
  return upstream.body.expiresAt
}

/**
 * The expectation table: one row per control-api record. Error codes and rebuilt
 * shapes are the contract's literals; relayed values (URLs, codes, tokens, `me`) come from
 * control-api's record, because relaying them unchanged is the claim.
 */
const replays: Readonly<Record<string, Replay>> = {
  // Configuration: rebuilt from its three fields.
  'GET /external/oidc/profile-flow/configuration activated': {
    route: routes.configuration,
    row: up => ({
      status: 200,
      body: {
        redirectUri: up.body.redirectUri,
        memberAuthenticationActivated: true,
        displayLabel: up.body.displayLabel,
      },
    }),
  },

  // /attempts. Row "200 with signInContext: 'desktop_sign_in'": 200, echo kept.
  'POST /external/oidc/profile-flow/attempts desktop-echo': {
    route: routes.desktopAttempt,
    row: up => ({
      status: 200,
      body: {
        authorizationUrl: up.body.authorizationUrl,
        expiresAt: stampedExpiresAt(up),
        signInContext: 'desktop_sign_in',
      },
    }),
  },
  // Row "200 without the echo": 200, no echo. A plain Profile request.
  'POST /external/oidc/profile-flow/attempts plain': {
    route: routes.plainAttempt,
    row: up => ({
      status: 200,
      body: { authorizationUrl: up.body.authorizationUrl, expiresAt: stampedExpiresAt(up) },
    }),
  },
  // Row "409 desktop_sign_in_unavailable": 409, same code.
  'POST /external/oidc/profile-flow/attempts desktop-unavailable': {
    route: routes.desktopAttempt,
    row: () => ({ status: 409, body: { error: 'desktop_sign_in_unavailable' } }),
  },
  // Row "400 invalid_oidc_attempt": 400, same code, for a Desktop request.
  'POST /external/oidc/profile-flow/attempts invalid': {
    route: routes.desktopAttempt,
    row: () => ({ status: 400, body: { error: 'invalid_oidc_attempt' } }),
  },

  // /complete. Row "desktop_code_issued": the edge's own public URL, no cookie.
  'POST /external/oidc/profile-flow/complete desktop-code-issued': {
    route: routes.complete,
    row: up => ({
      status: 200,
      body: {
        outcome: 'desktop_code_issued',
        memberAuthenticationActivated: true,
        code: up.body.code,
        expiresInSeconds: up.body.expiresInSeconds,
        environment: EDGE_PUBLIC_BASE_URL,
      },
    }),
  },
  // "As today": the Profile session cookie carries the token, and the body does not.
  'POST /external/oidc/profile-flow/complete member-signed-in': {
    route: routes.complete,
    row: up => ({
      status: 200,
      body: { outcome: 'member_signed_in', memberAuthenticationActivated: true },
      cookies: { profile_session: String(up.body.token) },
      cookieAttributes: ['Path=/', 'HttpOnly', 'Secure', 'SameSite=Lax'],
    }),
  },
  // Row "refused with an allowlisted reason": as today, reason kept.
  'POST /external/oidc/profile-flow/complete refused': {
    route: routes.complete,
    row: up => ({
      status: 200,
      body: { outcome: 'refused', memberAuthenticationActivated: true, reason: up.body.reason },
    }),
  },
  // The same row for the invitation email mismatch reason: 200, reason kept.
  'POST /external/oidc/profile-flow/complete refused-invitation-email-mismatch': {
    route: routes.complete,
    row: () => ({
      status: 200,
      body: {
        outcome: 'refused',
        memberAuthenticationActivated: true,
        reason: 'invitation_email_mismatch',
      },
    }),
  },
  'POST /external/oidc/profile-flow/complete identity-proof-verified': {
    route: routes.complete,
    row: () => ({
      status: 200,
      body: { outcome: 'identity_proof_verified', memberAuthenticationActivated: false },
    }),
  },
  'POST /external/oidc/profile-flow/complete storage-unavailable': {
    route: routes.complete,
    row: () => ({
      status: 503,
      body: { error: 'oidc_storage_unavailable', retrySameAttempt: false },
    }),
  },

  'POST /external/oidc/profile-flow/cancel cancelled': {
    route: routes.cancel,
    row: () => ({ status: 200, body: { outcome: 'attempt_cancelled' } }),
  },

  // Redeem. Row "200 { token, me }": in the body, with no cookie.
  'POST /external/oidc/desktop-sign-in/redeem signed-in': {
    route: routes.redeem,
    row: up => ({ status: 200, body: { token: up.body.token, me: up.body.me } }),
  },
  'POST /external/oidc/desktop-sign-in/redeem invalid': {
    route: routes.redeem,
    row: () => ({ status: 400, body: { error: 'invalid_desktop_sign_in_code' } }),
  },
  // Row "403 desktop_sign_in_refused with a reason": 403, same, reason allowlisted.
  'POST /external/oidc/desktop-sign-in/redeem refused-account-disabled': {
    route: routes.redeem,
    row: up => ({
      status: 403,
      body: { error: 'desktop_sign_in_refused', reason: up.body.reason },
    }),
  },
  'POST /external/oidc/desktop-sign-in/redeem unavailable': {
    route: routes.redeem,
    row: () => ({ status: 409, body: { error: 'desktop_sign_in_unavailable' } }),
  },
  'POST /external/oidc/desktop-sign-in/redeem upgrade-required': {
    route: routes.redeem,
    row: () => ({ status: 426, body: { error: 'upgrade_required' } }),
  },
  'POST /external/oidc/desktop-sign-in/redeem issuance-unavailable': {
    route: routes.redeem,
    row: () => ({ status: 503, body: { error: 'session_issuance_temporarily_unavailable' } }),
  },

  // Methods. Row "200": rebuilt.
  'GET /external/auth/methods password': {
    route: routes.methods,
    row: () => ({ status: 200, body: { methods: ['password'] } }),
  },
  'GET /external/auth/methods password-and-oidc': {
    route: routes.methods,
    row: up => {
      const oidc = up.body.oidc as { label: unknown; signInUrl: unknown }
      return {
        status: 200,
        body: {
          methods: ['password', 'oidc'],
          oidc: { label: oidc.label, signInUrl: oidc.signInUrl },
        },
      }
    },
  },
  // Row "404 (a control-api older than the methods route)": 404.
  'GET /external/unknown not-found': {
    route: routes.methods,
    olderControlApi: true,
    row: () => ({ status: 404, body: { error: 'Not Found' } }),
  },
}

/** The `'<METHOD> <path> <case>'` parts of a record key. */
function keyParts(key: string): { method: string; path: string; caseName: string } {
  const [method, path, ...rest] = key.split(' ')
  if (!method || !path || rest.length === 0) throw new Error(`malformed record key "${key}"`)
  return { method, path, caseName: rest.join(' ') }
}

function edgeKey(route: EdgeRoute, caseName: string): string {
  return `${route.method} ${route.path} ${caseName}`
}

function setCookies(res: request.Response): EdgeCookie[] {
  const raw = res.headers['set-cookie'] as unknown
  const headers = raw === undefined ? [] : Array.isArray(raw) ? raw.map(String) : [String(raw)]
  return headers.map(header => {
    const [pair = '', ...attributes] = header.split('; ')
    const separator = pair.indexOf('=')
    if (separator < 1) throw new Error('a Set-Cookie header without a name')
    return { name: pair.slice(0, separator), value: pair.slice(separator + 1), attributes }
  })
}

/** Checks the answer against its row: status, exact body, cookies by name and value, Retry-After. */
function expectRow(key: string, res: request.Response, row: Row): void {
  expect(res.status, key).toBe(row.status)
  expect(res.body, key).toEqual(row.body)
  const cookies = setCookies(res)
  expect(Object.fromEntries(cookies.map(({ name, value }) => [name, value])), key).toEqual(
    row.cookies ?? {}
  )
  for (const cookie of cookies) {
    expect(cookie.attributes, key).toEqual(
      expect.arrayContaining([...(row.cookieAttributes ?? [])])
    )
  }
  expect(res.headers['retry-after'] !== undefined, key).toBe(row.retryAfter ?? false)
}

/** Every string equal to the re-stamped expiry, written back as the sentinel. */
function withExpirySentinel(value: unknown): unknown {
  if (value === STAMPED_EXPIRES_AT) return FIXTURE_EXPIRES_AT
  if (Array.isArray(value)) return value.map(withExpirySentinel)
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([name, inner]) => [name, withExpirySentinel(inner)])
    )
  }
  return value
}

/**
 * The answer as edge.json records it. Each cookie keeps its name and attributes; its value is
 * left out, and readers send `fixture-cookie-value` in its place.
 */
function edgeRecord(res: request.Response): EdgeRecord {
  const retryAfter = res.headers['retry-after']
  return {
    status: res.status,
    body: withExpirySentinel(res.body),
    setCookie: setCookies(res).map(({ name, attributes }) => ({ name, attributes })),
    retryAfter: retryAfter === undefined ? null : String(retryAfter),
  }
}

/** The same value with every object's keys in sorted order, at any depth. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (typeof value !== 'object' || value === null) return value
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map(name => [name, sortKeys((value as Record<string, unknown>)[name])])
  )
}

/** The edge's one call to control-api: method and path. */
function expectOneUpstreamCall(
  key: string,
  fetchMock: ReturnType<typeof controlApiAnswers>,
  route: EdgeRoute
): void {
  expect(fetchMock, key).toHaveBeenCalledTimes(1)
  const [url, init] = fetchMock.mock.calls[0]!
  // The configured control-api base URL carries its own path prefix.
  const { pathname } = new URL(String(url))
  expect(pathname.slice(-route.upstreamPath.length), key).toBe(route.upstreamPath)
  expect(init?.method, key).toBe(route.method)
}

beforeEach(() => {
  vi.stubEnv('EXTERNAL_REST_API_PUBLIC_BASE_URL', EDGE_PUBLIC_BASE_URL)
  // Only Date is faked, so the HTTP round trips still run on real timers.
  vi.useFakeTimers({ toFake: ['Date'], now: RECORDED_AT })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('edge contract fixtures for Desktop sign-in', () => {
  it('records what Profile UI and Desktop receive from the edge', { timeout: 60_000 }, async () => {
    // Config reads the public URL when the module loads.
    vi.resetModules()
    const { createApp } = await import('../../src/app.js')
    const records: Record<string, EdgeRecord> = {}
    const add = (key: string, res: request.Response) => {
      if (Object.hasOwn(records, key)) throw new Error(`edge record "${key}" produced twice`)
      records[key] = edgeRecord(res)
    }

    // Coverage: every control-api record has exactly one replay, and every replay a record.
    const names = controlApiRecordNames()
    for (const name of names) {
      if (!Object.hasOwn(replays, name)) throw new Error(`no edge replay for "${name}"`)
    }
    expect(Object.keys(replays).sort()).toEqual([...names].sort())

    for (const name of names) {
      const { route, olderControlApi, row } = replays[name]!
      const { method, path, caseName } = keyParts(name)
      expect(method, name).toBe(route.method)
      if (!olderControlApi) expect(path, name).toBe(route.upstreamPath)

      const upstream = controlApiRecord(name)
      const fetchMock = controlApiAnswers(upstream)
      // A fresh app for each record: the methods cache and every limiter start empty.
      const res = await route.send(request(createApp()))

      const key = edgeKey(route, caseName)
      // The edge's own validation could answer the same 400 bodies; one upstream call proves
      // each answer is a relay.
      expectOneUpstreamCall(key, fetchMock, route)
      expectRow(key, res, row(upstream))
      add(key, res)
    }

    // Edge-only: control-api cannot be reached. Row "Anything else, or unreachable".
    {
      const fetchMock = controlApiAnswers(() => {
        throw new TypeError('fetch failed')
      })
      const key = edgeKey(routes.methods, 'unavailable')
      const res = await routes.methods.send(request(createApp()))
      expectOneUpstreamCall(key, fetchMock, routes.methods)
      expectRow(key, res, { status: 503, body: { error: 'methods_unavailable' } })
      add(key, res)
    }

    // Edge-only: the redeem limiter refuses the 61st redeem in one window. Row "(edge limiter)".
    {
      const fetchMock = controlApiAnswers(
        controlApiRecord('POST /external/oidc/desktop-sign-in/redeem signed-in')
      )
      const edge = request(createApp())
      for (let i = 0; i < REDEEM_PER_CLIENT_LIMIT; i++) {
        const ok = await routes.redeem.send(edge)
        if (ok.status !== 200) throw new Error(`redeem ${i} answered ${ok.status}`)
      }
      const key = edgeKey(routes.redeem, 'rate-limited')
      const res = await routes.redeem.send(edge)
      const retryAfterSeconds = Number(res.headers['retry-after'])
      expect(Number.isInteger(retryAfterSeconds), key).toBe(true)
      expect(retryAfterSeconds, key).toBeGreaterThanOrEqual(1)
      expect(retryAfterSeconds, key).toBeLessThanOrEqual(60)
      expectRow(key, res, {
        status: 429,
        body: { error: 'rate_limited', retryAfterSeconds },
        retryAfter: true,
      })
      // The refused redeem never reached control-api.
      expect(fetchMock, key).toHaveBeenCalledTimes(REDEEM_PER_CLIENT_LIMIT)
      add(key, res)
    }

    // Edge-only: the /oidc/profile-flow per-client limiter refuses the 61st /complete in one
    // window. No control-api record is a 429, so the replay loop cannot produce this one. Its
    // buckets belong to one limiter instance, so one fresh app starts them empty.
    {
      const fetchMock = controlApiAnswers(
        controlApiRecord('POST /external/oidc/profile-flow/complete refused')
      )
      const edge = request(createApp())
      for (let i = 0; i < PROFILE_FLOW_PER_CLIENT_LIMIT; i++) {
        const ok = await routes.complete.send(edge)
        if (ok.status !== 200) throw new Error(`complete ${i} answered ${ok.status}`)
      }
      const key = edgeKey(routes.complete, 'rate-limited')
      const res = await routes.complete.send(edge)
      // Only Date is faked and it stands still, so the whole window is left.
      expect(res.headers['retry-after'], key).toBe('60')
      expectRow(key, res, {
        status: 429,
        body: { error: 'oidc_unavailable', retryAfterSeconds: 60 },
        retryAfter: true,
      })
      // The refused /complete never reached control-api.
      expect(fetchMock, key).toHaveBeenCalledTimes(PROFILE_FLOW_PER_CLIENT_LIMIT)
      add(key, res)
    }

    expect(Object.keys(records)).toHaveLength(names.length + 3)
    // Every relayed expiry went back to the sentinel; no run-dependent instant is recorded.
    expect(JSON.stringify(records)).not.toContain(STAMPED_EXPIRES_AT)

    await expect(`${JSON.stringify(sortKeys(records), null, 2)}\n`).toMatchFileSnapshot(
      '../fixtures/oidc-desktop-sign-in/edge.json'
    )
  })
})
