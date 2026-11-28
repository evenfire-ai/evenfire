import { type MockInstance, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomBytes } from 'node:crypto'
import request from 'supertest'
import {
  type ControlApiRecord,
  ISSUANCE_DEFERRED_RETRY_AFTER,
  controlApiAnswers,
  controlApiRateLimits,
  controlApiRecord,
} from './helpers/controlApiDesktopSignInRecords.js'

const REDEEM = '/api/v1/oidc/desktop-sign-in/redeem'
const FALLBACK_MSG = 'desktop sign-in redeem answered 503'
/** An Origin the edge is configured to trust, so the global browser guard lets it through. */
const CONFIGURED_ORIGIN = 'https://profile-fixture.example.test'
const ISSUANCE_UNAVAILABLE = { error: 'session_issuance_temporarily_unavailable' }

const redeemRecord = (name: string) =>
  controlApiRecord(`POST /external/oidc/desktop-sign-in/redeem ${name}`)
const signedIn = redeemRecord('signed-in')
const invalid = redeemRecord('invalid')
const refused = redeemRecord('refused-account-disabled')
const unavailable = redeemRecord('unavailable')
const upgradeRequired = redeemRecord('upgrade-required')
const issuanceUnavailable = redeemRecord('issuance-unavailable')
/** control-api's catch-all 404: what a control-api older than the redeem route answers. */
const notFound = controlApiRecord('GET /external/unknown not-found')

/** The code control-api minted at `/complete`, as Desktop receives it. */
const CODE = String(
  controlApiRecord('POST /external/oidc/profile-flow/complete desktop-code-issued').body.code
)
/** A fresh RFC 7636 verifier: 32 random bytes, base64url. */
const VERIFIER = randomBytes(32).toString('base64url')
const redeemBody = { code: CODE, codeVerifier: VERIFIER }

const token = String(signedIn.body.token)
const me = signedIn.body.me
const longToken = token.padEnd(4096, 't')

/**
 * A derived variant of a recorded answer: the recorded body with only `change` applied, not a
 * hand-written body. An `undefined` value removes the field.
 */
function derived(answer: ControlApiRecord, change: Record<string, unknown>): ControlApiRecord {
  return { ...answer, body: { ...answer.body, ...change } }
}

/** The bodies the edge sent to control-api, in order. */
function sentBodies(fetchMock: ReturnType<typeof controlApiAnswers>): unknown[] {
  return fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init!.body)))
}

/** The whole edge app, with config loaded after the environment is stubbed. */
async function edge() {
  vi.resetModules()
  const { createApp } = await import('../src/app.js')
  return request(createApp())
}

/**
 * Stubs `fetch` so control-api's path answers a page that is not JSON, as the funnel's nginx
 * does when it blocks a path or loses control-api.
 */
function upstreamPage(status: number, page: string) {
  const fetchMock = vi.fn(
    async (_url: string | URL, _init?: RequestInit) =>
      new Response(page, { status, headers: { 'content-type': 'text/html' } })
  )
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

/** Every `console.error` call of one test; only the edge's fallback log writes there. */
let errorLog: MockInstance<typeof console.error>

/** The one line logged, as written: a single JSON string. */
function onlyLoggedLine(): string {
  expect(errorLog).toHaveBeenCalledTimes(1)
  const args = errorLog.mock.calls[0]!
  expect(args).toHaveLength(1)
  expect(typeof args[0]).toBe('string')
  return args[0] as string
}

beforeEach(() => {
  vi.stubEnv('EXTERNAL_REST_API_CORS_ORIGIN', CONFIGURED_ORIGIN)
  errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  errorLog.mockRestore()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('edge POST /oidc/desktop-sign-in/redeem: browser refusal', () => {
  it('refuses a configured Origin sent with Sec-Fetch-Site same-site and calls nothing', async () => {
    const fetchMock = controlApiAnswers(signedIn)
    const res = await (await edge())
      .post(REDEEM)
      .set('Origin', CONFIGURED_ORIGIN)
      .set('Sec-Fetch-Site', 'same-site')
      .send(redeemBody)

    // The global browser guard answers an `{ error: { code } }` envelope; this flat body is
    // the route's own refusal.
    expect(res.status).toBe(403)
    expect(res.body).toEqual({ error: 'forbidden' })
    expect(res.text).not.toContain(token)
    expect(fetchMock).toHaveBeenCalledTimes(0)
  })

  it.each([
    ['a configured Origin alone', { Origin: CONFIGURED_ORIGIN }],
    // A bearer header exempts a request from the global browser guard, so only the route
    // sees the next two.
    [
      'Sec-Fetch-Site without Origin, under a bearer header',
      { 'Sec-Fetch-Site': 'same-origin', Authorization: 'Bearer fixture-bearer' },
    ],
    [
      'an unconfigured Origin, under a bearer header',
      { Origin: 'https://other-fixture.example.test', Authorization: 'Bearer fixture-bearer' },
    ],
  ])('refuses %s with 403 forbidden and calls nothing', async (_label, headers) => {
    const fetchMock = controlApiAnswers(signedIn)
    const res = await (await edge()).post(REDEEM).set(headers).send(redeemBody)

    expect(res.status).toBe(403)
    expect(res.body).toEqual({ error: 'forbidden' })
    expect(fetchMock).toHaveBeenCalledTimes(0)
  })

  it('forwards a request without those headers', async () => {
    const fetchMock = controlApiAnswers(signedIn)
    const res = await (await edge()).post(REDEEM).send(redeemBody)

    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0]![0])).toMatch(
      /\/external\/oidc\/desktop-sign-in\/redeem$/
    )
    expect(fetchMock.mock.calls[0]![1]!.method).toBe('POST')
    expect(sentBodies(fetchMock)).toEqual([redeemBody])
  })
})

