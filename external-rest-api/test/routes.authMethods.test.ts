import { type MockInstance, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import {
  type ControlApiRecord,
  controlApiAnswers,
  controlApiRateLimits,
  controlApiRecord,
} from './helpers/controlApiDesktopSignInRecords.js'

const METHODS = '/api/v1/auth/methods'
const METHODS_UNAVAILABLE = { error: 'methods_unavailable' }
const FALLBACK_MSG = 'auth methods answered 503'

const password = controlApiRecord('GET /external/auth/methods password')
const passwordAndOidc = controlApiRecord('GET /external/auth/methods password-and-oidc')
/** control-api's catch-all 404: what a control-api older than `/external/auth/methods` answers. */
const notFound = controlApiRecord('GET /external/unknown not-found')
// control-api records no failure of its own for methods. These are real control-api failure
// bodies from redeem, standing for "anything else".
const controlApi503 = controlApiRecord(
  'POST /external/oidc/desktop-sign-in/redeem issuance-unavailable'
)
const controlApi400 = controlApiRecord('POST /external/oidc/desktop-sign-in/redeem invalid')

const oidc = passwordAndOidc.body.oidc as { label: string; signInUrl: string }
const BOTH = ['password', 'oidc']
const signInUrlOf = (length: number) =>
  `${oidc.signInUrl}?${'q'.repeat(length - oidc.signInUrl.length - 1)}`

/**
 * A derived variant of a recorded answer: the recorded body with only `change` applied, not a
 * hand-written body. An `undefined` value removes the field.
 */
function derived(answer: ControlApiRecord, change: Record<string, unknown>): ControlApiRecord {
  return { ...answer, body: { ...answer.body, ...change } }
}

/** The recorded password-and-oidc answer with only its `oidc` block's fields changed. */
function derivedOidc(change: Record<string, unknown>): ControlApiRecord {
  return derived(passwordAndOidc, { oidc: { ...oidc, ...change } })
}

/** The whole edge app, with fresh modules: a new limiter and an empty cache. */
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

/** What no fallback line may carry: control-api's answer and the error message. */
function expectNothingUpstream(line: string): void {
  for (const value of [oidc.label, oidc.signInUrl, '/external/', 'Control API']) {
    expect(line).not.toContain(value)
  }
}

beforeEach(() => {
  errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  errorLog.mockRestore()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('edge GET /auth/methods: the rebuilt answer', () => {
  // `methods` is filtered by name only. An `oidc` name left without a usable block is what
  // Desktop already treats as absent: it offers a provider only with a usable `oidc` block.
  const methodsRows: Array<[string, ControlApiRecord, number, unknown]> = [
    ['the recorded password answer', password, 200, { methods: ['password'] }],
    [
      'the recorded password-and-oidc answer',
      passwordAndOidc,
      200,
      { methods: BOTH, oidc: { label: oidc.label, signInUrl: oidc.signInUrl } },
    ],
    [
      'unknown method names, filtered out',
      derived(passwordAndOidc, { methods: ['passkey', 'password', 42, 'oidc', null] }),
      200,
      { methods: BOTH, oidc },
    ],
    [
      'unknown method names only, to an empty list',
      derived(password, { methods: ['passkey'] }),
      200,
      { methods: [] },
    ],
    [
      'extra fields, dropped',
      derived(passwordAndOidc, {
        issuer: 'https://issuer-fixture.example.test',
        oidc: { ...oidc, clientId: 'fixture-client-id' },
      }),
      200,
      { methods: BOTH, oidc },
    ],
    [
      'an 80-character label, kept',
      derivedOidc({ label: 'L'.repeat(80) }),
      200,
      { methods: BOTH, oidc: { ...oidc, label: 'L'.repeat(80) } },
    ],
    [
      'a 2048-character signInUrl, kept',
      derivedOidc({ signInUrl: signInUrlOf(2048) }),
      200,
      { methods: BOTH, oidc: { ...oidc, signInUrl: signInUrlOf(2048) } },
    ],
    ['an empty label, dropping oidc', derivedOidc({ label: '' }), 200, { methods: BOTH }],
    [
      'an 81-character label, dropping oidc',
      derivedOidc({ label: 'L'.repeat(81) }),
      200,
      { methods: BOTH },
    ],
    ['a numeric label, dropping oidc', derivedOidc({ label: 42 }), 200, { methods: BOTH }],
    ['no label, dropping oidc', derivedOidc({ label: undefined }), 200, { methods: BOTH }],
    ['an empty signInUrl, dropping oidc', derivedOidc({ signInUrl: '' }), 200, { methods: BOTH }],
    [
      'a 2049-character signInUrl, dropping oidc',
      derivedOidc({ signInUrl: signInUrlOf(2049) }),
      200,
      { methods: BOTH },
    ],
    [
      'a signInUrl that is not a string, dropping oidc',
      derivedOidc({ signInUrl: { href: oidc.signInUrl } }),
      200,
      { methods: BOTH },
    ],
    [
      'an oidc block that is null, dropped',
      derived(passwordAndOidc, { oidc: null }),
      200,
      { methods: BOTH },
    ],
    [
      'an oidc block that is an array, dropped',
      derived(passwordAndOidc, { oidc: [oidc] }),
      200,
      { methods: BOTH },
    ],
    [
      'methods that are not a list, to 503',
      derived(passwordAndOidc, { methods: 'password' }),
      503,
      METHODS_UNAVAILABLE,
    ],
    ['no methods, to 503', derived(password, { methods: undefined }), 503, METHODS_UNAVAILABLE],
    ['a control-api 503, to 503', controlApi503, 503, METHODS_UNAVAILABLE],
    ['a control-api 400, to 503', controlApi400, 503, METHODS_UNAVAILABLE],
  ]

  it.each(methodsRows)('maps %s', async (_label, answer, status, body) => {
    const fetchMock = controlApiAnswers(answer)
    const res = await (await edge()).get(METHODS)

    expect(res.status).toBe(status)
    expect(res.body).toEqual(body)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0]![0])).toMatch(/\/external\/auth\/methods$/)
    expect(fetchMock.mock.calls[0]![1]!.method).toBe('GET')
    // Every 503 logs one line; a 200 logs nothing.
    expect(errorLog).toHaveBeenCalledTimes(status === 503 ? 1 : 0)
  })

  it('relays control-api 404 as 404', async () => {
    const fetchMock = controlApiAnswers(notFound)
    const res = await (await edge()).get(METHODS)

    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'Not Found' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    // A control-api older than the route is not an outage.
    expect(errorLog).not.toHaveBeenCalled()
  })

  it('answers 503 methods_unavailable on a transport error', async () => {
    const fetchMock = controlApiAnswers(() => {
      throw new TypeError('fetch failed')
    })
    const res = await (await edge()).get(METHODS)

    expect(res.status).toBe(503)
    expect(res.body).toEqual(METHODS_UNAVAILABLE)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("relays control-api's own 429 as 429 with its Retry-After, uncached and unlogged", async () => {
    // Part-way through control-api's window, its limiter's Retry-After is below the window.
    const limited = controlApiRateLimits('17')
    const app = await edge()
    const res = await app.get(METHODS)

    expect(res.status).toBe(429)
    expect(res.body).toEqual({ error: 'rate_limited', retryAfterSeconds: 17 })
    expect(res.headers['retry-after']).toBe('17')
    expect(res.text).not.toContain('Too many requests')
    expect(limited).toHaveBeenCalledTimes(1)
    expect(String(limited.mock.calls[0]![0])).toMatch(/\/external\/auth\/methods$/)
    // A wait, not an outage.
    expect(errorLog).not.toHaveBeenCalled()

    // Not cached: the next read asks control-api again.
    const recovered = controlApiAnswers(password)
    const next = await app.get(METHODS)
    expect(next.status).toBe(200)
    expect(next.body).toEqual({ methods: ['password'] })
    expect(recovered).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['none', null],
    ['an HTTP date', 'Wed, 25 Nov 2026 12:01:00 GMT'],
    ['zero', '0'],
    ['more than a day', '86401'],
  ])(
    "waits one 60-second window when control-api's 429 carries %s as Retry-After",
    async (_label, retryAfter) => {
      const limited = controlApiRateLimits(retryAfter)
      const res = await (await edge()).get(METHODS)

      expect(res.status).toBe(429)
      expect(res.body).toEqual({ error: 'rate_limited', retryAfterSeconds: 60 })
      expect(res.headers['retry-after']).toBe('60')
      expect(limited).toHaveBeenCalledTimes(1)
      expect(errorLog).not.toHaveBeenCalled()
    }
  )

  it.each([
    ['the lowest', 1],
    ['the highest', 86_400],
  ])(
    "relays %s Retry-After the bound allows, %i, from control-api's 429",
    async (_label, seconds) => {
      const limited = controlApiRateLimits(String(seconds))
      const res = await (await edge()).get(METHODS)

      expect(res.status).toBe(429)
      expect(res.body).toEqual({ error: 'rate_limited', retryAfterSeconds: seconds })
      expect(res.headers['retry-after']).toBe(String(seconds))
      expect(limited).toHaveBeenCalledTimes(1)
    }
  )
})

describe('edge GET /auth/methods: the fallback log', () => {
  it('logs an unreachable control-api once, by class', async () => {
    controlApiAnswers(() => {
      throw new TypeError('fetch failed')
    })
    const res = await (await edge()).get(METHODS)

    expect(res.status).toBe(503)
    const line = onlyLoggedLine()
    expect(JSON.parse(line)).toEqual({ msg: FALLBACK_MSG, error: 'ControlApiTransportError' })
    expectNothingUpstream(line)
  })

  it.each([
    [502, '<html>Bad Gateway</html>'],
    [503, '<html>Unavailable</html>'],
  ])(
    'logs a non-JSON %i page once, by class and the status that came back',
    async (status, page) => {
      const fetchMock = upstreamPage(status, page)
      const res = await (await edge()).get(METHODS)

      expect(res.status).toBe(503)
      expect(res.body).toEqual(METHODS_UNAVAILABLE)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      const line = onlyLoggedLine()
      expect(JSON.parse(line)).toEqual({
        msg: FALLBACK_MSG,
        error: 'ControlApiNonJsonResponseError',
        upstreamStatus: status,
      })
      expectNothingUpstream(line)
      expect(line).not.toContain(page)
    }
  )

  it("logs control-api's own 503 once, by class and status", async () => {
    controlApiAnswers(controlApi503)
    const res = await (await edge()).get(METHODS)

    expect(res.status).toBe(503)
    const line = onlyLoggedLine()
    expect(JSON.parse(line)).toEqual({
      msg: FALLBACK_MSG,
      error: 'ControlApiError',
      upstreamStatus: 503,
    })
    expectNothingUpstream(line)
  })

  it('logs an unusable 200 once, by its status and never its body', async () => {
    // The recorded answer with only `methods` broken: its oidc block is still in the body.
    controlApiAnswers(derived(passwordAndOidc, { methods: 'password' }))
    const res = await (await edge()).get(METHODS)

    expect(res.status).toBe(503)
    const line = onlyLoggedLine()
    expect(JSON.parse(line)).toEqual({
      msg: FALLBACK_MSG,
      error: 'unusable_answer',
      upstreamStatus: 200,
    })
    expectNothingUpstream(line)
  })
})

describe('edge GET /auth/methods: cache and limit', () => {
  it('caches a 200 for 30 seconds and never caches a 503', async () => {
    // Only Date is faked, so the HTTP round trips still run on real timers.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-25T12:00:00.000Z'))
    let answer = controlApi503
    const fetchMock = controlApiAnswers(() => answer)
    const app = await edge()

    expect((await app.get(METHODS)).status).toBe(503)
    expect((await app.get(METHODS)).status).toBe(503)
    expect(fetchMock).toHaveBeenCalledTimes(2)

    answer = passwordAndOidc
    const first = await app.get(METHODS)
    expect(first.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(3)

    // control-api's answer changes; the edge keeps serving its cached one for 30 s.
    answer = password
    vi.setSystemTime(new Date('2026-11-25T12:00:29.999Z'))
    const cached = await app.get(METHODS)
    expect(cached.status).toBe(200)
    expect(cached.body).toEqual(first.body)
    expect(fetchMock).toHaveBeenCalledTimes(3)

    vi.setSystemTime(new Date('2026-11-25T12:00:30.000Z'))
    const refreshed = await app.get(METHODS)
    expect(refreshed.status).toBe(200)
    expect(refreshed.body).toEqual({ methods: ['password'] })
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('never caches a 404, an unusable 200 or a transport error', async () => {
    let answer: ControlApiRecord | 'unreachable' = notFound
    const fetchMock = controlApiAnswers(() => {
      if (answer === 'unreachable') throw new TypeError('fetch failed')
      return answer
    })
    const app = await edge()

    expect((await app.get(METHODS)).status).toBe(404)
    expect((await app.get(METHODS)).status).toBe(404)
    // A derived variant of the recorded answer: its methods is not a list.
    answer = derived(password, { methods: 'password' })
    expect((await app.get(METHODS)).status).toBe(503)
    expect((await app.get(METHODS)).status).toBe(503)
    answer = 'unreachable'
    expect((await app.get(METHODS)).status).toBe(503)
    expect((await app.get(METHODS)).status).toBe(503)
    answer = password
    const recovered = await app.get(METHODS)
    expect(recovered.status).toBe(200)
    expect(recovered.body).toEqual({ methods: ['password'] })
    expect(fetchMock).toHaveBeenCalledTimes(7)
  })

  it('serves one cached answer to every client', async () => {
    const fetchMock = controlApiAnswers(passwordAndOidc)
    const app = await edge()
    const first = await app.get(METHODS).set('X-Forwarded-For', '203.0.113.7')
    const second = await app.get(METHODS).set('X-Forwarded-For', '198.51.100.7')

    expect(first.status).toBe(200)
    expect(second.body).toEqual(first.body)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("reports no budget left on a relayed 429, as the edge limiter's own 429 does", async () => {
    const limited = controlApiRateLimits('17')
    const res = await (await edge()).get(METHODS)

    expect(res.status).toBe(429)
    expect(limited).toHaveBeenCalledTimes(1)
    // The request passed the edge limiter, which stamped its own budget before control-api
    // refused it.
    expect(res.headers['x-ratelimit-limit']).toBe('60')
    expect(res.headers['x-ratelimit-remaining']).toBe('0')
  })

  it('answers 429 rate_limited after 60 reads a minute from one client', async () => {
    const fetchMock = controlApiAnswers(password)
    const app = await edge()
    for (let i = 0; i < 60; i++) {
      const ok = await app.get(METHODS)
      if (ok.status !== 200) throw new Error(`read ${i} unexpectedly answered ${ok.status}`)
    }
    const limited = await app.get(METHODS)

    expect(limited.status).toBe(429)
    expect(limited.body.error).toBe('rate_limited')
    // The bucket is per client: another forwarded client still reads.
    const other = await app.get(METHODS).set('X-Forwarded-For', '203.0.113.7')
    expect(other.status).toBe(200)
    // The cache served every read after the first.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    // The limiter guards the methods path only, not every route mounted after it.
    expect((await app.get('/api/v1/no-such-route')).status).toBe(404)
  })
})
