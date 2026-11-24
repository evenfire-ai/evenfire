import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomBytes } from 'node:crypto'
import request from 'supertest'
import {
  type ControlApiRecord,
  controlApiAnswers,
  controlApiRecord,
} from './helpers/controlApiDesktopSignInRecords.js'

const REDEEM = '/api/v1/oidc/desktop-sign-in/redeem'
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

beforeEach(() => {
  vi.stubEnv('EXTERNAL_REST_API_CORS_ORIGIN', CONFIGURED_ORIGIN)
})

afterEach(() => {
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
