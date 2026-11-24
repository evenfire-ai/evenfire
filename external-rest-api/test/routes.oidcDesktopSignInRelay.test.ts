import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import {
  type ControlApiRecord,
  controlApiRecord,
} from './helpers/controlApiDesktopSignInRecords.js'

/** The edge's configured public URL: Desktop compares a code's `environment` with it. */
const EDGE_PUBLIC_BASE_URL = 'https://edge-fixture.example.test'
const ATTEMPTS = '/api/v1/oidc/profile-flow/attempts'
const COMPLETE = '/api/v1/oidc/profile-flow/complete'
const BROWSER_BINDING = 'B'.repeat(43)
const desktopSignIn = { codeChallenge: 'C'.repeat(43) }
const completeBody = {
  state: 'S'.repeat(43),
  code: 'fixture-provider-code',
  browserBinding: BROWSER_BINDING,
}
const NOT_RETRYABLE = { error: 'oidc_unavailable', retrySameAttempt: false }

const record = {
  attemptsPlain: () => controlApiRecord('POST /external/oidc/profile-flow/attempts plain'),
  attemptsEcho: () => controlApiRecord('POST /external/oidc/profile-flow/attempts desktop-echo'),
  attemptsUnavailable: () =>
    controlApiRecord('POST /external/oidc/profile-flow/attempts desktop-unavailable'),
  attemptsInvalid: () => controlApiRecord('POST /external/oidc/profile-flow/attempts invalid'),
  codeIssued: () =>
    controlApiRecord('POST /external/oidc/profile-flow/complete desktop-code-issued'),
}

