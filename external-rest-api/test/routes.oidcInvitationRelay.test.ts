import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { controlApiAnswers, controlApiRecord } from './helpers/controlApiDesktopSignInRecords.js'

/**
 * The edge's part of the invitation link through OIDC: /attempts forwards a
 * well-formed `invitationToken`, and /complete relays the `invitation_email_mismatch` refusal.
 * Every control-api answer is one control-api recorded.
 */

const ATTEMPTS = '/api/v1/oidc/profile-flow/attempts'
const COMPLETE = '/api/v1/oidc/profile-flow/complete'
const BROWSER_BINDING = 'B'.repeat(43)
const desktopSignIn = { codeChallenge: 'C'.repeat(43) }
/** A synthetic hub token from both ends of printable ASCII: '!' (0x21) and '~' (0x7e). */
const INVITATION_TOKEN = '!fixture-invitation-token.AZaz09_~'
const completeBody = {
  state: 'S'.repeat(43),
  code: 'fixture-provider-code',
  browserBinding: BROWSER_BINDING,
}
const NOT_RETRYABLE = { error: 'oidc_unavailable', retrySameAttempt: false }
const MISMATCH = 'POST /external/oidc/profile-flow/complete refused-invitation-email-mismatch'

/** The one body the edge sent to control-api. */
function sentBody(fetchMock: ReturnType<typeof controlApiAnswers>): unknown {
  expect(fetchMock).toHaveBeenCalledTimes(1)
  return JSON.parse(String(fetchMock.mock.calls[0]![1]!.body))
}

/** The whole edge app: the browser guard, the limiters, the catch-all 404 and the error handler. */
async function edge() {
  vi.resetModules()
  const { createApp } = await import('../src/app.js')
  return request(createApp())
}

const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const

/** Spies on every console method; each call's arguments, as text. */
function consoleSpies() {
  const spies = CONSOLE_METHODS.map(method =>
    vi.spyOn(console, method).mockImplementation(() => undefined)
  )
  return () =>
    spies.flatMap(spy =>
      spy.mock.calls.flatMap(args =>
        args.map(arg =>
          typeof arg === 'string' ? arg : arg instanceof Error ? arg.stack : JSON.stringify(arg)
        )
      )
    )
}

