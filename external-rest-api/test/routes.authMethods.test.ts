import { afterEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import {
  type ControlApiRecord,
  controlApiAnswers,
  controlApiRecord,
} from './helpers/controlApiDesktopSignInRecords.js'

const METHODS = '/api/v1/auth/methods'
const METHODS_UNAVAILABLE = { error: 'methods_unavailable' }

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

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('edge GET /auth/methods: the rebuilt answer', () => {
  // `methods` is filtered by name only. An `oidc` name left without a usable block is what
  // Desktop already treats as absent (design §10.1).
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
  })

  it('relays control-api 404 as 404', async () => {
    const fetchMock = controlApiAnswers(notFound)
    const res = await (await edge()).get(METHODS)

    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'Not Found' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
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