/** control-api answers every call with this record's status and body. */
function controlApiAnswers(answer: ControlApiRecord) {
  const fetchMock = vi.fn(
    async (_url: string | URL, _init?: RequestInit) =>
      new Response(JSON.stringify(answer.body), {
        status: answer.status,
        headers: { 'content-type': 'application/json' },
      })
  )
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

/** The one body the edge sent to control-api. */
function sentBody(fetchMock: ReturnType<typeof controlApiAnswers>): unknown {
  expect(fetchMock).toHaveBeenCalledTimes(1)
  return JSON.parse(String(fetchMock.mock.calls[0]![1]!.body))
}

/** The whole edge app, with config loaded after the public URL is stubbed. */
async function edge() {
  vi.resetModules()
  const { createApp } = await import('../src/app.js')
  return request(createApp())
}

async function complete() {
  return (await edge()).post(COMPLETE).send(completeBody)
}

beforeEach(() => {
  vi.stubEnv('EXTERNAL_REST_API_PUBLIC_BASE_URL', EDGE_PUBLIC_BASE_URL)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('edge relay of /oidc/profile-flow/attempts for Desktop sign-in', () => {
  it('sends exactly { browserBinding } upstream without desktopSignIn', async () => {
    const plain = record.attemptsPlain()
    const fetchMock = controlApiAnswers(plain)
    // A caller cannot claim a Desktop attempt by sending the echo's name.
    const res = await (await edge())
      .post(ATTEMPTS)
      .send({ browserBinding: BROWSER_BINDING, signInContext: 'desktop_sign_in' })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      authorizationUrl: plain.body.authorizationUrl,
      expiresAt: plain.body.expiresAt,
    })
    expect(String(fetchMock.mock.calls[0]![0])).toMatch(/\/external\/oidc\/profile-flow\/attempts$/)
    expect(sentBody(fetchMock)).toEqual({ browserBinding: BROWSER_BINDING })
  })

  it('forwards a well-formed desktopSignIn as { codeChallenge } and keeps the echo', async () => {
    const echo = record.attemptsEcho()
    const fetchMock = controlApiAnswers(echo)
    const res = await (await edge())
      .post(ATTEMPTS)
      .send({ browserBinding: BROWSER_BINDING, desktopSignIn })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      authorizationUrl: echo.body.authorizationUrl,
      expiresAt: echo.body.expiresAt,
      signInContext: 'desktop_sign_in',
    })
    expect(echo.body.signInContext).toBe('desktop_sign_in')
    expect(sentBody(fetchMock)).toEqual({ browserBinding: BROWSER_BINDING, desktopSignIn })
  })

  it.each([
    ['null', null],
    ['a string', 'C'.repeat(43)],
    ['an array', ['C'.repeat(43)]],
    ['an empty object', {}],
    ['an extra key', { codeChallenge: 'C'.repeat(43), codeChallengeMethod: 'S256' }],
    ['a 42-character challenge', { codeChallenge: 'C'.repeat(42) }],
    ['a 44-character challenge', { codeChallenge: 'C'.repeat(44) }],
    ['a padded challenge', { codeChallenge: `${'C'.repeat(42)}=` }],
    ['a numeric challenge', { codeChallenge: 43 }],
  ])(
    'refuses a malformed desktopSignIn with 400 and forwards nothing: %s',
    async (_label, malformed) => {
      const fetchMock = controlApiAnswers(record.attemptsEcho())
      const res = await (await edge())
        .post(ATTEMPTS)
        .send({ browserBinding: BROWSER_BINDING, desktopSignIn: malformed })

      expect(res.status).toBe(400)
      expect(res.body).toEqual({ error: 'invalid_oidc_attempt' })
      expect(fetchMock).toHaveBeenCalledTimes(0)
    }
  )

  it('sends no echo when a Desktop request gets a 200 without one', async () => {
    // An older control-api ignores desktopSignIn and answers a plain attempt.
    const plain = record.attemptsPlain()
    const fetchMock = controlApiAnswers(plain)
    const res = await (await edge())
      .post(ATTEMPTS)
      .send({ browserBinding: BROWSER_BINDING, desktopSignIn })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      authorizationUrl: plain.body.authorizationUrl,
      expiresAt: plain.body.expiresAt,
    })
    expect(sentBody(fetchMock)).toEqual({ browserBinding: BROWSER_BINDING, desktopSignIn })
  })

  it.each([['profile'], ['DESKTOP_SIGN_IN'], [true], [{ kind: 'desktop_sign_in' }]])(
    'omits a signInContext of %j',
    async signInContext => {
      const echo = record.attemptsEcho()
      // A derived variant of the recorded echo (one field changed), not a hand-written body.
      const fetchMock = controlApiAnswers({ ...echo, body: { ...echo.body, signInContext } })
      const res = await (await edge())
        .post(ATTEMPTS)
        .send({ browserBinding: BROWSER_BINDING, desktopSignIn })

      expect(res.status).toBe(200)
      expect(res.body).toEqual({
        authorizationUrl: echo.body.authorizationUrl,
        expiresAt: echo.body.expiresAt,
      })
      expect(fetchMock).toHaveBeenCalledTimes(1)
    }
  )

  it('keeps 409 desktop_sign_in_unavailable', async () => {
    const fetchMock = controlApiAnswers(record.attemptsUnavailable())
    const res = await (await edge())
      .post(ATTEMPTS)
      .send({ browserBinding: BROWSER_BINDING, desktopSignIn })

    expect(res.status).toBe(409)
    expect(res.body).toEqual({ error: 'desktop_sign_in_unavailable' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['a safe code', 'oidc_attempt_rejected', 'oidc_attempt_rejected'],
    ['an unknown code', 'attempt_conflict', 'oidc_unavailable'],
  ])('answers 503 for a 409 with %s', async (_label, upstreamError, edgeError) => {
    const unavailable = record.attemptsUnavailable()
    expect(unavailable.status).toBe(409)
    // A derived variant of the recorded 409 (its error changed), not a hand-written body.
    const fetchMock = controlApiAnswers({
      ...unavailable,
      body: { ...unavailable.body, error: upstreamError },
    })
    const res = await (await edge())
      .post(ATTEMPTS)
      .send({ browserBinding: BROWSER_BINDING, desktopSignIn })

    expect(res.status).toBe(503)
    expect(res.body).toEqual({ error: edgeError })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("relays control-api's 400 invalid_oidc_attempt for a Desktop request", async () => {
    const fetchMock = controlApiAnswers(record.attemptsInvalid())
    const res = await (await edge())
      .post(ATTEMPTS)
      .send({ browserBinding: BROWSER_BINDING, desktopSignIn })

    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'invalid_oidc_attempt' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('edge relay of /oidc/profile-flow/complete for Desktop sign-in', () => {
  it('relays desktop_code_issued with the edge public URL', async () => {
    const issued = record.codeIssued()
    const fetchMock = controlApiAnswers(issued)
    const res = await (await edge())
      .post(COMPLETE)
      .set('Host', 'request-host.example.test')
      .set('X-Forwarded-Host', 'forwarded-host.example.test')
      .send(completeBody)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      outcome: 'desktop_code_issued',
      memberAuthenticationActivated: true,
      code: issued.body.code,
      expiresInSeconds: issued.body.expiresInSeconds,
      environment: EDGE_PUBLIC_BASE_URL,
    })
    expect(res.text).not.toMatch(/request-host|forwarded-host/)
    // Only member_signed_in sets the Profile session cookie; Desktop redeems the code itself.
    expect(res.headers['set-cookie']).toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('ignores an environment field from control-api', async () => {
    const issued = record.codeIssued()
    // A derived variant of the recorded body (one field added), not a hand-written body.
    controlApiAnswers({
      ...issued,
      body: { ...issued.body, environment: 'https://hostile.example.test' },
    })
    const res = await complete()

    expect(res.status).toBe(200)
    expect(res.body.outcome).toBe('desktop_code_issued')
    expect(res.body.environment).toBe(EDGE_PUBLIC_BASE_URL)
    expect(res.text).not.toContain('hostile.example.test')
    expect(JSON.stringify(res.headers)).not.toContain('hostile.example.test')
  })

  it('drops every other control-api field from desktop_code_issued, a session token included', async () => {
    const issued = record.codeIssued()
    const signedIn = controlApiRecord('POST /external/oidc/profile-flow/complete member-signed-in')
    // A derived variant: the recorded code body plus member_signed_in's recorded session fields.
    controlApiAnswers({
      ...issued,
      body: {
        ...issued.body,
        token: signedIn.body.token,
        sessionContract: signedIn.body.sessionContract,
      },
    })
    const res = await complete()

    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      outcome: 'desktop_code_issued',
      memberAuthenticationActivated: true,
      code: issued.body.code,
      expiresInSeconds: issued.body.expiresInSeconds,
      environment: EDGE_PUBLIC_BASE_URL,
    })
    expect(res.text).not.toContain(String(signedIn.body.token))
    expect(res.headers['set-cookie']).toBeUndefined()
  })

  it.each([1, 120])('relays a code that lives %i seconds', async expiresInSeconds => {
    const issued = record.codeIssued()
    // A derived variant of the recorded body (its lifetime changed), not a hand-written body.
    controlApiAnswers({ ...issued, body: { ...issued.body, expiresInSeconds } })
    const res = await complete()

    expect(res.status).toBe(200)
    expect(res.body.expiresInSeconds).toBe(expiresInSeconds)
  })

  const code = String(record.codeIssued().body.code)
  it.each([
    ['sign-in is off', { memberAuthenticationActivated: false }],
    ['the switch is not a boolean', { memberAuthenticationActivated: 'true' }],
    ['the code is missing', { code: undefined }],
    ['the code is 42 characters', { code: code.slice(1) }],
    ['the code is 44 characters', { code: `${code}f` }],
    ['the code is not base64url', { code: `${code.slice(1)}+` }],
    ['the code is not a string', { code: 43 }],
    ['the lifetime is 0', { expiresInSeconds: 0 }],
    ['the lifetime is 121', { expiresInSeconds: 121 }],
    ['the lifetime is fractional', { expiresInSeconds: 90.5 }],
    ['the lifetime is a string', { expiresInSeconds: '90' }],
    ['the lifetime is missing', { expiresInSeconds: undefined }],
  ])(
    'refuses a desktop_code_issued where %s with a final 503',
    async (_label, change: Record<string, unknown>) => {
      const issued = record.codeIssued()
      // A derived variant of the recorded body (one field changed), not a hand-written body.
      const fetchMock = controlApiAnswers({ ...issued, body: { ...issued.body, ...change } })
      const res = await complete()

      expect(res.status).toBe(503)
      expect(res.body).toEqual(NOT_RETRYABLE)
      expect(res.headers['set-cookie']).toBeUndefined()
      expect(fetchMock).toHaveBeenCalledTimes(1)
    }
  )

  it('marks its own unknown-outcome 503 as not retryable', async () => {
    // control-api's recorded /cancel answer: a real body whose outcome /complete does not know.
    const fetchMock = controlApiAnswers(
      controlApiRecord('POST /external/oidc/profile-flow/cancel cancelled')
    )
    const res = await complete()

    expect(res.status).toBe(503)
    expect(res.body).toEqual(NOT_RETRYABLE)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('relays member_signed_in as before: the cookie carries the token, the body does not', async () => {
    const signedIn = controlApiRecord('POST /external/oidc/profile-flow/complete member-signed-in')
    controlApiAnswers(signedIn)
    const res = await complete()

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ outcome: 'member_signed_in', memberAuthenticationActivated: true })
    expect(res.text).not.toContain(String(signedIn.body.token))
    expect(res.headers['set-cookie']).toHaveLength(1)
    expect(String(res.headers['set-cookie']![0])).toMatch(
      new RegExp(`^profile_session=${String(signedIn.body.token)};`)
    )
  })

  it.each([
    [
      'refused',
      200,
      { outcome: 'refused', memberAuthenticationActivated: true, reason: 'not_eligible' },
    ],
    [
      'identity-proof-verified',
      200,
      { outcome: 'identity_proof_verified', memberAuthenticationActivated: false },
    ],
    ['storage-unavailable', 503, { error: 'oidc_storage_unavailable', retrySameAttempt: false }],
  ])('relays the recorded %s answer as before', async (name, status, edgeBody) => {
    controlApiAnswers(controlApiRecord(`POST /external/oidc/profile-flow/complete ${name}`))
    const res = await complete()

    expect(res.status).toBe(status)
    expect(res.body).toEqual(edgeBody)
    expect(res.headers['set-cookie']).toBeUndefined()
  })
})