beforeEach(() => {
  vi.stubEnv('EXTERNAL_REST_API_PUBLIC_BASE_URL', 'https://edge-fixture.example.test')
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('edge relay of /oidc/profile-flow/attempts with an invitation token', () => {
  it.each([
    ['printable ASCII from both ends', INVITATION_TOKEN],
    ['one character', '!'],
    ['2048 characters', 'fixture-invitation-token-'.padEnd(2048, '~')],
  ])('forwards { browserBinding, invitationToken } exactly: %s', async (_label, token) => {
    const plain = controlApiRecord('POST /external/oidc/profile-flow/attempts plain')
    const fetchMock = controlApiAnswers(plain)
    // A caller cannot choose the invited address: only the token is forwarded.
    const res = await (await edge()).post(ATTEMPTS).send({
      browserBinding: BROWSER_BINDING,
      invitationToken: token,
      invitedEmail: 'member@example.test',
    })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      authorizationUrl: plain.body.authorizationUrl,
      expiresAt: plain.body.expiresAt,
    })
    expect(String(fetchMock.mock.calls[0]![0])).toMatch(/\/external\/oidc\/profile-flow\/attempts$/)
    expect(sentBody(fetchMock)).toEqual({ browserBinding: BROWSER_BINDING, invitationToken: token })
  })

  it.each([
    ['null', null],
    ['a number', 42],
    ['a boolean', true],
    ['an array', [INVITATION_TOKEN]],
    ['an object', { invitationToken: INVITATION_TOKEN }],
    ['an empty string', ''],
    ['a space', 'fixture invitation token'],
    ['a newline', `${INVITATION_TOKEN}\n`],
    ['a DEL character', `${INVITATION_TOKEN}\x7f`],
    ['a non-ASCII character', 'fixture-invitation-tokén'],
    ['2049 characters', 'fixture-invitation-token-'.padEnd(2049, '~')],
  ])(
    'refuses a malformed invitationToken with 400 and forwards nothing: %s',
    async (_label, malformed) => {
      const fetchMock = controlApiAnswers(
        controlApiRecord('POST /external/oidc/profile-flow/attempts plain')
      )
      const res = await (await edge())
        .post(ATTEMPTS)
        .send({ browserBinding: BROWSER_BINDING, invitationToken: malformed })

      expect(res.status).toBe(400)
      expect(res.body).toEqual({ error: 'invalid_oidc_attempt' })
      expect(fetchMock).toHaveBeenCalledTimes(0)
    }
  )

  it('forwards both fields and relays the 400 when Desktop and invitation fields are combined', async () => {
    // control-api owns the rule that an attempt is for Desktop or from an invitation, never
    // both; the edge relays its recorded 400.
    const fetchMock = controlApiAnswers(
      controlApiRecord('POST /external/oidc/profile-flow/attempts invalid')
    )
    const res = await (await edge())
      .post(ATTEMPTS)
      .send({ browserBinding: BROWSER_BINDING, desktopSignIn, invitationToken: INVITATION_TOKEN })

    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'invalid_oidc_attempt' })
    expect(sentBody(fetchMock)).toEqual({
      browserBinding: BROWSER_BINDING,
      desktopSignIn,
      invitationToken: INVITATION_TOKEN,
    })
  })

  it('never logs the invitation token', async () => {
    const logged = consoleSpies()
    const plain = controlApiRecord('POST /external/oidc/profile-flow/attempts plain')
    const fetchMock = controlApiAnswers(plain)
    const app = await edge()

    // A relayed attempt, then a control-api that cannot be reached.
    const relayed = await app
      .post(ATTEMPTS)
      .send({ browserBinding: BROWSER_BINDING, invitationToken: INVITATION_TOKEN })
    fetchMock.mockImplementationOnce(async () => {
      throw new TypeError('fetch failed')
    })
    const unreachable = await app
      .post(ATTEMPTS)
      .send({ browserBinding: BROWSER_BINDING, invitationToken: INVITATION_TOKEN })

    expect(relayed.status).toBe(200)
    // The transport failure went through the app's error handler: its sanitized 500.
    expect(unreachable.status).toBe(500)
    // Both requests reached control-api with the token, so the logging paths ran.
    expect(fetchMock).toHaveBeenCalledTimes(2)
    for (const [, init] of fetchMock.mock.calls) {
      expect(JSON.parse(String(init!.body))).toHaveProperty('invitationToken', INVITATION_TOKEN)
    }
    expect(logged().filter(text => text?.includes(INVITATION_TOKEN))).toEqual([])
  })
})

describe('edge relay of the invitation_email_mismatch refusal at /oidc/profile-flow/complete', () => {
  it('relays refused invitation_email_mismatch', async () => {
    const mismatch = controlApiRecord(MISMATCH)
    expect(mismatch.body.reason).toBe('invitation_email_mismatch')
    const fetchMock = controlApiAnswers(mismatch)
    const res = await (await edge()).post(COMPLETE).send(completeBody)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      outcome: 'refused',
      memberAuthenticationActivated: true,
      reason: 'invitation_email_mismatch',
    })
    expect(res.headers['set-cookie']).toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('still answers 503 for an unlisted reason', async () => {
    const mismatch = controlApiRecord(MISMATCH)
    // A derived variant of the recorded refusal (its reason changed), not a hand-written body.
    const fetchMock = controlApiAnswers({
      ...mismatch,
      body: { ...mismatch.body, reason: 'fixture_unlisted_reason' },
    })
    const res = await (await edge()).post(COMPLETE).send(completeBody)

    expect(res.status).toBe(503)
    expect(res.body).toEqual(NOT_RETRYABLE)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