describe('edge POST /oidc/desktop-sign-in/redeem: request and answers', () => {
  it.each([
    ['no body', undefined],
    ['a 42-character code', { ...redeemBody, code: CODE.slice(1) }],
    ['a 44-character code', { ...redeemBody, code: `${CODE}f` }],
    ['a padded code', { ...redeemBody, code: `${CODE.slice(1)}=` }],
    ['a code inside an array', { ...redeemBody, code: [CODE] }],
    ['no code', { codeVerifier: VERIFIER }],
    ['a 42-character verifier', { ...redeemBody, codeVerifier: 'v'.repeat(42) }],
    ['a 129-character verifier', { ...redeemBody, codeVerifier: 'v'.repeat(129) }],
    ['a verifier outside RFC 7636', { ...redeemBody, codeVerifier: `${VERIFIER}+` }],
    ['a verifier inside an array', { ...redeemBody, codeVerifier: [VERIFIER] }],
    ['no verifier', { code: CODE }],
  ])('refuses %s with 400 and forwards nothing', async (_label, body) => {
    const fetchMock = controlApiAnswers(signedIn)
    const res = await (await edge()).post(REDEEM).send(body)

    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'invalid_desktop_sign_in_code' })
    expect(fetchMock).toHaveBeenCalledTimes(0)
  })

  it.each([
    ['43', `._~-${'A'.repeat(39)}`],
    ['128', 'Az09._~-'.repeat(16)],
  ])('forwards a %s-character RFC 7636 verifier', async (_length, codeVerifier) => {
    const fetchMock = controlApiAnswers(signedIn)
    const res = await (await edge()).post(REDEEM).send({ code: CODE, codeVerifier })

    expect(res.status).toBe(200)
    expect(sentBodies(fetchMock)).toEqual([{ code: CODE, codeVerifier }])
  })

  it('sets no Set-Cookie on a successful redeem', async () => {
    controlApiAnswers(signedIn)
    const res = await (await edge()).post(REDEEM).set('X-Forwarded-Proto', 'https').send(redeemBody)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ token, me })
    expect(res.headers['set-cookie']).toBeUndefined()
  })

  it('forwards the session-contract header as password login does', async () => {
    const fetchMock = controlApiAnswers(signedIn)
    const app = await edge()
    await app.post(REDEEM).set('x-evenfire-session-contract', 'v2').send(redeemBody)
    await app.post(REDEEM).send(redeemBody)
    await app.post(REDEEM).set('x-evenfire-session-contract', 'v1').send(redeemBody)

    expect(sentBodies(fetchMock)).toEqual([
      { ...redeemBody, sessionContract: 'v2' },
      redeemBody,
      redeemBody,
    ])
  })

  const redeemRows: Array<[string, ControlApiRecord, number, unknown]> = [
    ['the recorded sign-in to { token, me }', signedIn, 200, { token, me }],
    [
      'a sign-in with an extra field to { token, me }',
      derived(signedIn, { refreshToken: 'fixture-refresh-token' }),
      200,
      { token, me },
    ],
    [
      'a sign-in with a 4096-character token',
      derived(signedIn, { token: longToken }),
      200,
      { token: longToken, me },
    ],
    [
      'a sign-in with an empty token to 503',
      derived(signedIn, { token: '' }),
      503,
      ISSUANCE_UNAVAILABLE,
    ],
    [
      'a sign-in with a 4097-character token to 503',
      derived(signedIn, { token: `${longToken}t` }),
      503,
      ISSUANCE_UNAVAILABLE,
    ],
    [
      'a sign-in with a numeric token to 503',
      derived(signedIn, { token: 42 }),
      503,
      ISSUANCE_UNAVAILABLE,
    ],
    [
      'a sign-in without a token to 503',
      derived(signedIn, { token: undefined }),
      503,
      ISSUANCE_UNAVAILABLE,
    ],
    ['a sign-in with me null to 503', derived(signedIn, { me: null }), 503, ISSUANCE_UNAVAILABLE],
    [
      'a sign-in with me as an array to 503',
      derived(signedIn, { me: [me] }),
      503,
      ISSUANCE_UNAVAILABLE,
    ],
    [
      'a sign-in with me as a string to 503',
      derived(signedIn, { me: 'fixture-member' }),
      503,
      ISSUANCE_UNAVAILABLE,
    ],
    [
      'a sign-in without me to 503',
      derived(signedIn, { me: undefined }),
      503,
      ISSUANCE_UNAVAILABLE,
    ],
    ['the recorded 400 to 400', invalid, 400, { error: 'invalid_desktop_sign_in_code' }],
    [
      "a 400 with the 409's code to 503",
      derived(invalid, { error: unavailable.body.error }),
      503,
      ISSUANCE_UNAVAILABLE,
    ],
    [
      'the recorded 403 to 403 with its reason',
      refused,
      403,
      { error: 'desktop_sign_in_refused', reason: refused.body.reason },
    ],
    [
      'a 403 with an extra field to 403 without it',
      derived(refused, { detail: 'fixture-detail' }),
      403,
      { error: 'desktop_sign_in_refused', reason: refused.body.reason },
    ],
    // Derived from the recorded 403: only its reason changed.
    [
      'a 403 with an unknown reason to 503',
      derived(refused, { reason: 'fixture_unknown_reason' }),
      503,
      ISSUANCE_UNAVAILABLE,
    ],
    [
      'a 403 without a reason to 503',
      derived(refused, { reason: undefined }),
      503,
      ISSUANCE_UNAVAILABLE,
    ],
    [
      "a 403 with the 400's code to 503",
      derived(refused, { error: invalid.body.error }),
      503,
      ISSUANCE_UNAVAILABLE,
    ],
    ['the recorded 409 to 409', unavailable, 409, { error: 'desktop_sign_in_unavailable' }],
    [
      "a 409 with the 400's code to 503",
      derived(unavailable, { error: invalid.body.error }),
      503,
      ISSUANCE_UNAVAILABLE,
    ],
    ['the recorded 426 to 426', upgradeRequired, 426, { error: 'upgrade_required' }],
    [
      'a 426 with an extra field to 426 without it',
      derived(upgradeRequired, { detail: 'fixture-detail' }),
      426,
      { error: 'upgrade_required' },
    ],
    [
      "a 426 with the 409's code to 503",
      derived(upgradeRequired, { error: unavailable.body.error }),
      503,
      ISSUANCE_UNAVAILABLE,
    ],
    ['the recorded 503 to the flat 503', issuanceUnavailable, 503, ISSUANCE_UNAVAILABLE],
    ["control-api's catch-all 404 to 503", notFound, 503, ISSUANCE_UNAVAILABLE],
  ]

  it.each(redeemRows)('maps %s', async (_label, answer, status, body) => {
    const fetchMock = controlApiAnswers(answer)
    const res = await (await edge()).post(REDEEM).send(redeemBody)

    expect(res.status).toBe(status)
    expect(res.body).toEqual(body)
    expect(res.headers['set-cookie']).toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    // Every generic 503 logs one line; an answer control-api meant is relayed unlogged, and so
    // is its session deferral, which control-api logs itself.
    expect(errorLog).toHaveBeenCalledTimes(status === 503 && answer !== issuanceUnavailable ? 1 : 0)
  })

  it('answers 503 when control-api cannot be reached', async () => {
    const fetchMock = controlApiAnswers(() => {
      throw new TypeError('fetch failed')
    })
    const res = await (await edge()).post(REDEEM).send(redeemBody)

    expect(res.status).toBe(503)
    expect(res.body).toEqual(ISSUANCE_UNAVAILABLE)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('answers 503 for a non-JSON page from the funnel', async () => {
    const fetchMock = upstreamPage(502, '<html>Bad Gateway</html>')
    const res = await (await edge()).post(REDEEM).send(redeemBody)

    expect(res.status).toBe(503)
    expect(res.body).toEqual(ISSUANCE_UNAVAILABLE)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("relays control-api's own 429 as 429 with its Retry-After, unlogged", async () => {
    // Part-way through control-api's window, its limiter's Retry-After is below the window.
    const fetchMock = controlApiRateLimits('17')
    const res = await (await edge()).post(REDEEM).send(redeemBody)

    expect(res.status).toBe(429)
    expect(res.body).toEqual({ error: 'rate_limited', retryAfterSeconds: 17 })
    expect(res.headers['retry-after']).toBe('17')
    expect(res.headers['set-cookie']).toBeUndefined()
    expect(res.text).not.toContain('Too many requests')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0]![0])).toMatch(
      /\/external\/oidc\/desktop-sign-in\/redeem$/
    )
    // A wait, not a failure.
    expect(errorLog).not.toHaveBeenCalled()
  })

  it.each([
    ['none', null],
    ['an HTTP date', 'Wed, 25 Nov 2026 12:01:00 GMT'],
    ['zero', '0'],
    ['more than a day', '86401'],
  ])(
    "waits one 60-second window when control-api's 429 carries %s as Retry-After",
    async (_label, retryAfter) => {
      const fetchMock = controlApiRateLimits(retryAfter)
      const res = await (await edge()).post(REDEEM).send(redeemBody)

      expect(res.status).toBe(429)
      expect(res.body).toEqual({ error: 'rate_limited', retryAfterSeconds: 60 })
      expect(res.headers['retry-after']).toBe('60')
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(errorLog).not.toHaveBeenCalled()
    }
  )

  it.each([
    ['the lowest', 1],
    ['the highest', 86_400],
  ])(
    "relays %s Retry-After the bound allows, %i, from control-api's 429",
    async (_label, seconds) => {
      const fetchMock = controlApiRateLimits(String(seconds))
      const res = await (await edge()).post(REDEEM).send(redeemBody)

      expect(res.status).toBe(429)
      expect(res.body).toEqual({ error: 'rate_limited', retryAfterSeconds: seconds })
      expect(res.headers['retry-after']).toBe(String(seconds))
      expect(fetchMock).toHaveBeenCalledTimes(1)
    }
  )

  it("relays the Retry-After of control-api's session deferral with the 503", async () => {
    const fetchMock = controlApiAnswers(issuanceUnavailable, {
      'retry-after': ISSUANCE_DEFERRED_RETRY_AFTER,
    })
    const res = await (await edge()).post(REDEEM).send(redeemBody)

    expect(res.status).toBe(503)
    expect(res.body).toEqual(ISSUANCE_UNAVAILABLE)
    expect(res.headers['retry-after']).toBe(ISSUANCE_DEFERRED_RETRY_AFTER)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['an unbounded Retry-After on the deferral', issuanceUnavailable, 'soon'],
    [
      'a Retry-After on another 503',
      derived(issuanceUnavailable, { error: 'oidc_storage_unavailable' }),
      ISSUANCE_DEFERRED_RETRY_AFTER,
    ],
  ])('relays no Retry-After for %s', async (_label, answer, retryAfter) => {
    const fetchMock = controlApiAnswers(answer, { 'retry-after': retryAfter })
    const res = await (await edge()).post(REDEEM).send(redeemBody)

    expect(res.status).toBe(503)
    expect(res.body).toEqual(ISSUANCE_UNAVAILABLE)
    expect(res.headers['retry-after']).toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("reports no budget left on a relayed 429, as the edge limiter's own 429 does", async () => {
    const fetchMock = controlApiRateLimits('17')
    const res = await (await edge()).post(REDEEM).send(redeemBody)

    expect(res.status).toBe(429)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    // The request passed the edge limiter, which stamped its own budget before control-api
    // refused it.
    expect(res.headers['x-ratelimit-limit']).toBe('60')
    expect(res.headers['x-ratelimit-remaining']).toBe('0')
  })

  it('answers 429 rate_limited after 60 redeems a minute from one client', async () => {
    const fetchMock = controlApiAnswers(signedIn)
    const app = await edge()
    for (let i = 0; i < 60; i++) {
      const ok = await app.post(REDEEM).send(redeemBody)
      if (ok.status !== 200) throw new Error(`redeem ${i} unexpectedly answered ${ok.status}`)
    }
    const limited = await app.post(REDEEM).send(redeemBody)

    expect(limited.status).toBe(429)
    expect(limited.body.error).toBe('rate_limited')
    expect(fetchMock).toHaveBeenCalledTimes(60)
    // The bucket is per client: another forwarded client still redeems.
    const other = await app.post(REDEEM).set('X-Forwarded-For', '203.0.113.7').send(redeemBody)
    expect(other.status).toBe(200)
    // The limiter guards the redeem path only, not every route mounted after it.
    expect((await app.get('/api/v1/no-such-route')).status).toBe(404)
  })
})

describe('edge POST /oidc/desktop-sign-in/redeem: the fallback log', () => {
  /**
   * What no fallback line may carry: the request's values, the token and email control-api's
   * sign-in holds, and the error message.
   */
  function expectNothingSecret(line: string): void {
    const email = String((me as { email: unknown }).email)
    for (const value of [CODE, VERIFIER, token, email, '/external/', 'Control API']) {
      expect(line).not.toContain(value)
    }
  }

  it('logs an unreachable control-api once, by class', async () => {
    controlApiAnswers(() => {
      throw new TypeError('fetch failed')
    })
    const res = await (await edge()).post(REDEEM).send(redeemBody)

    expect(res.status).toBe(503)
    const line = onlyLoggedLine()
    expect(JSON.parse(line)).toEqual({ msg: FALLBACK_MSG, error: 'ControlApiTransportError' })
    expectNothingSecret(line)
  })

  it.each([
    [502, '<html>Bad Gateway</html>'],
    [503, '<html>Unavailable</html>'],
  ])(
    'logs a non-JSON %i page once, by class and the status that came back',
    async (status, page) => {
      upstreamPage(status, page)
      const res = await (await edge()).post(REDEEM).send(redeemBody)

      expect(res.status).toBe(503)
      const line = onlyLoggedLine()
      expect(JSON.parse(line)).toEqual({
        msg: FALLBACK_MSG,
        error: 'ControlApiNonJsonResponseError',
        upstreamStatus: status,
      })
      expectNothingSecret(line)
      expect(line).not.toContain(page)
    }
  )

  it("logs control-api's own generic 503 once, by class and status", async () => {
    // control-api's redeem 503 for any failure but the session deferral.
    controlApiAnswers(derived(issuanceUnavailable, { error: 'oidc_storage_unavailable' }))
    const res = await (await edge()).post(REDEEM).send(redeemBody)

    expect(res.status).toBe(503)
    const line = onlyLoggedLine()
    expect(JSON.parse(line)).toEqual({
      msg: FALLBACK_MSG,
      error: 'ControlApiError',
      upstreamStatus: 503,
    })
    expectNothingSecret(line)
  })

  it("relays control-api's session deferral with its Retry-After and logs nothing", async () => {
    // control-api's error handler logs the deferral at warn; the edge does not log it again.
    const fetchMock = controlApiAnswers(issuanceUnavailable, {
      'retry-after': ISSUANCE_DEFERRED_RETRY_AFTER,
    })
    const res = await (await edge()).post(REDEEM).send(redeemBody)

    expect(res.status).toBe(503)
    expect(res.body).toEqual(ISSUANCE_UNAVAILABLE)
    expect(res.headers['retry-after']).toBe(ISSUANCE_DEFERRED_RETRY_AFTER)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(errorLog).not.toHaveBeenCalled()
  })

  it('logs an unusable sign-in once, by its status and never its body', async () => {
    // The recorded sign-in with only `me` removed: its token is still in the body.
    controlApiAnswers(derived(signedIn, { me: null }))
    const res = await (await edge()).post(REDEEM).send(redeemBody)

    expect(res.status).toBe(503)
    const line = onlyLoggedLine()
    expect(JSON.parse(line)).toEqual({
      msg: FALLBACK_MSG,
      error: 'unusable_answer',
      upstreamStatus: 200,
    })
    expectNothingSecret(line)
  })
})
