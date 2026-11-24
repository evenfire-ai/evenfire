import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { clerumErrorHandler } from '../src/http/errorHandler.js'
import type { OidcProviderConfiguration } from '../src/oidc/configuration.js'
import { createExternalOidcDesktopSignInRouter } from '../src/routes/external/oidcDesktopSignIn.js'
import type { EffectiveUserAccessPolicy } from '../src/services/access/userAccessPolicy.js'
import { ExternalSessionIssuanceUnavailableError } from '../src/services/auth/externalSessionIssuance.js'
import { createOidcMemberSignInFakeProvider } from './helpers/oidcMemberSignInFakeProvider.js'

/**
 * The redeem route with an injected `redeem`: what it checks before any
 * transaction, what it passes to redeem, and how each result is answered and
 * logged. The redeem service itself runs on real PostgreSQL in its own suite.
 */
const desktopLog = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}))
const flowLog = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}))
/** What the root logger itself is asked to write; the shared error handler logs here. */
const rootLog = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}))
const resolveEffectiveUserAccessPolicy = vi.hoisted(() => vi.fn())

vi.mock('../src/observability/logger.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/observability/logger.js')>()
  const rootLogger = new Proxy(actual.rootLogger, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && Object.hasOwn(rootLog, prop)) {
        return rootLog[prop as keyof typeof rootLog]
      }
      if (prop !== 'child') return Reflect.get(target, prop, receiver)
      return (bindings: Record<string, unknown>, options?: object) => {
        if (bindings?.component === 'oidc_desktop_sign_in') return desktopLog
        if (bindings?.component === 'oidc_profile_flow') return flowLog
        return target.child(bindings, options)
      }
    },
  })
  return { ...actual, rootLogger }
})

vi.mock('../src/services/access/userAccessRuntimePolicy.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/services/access/userAccessRuntimePolicy.js')>()),
  resolveEffectiveUserAccessPolicy,
}))

const REDEEM_PATH = '/external/oidc/desktop-sign-in/redeem'
const DESKTOP_CODE = 'fixture-desktop-code-'.padEnd(43, 'd')
const CODE_VERIFIER = 'fixture-desktop-verifier-'.padEnd(43, 'v')
const SESSION_TOKEN = 'session-token-fixture-desktop'
const MEMBER_EMAIL = 'desktop-member@fixture.test'
const USER_ID = '6a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'

const provider = createOidcMemberSignInFakeProvider().provider

const sessionPolicy: EffectiveUserAccessPolicy = Object.freeze({
  policyVersion: '1',
  policyRevision: 'desktop-redeem-fixture',
  acceptV1: true,
  issueV1: true,
  acceptV2: true,
  issueV2: true,
  renewV2: true,
  switchCompatibility: false,
  actionContextV2: false,
  rpcDelegationV2: false,
  minimumClientVersion: null,
  enforceMinimumClient: false,
})

/** No session format can be selected for a client that requests none. */
const noLegacyIssuancePolicy: EffectiveUserAccessPolicy = Object.freeze({
  ...sessionPolicy,
  policyRevision: 'desktop-redeem-no-v1-fixture',
  issueV1: false,
})

const signedInBody = {
  token: SESSION_TOKEN,
  sessionContract: 'v1',
  me: {
    id: USER_ID,
    email: MEMBER_EMAIL,
    name: 'Desktop Fixture Member',
    picture: null,
    teamId: '0b1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e',
    teamName: 'Fixture team',
    role: 'member',
  },
} as const

const redeemBody = { code: DESKTOP_CODE, codeVerifier: CODE_VERIFIER }

type RouterDependencies = NonNullable<Parameters<typeof createExternalOidcDesktopSignInRouter>[0]>

function appFor(dependencies: RouterDependencies) {
  const app = express()
  app.use(express.json())
  app.use(createExternalOidcDesktopSignInRouter(dependencies))
  app.use(clerumErrorHandler)
  return app
}

const allLogMethods = () => [
  ...Object.values(desktopLog),
  ...Object.values(flowLog),
  ...Object.values(rootLog),
]

/** Every call made to the route's loggers and to the root logger, Error objects expanded. */
function loggedText(): string {
  return JSON.stringify(
    allLogMethods().map(method => method.mock.calls),
    (_key, value) =>
      value instanceof Error ? { message: value.message, stack: value.stack, ...value } : value
  )
}

function desktopEvents(): Array<Record<string, unknown>> {
  return Object.values(desktopLog).flatMap(method =>
    method.mock.calls.map(call => call[0] as Record<string, unknown>)
  )
}

const member = {
  registrationId: provider.registrationId,
  issuer: provider.issuer,
  userId: USER_ID,
  requestId: 'request-fixture-redeem',
}

beforeEach(() => {
  for (const method of allLogMethods()) method.mockReset()
  resolveEffectiveUserAccessPolicy.mockReset().mockResolvedValue(sessionPolicy)
})

describe('POST /external/oidc/desktop-sign-in/redeem', () => {
  const rows = [
    [
      'signed_in',
      { status: 'signed_in', body: signedInBody },
      200,
      signedInBody,
      [{ event: 'oidc_desktop_code_redeemed', ...member, sessionContract: 'v1' }],
    ],
    [
      'invalid_code',
      { status: 'invalid_code' },
      400,
      { error: 'invalid_desktop_sign_in_code' },
      [],
    ],
    [
      'refused',
      { status: 'refused', reason: 'account_disabled', userId: USER_ID },
      403,
      { error: 'desktop_sign_in_refused', reason: 'account_disabled' },
      [{ event: 'oidc_desktop_code_refused', ...member, reason: 'account_disabled' }],
    ],
    [
      'unavailable',
      { status: 'unavailable', userId: USER_ID },
      409,
      { error: 'desktop_sign_in_unavailable' },
      [{ event: 'oidc_desktop_code_connection_mismatch', ...member }],
    ],
  ] as const

  it.each(rows)('maps %s to its status and body', async (_name, result, status, body, events) => {
    const redeem = vi.fn().mockResolvedValue(result)

    const response = await request(appFor({ getProvider: () => provider, redeem }))
      .post(REDEEM_PATH)
      .set('x-request-id', 'request-fixture-redeem')
      .send(redeemBody)

    expect(response.status).toBe(status)
    expect(response.body).toEqual(body)
    expect(redeem).toHaveBeenCalledTimes(1)
    expect(redeem).toHaveBeenCalledWith({
      code: DESKTOP_CODE,
      codeVerifier: CODE_VERIFIER,
      provider,
      contract: 'v1',
      sessionPolicy,
    })
    expect(desktopEvents()).toEqual(events)
    // Never the code, the verifier, the token or the email.
    for (const secret of [DESKTOP_CODE, CODE_VERIFIER, SESSION_TOKEN, MEMBER_EMAIL]) {
      expect(loggedText()).not.toContain(secret)
    }
  })

  it('passes the session contract the client requests to redeem', async () => {
    const redeem = vi.fn().mockResolvedValue({
      status: 'signed_in',
      body: { ...signedInBody, sessionContract: 'v2' },
    })

    const response = await request(appFor({ getProvider: () => provider, redeem }))
      .post(REDEEM_PATH)
      .send({ ...redeemBody, sessionContract: 'v2' })

    expect(response.status).toBe(200)
    expect(redeem).toHaveBeenCalledWith(expect.objectContaining({ contract: 'v2', sessionPolicy }))
  })

  it('answers 400 for a malformed code without calling redeem', async () => {
    const redeem = vi.fn().mockResolvedValue({ status: 'signed_in', body: signedInBody })
    const getProvider = vi.fn(() => provider)
    const app = appFor({ getProvider, redeem })
    const malformed: unknown[] = [
      {},
      { codeVerifier: CODE_VERIFIER },
      { code: DESKTOP_CODE },
      { ...redeemBody, code: DESKTOP_CODE.slice(1) },
      { ...redeemBody, code: `${DESKTOP_CODE}d` },
      { ...redeemBody, code: `${DESKTOP_CODE.slice(1)}+` },
      { ...redeemBody, code: 42 },
      { ...redeemBody, code: [DESKTOP_CODE] },
      { ...redeemBody, codeVerifier: CODE_VERIFIER.slice(1) },
      { ...redeemBody, codeVerifier: 'v'.repeat(129) },
      { ...redeemBody, codeVerifier: `${CODE_VERIFIER.slice(1)}+` },
      { ...redeemBody, codeVerifier: { value: CODE_VERIFIER } },
    ]

    for (const body of malformed) {
      const response = await request(app)
        .post(REDEEM_PATH)
        .send(body as object)
      expect(response.status, JSON.stringify(body)).toBe(400)
      expect(response.body).toEqual({ error: 'invalid_desktop_sign_in_code' })
    }
    expect(redeem).not.toHaveBeenCalled()
    expect(getProvider).not.toHaveBeenCalled()

    // Positive control: well-formed requests reach redeem, at both verifier
    // length bounds and with every RFC 7636 unreserved character.
    const wellFormed = [
      redeemBody,
      { code: DESKTOP_CODE, codeVerifier: 'A-z.0_9~'.padEnd(43, 'x') },
      { code: DESKTOP_CODE, codeVerifier: 'A-z.0_9~'.padEnd(128, 'x') },
    ]
    for (const body of wellFormed) {
      const response = await request(app).post(REDEEM_PATH).send(body)
      expect(response.status, JSON.stringify(body)).toBe(200)
    }
    expect(redeem).toHaveBeenCalledTimes(wellFormed.length)
    expect(redeem.mock.calls.map(call => call[0].codeVerifier)).toEqual(
      wellFormed.map(body => body.codeVerifier)
    )
  })

  it('answers 426 before redeem runs when no session format can be selected', async () => {
    const redeem = vi.fn().mockResolvedValue({ status: 'signed_in', body: signedInBody })
    const app = appFor({ getProvider: () => provider, redeem })
    resolveEffectiveUserAccessPolicy.mockResolvedValue(noLegacyIssuancePolicy)

    const refused = await request(app).post(REDEEM_PATH).send(redeemBody)

    expect(refused.status).toBe(426)
    expect(refused.body).toEqual({ error: 'upgrade_required' })
    expect(resolveEffectiveUserAccessPolicy).toHaveBeenCalledTimes(1)
    expect(redeem).not.toHaveBeenCalled()

    // Positive control: with a selectable format the same request reaches redeem.
    resolveEffectiveUserAccessPolicy.mockResolvedValue(sessionPolicy)
    const accepted = await request(app).post(REDEEM_PATH).send(redeemBody)

    expect(accepted.status).toBe(200)
    expect(redeem).toHaveBeenCalledTimes(1)
  })

  it('answers 409 without calling redeem when the provider fails to load', async () => {
    const redeem = vi.fn().mockResolvedValue({ status: 'signed_in', body: signedInBody })
    const getProvider = vi.fn<() => OidcProviderConfiguration | undefined>(() => {
      throw new Error('CONTROL_API_OIDC_ISSUER must be an absolute URL')
    })
    const app = appFor({ getProvider, redeem })

    const refused = await request(app).post(REDEEM_PATH).send(redeemBody)

    expect(refused.status).toBe(409)
    expect(refused.body).toEqual({ error: 'desktop_sign_in_unavailable' })
    expect(redeem).not.toHaveBeenCalled()
    expect(resolveEffectiveUserAccessPolicy).not.toHaveBeenCalled()
    // The failure is logged as every OIDC route logs it: the setting, never its value.
    expect(flowLog.error).toHaveBeenCalledWith(
      {
        event: 'oidc_configuration_unavailable',
        errorClass: 'Error',
        fields: ['CONTROL_API_OIDC_ISSUER'],
      },
      expect.any(String)
    )

    // Positive control: once the provider loads, the same request reaches redeem.
    getProvider.mockImplementation(() => provider)
    const accepted = await request(app).post(REDEEM_PATH).send(redeemBody)

    expect(accepted.status).toBe(200)
    expect(redeem).toHaveBeenCalledTimes(1)
  })

  it('answers 409 without calling redeem when no provider is configured', async () => {
    const redeem = vi.fn().mockResolvedValue({ status: 'signed_in', body: signedInBody })
    const getProvider = vi.fn<() => OidcProviderConfiguration | undefined>(() => undefined)
    const app = appFor({ getProvider, redeem })

    const refused = await request(app).post(REDEEM_PATH).send(redeemBody)

    expect(refused.status).toBe(409)
    expect(refused.body).toEqual({ error: 'desktop_sign_in_unavailable' })
    expect(redeem).not.toHaveBeenCalled()

    getProvider.mockImplementation(() => provider)
    const accepted = await request(app).post(REDEEM_PATH).send(redeemBody)

    expect(accepted.status).toBe(200)
    expect(redeem).toHaveBeenCalledTimes(1)
  })

  it('leaves the member sign-in switch to redeem, which spends the code', async () => {
    // A switch-off found after mint is decided inside redeem's transaction,
    // which commits the delete; the route must not answer 409 before it.
    const switchedOff = { ...provider, memberSignIn: null, memberAuthenticationActivated: false }
    const redeem = vi.fn().mockResolvedValue({ status: 'unavailable', userId: USER_ID })

    const response = await request(appFor({ getProvider: () => switchedOff, redeem }))
      .post(REDEEM_PATH)
      .send(redeemBody)

    expect(response.status).toBe(409)
    expect(response.body).toEqual({ error: 'desktop_sign_in_unavailable' })
    expect(redeem).toHaveBeenCalledTimes(1)
    expect(redeem).toHaveBeenCalledWith(expect.objectContaining({ provider: switchedOff }))
  })

  it('answers 503 session_issuance_temporarily_unavailable through the error handler', async () => {
    const redeem = vi.fn().mockRejectedValue(new ExternalSessionIssuanceUnavailableError())

    const response = await request(appFor({ getProvider: () => provider, redeem }))
      .post(REDEEM_PATH)
      .send(redeemBody)

    expect(redeem).toHaveBeenCalledTimes(1)
    expect(response.status).toBe(503)
    expect(response.headers['retry-after']).toBe('2')
    expect(response.body.error).toMatchObject({
      code: 'session_issuance_temporarily_unavailable',
      retryable: true,
    })
    expect(desktopEvents()).toEqual([])
  })

  const failures = [
    ['redeem', 'redeem'],
    ['the access policy', 'policy'],
  ] as const

  it.each(failures)(
    'answers 503 oidc_storage_unavailable and logs only the class and code when %s fails',
    async (_name, failing) => {
      const sentinel = 'sentinel-fixture-row-value'
      const failure = Object.assign(new Error(`database detail ${sentinel}`), { code: 'XX000' })
      const redeem = vi.fn().mockResolvedValue({ status: 'signed_in', body: signedInBody })
      if (failing === 'redeem') redeem.mockRejectedValue(failure)
      else resolveEffectiveUserAccessPolicy.mockRejectedValue(failure)

      const response = await request(appFor({ getProvider: () => provider, redeem }))
        .post(REDEEM_PATH)
        .set('x-request-id', 'request-fixture-redeem')
        .send(redeemBody)

      expect(response.status).toBe(503)
      expect(response.body).toEqual({ error: 'oidc_storage_unavailable' })
      expect(redeem).toHaveBeenCalledTimes(failing === 'redeem' ? 1 : 0)
      expect(desktopEvents()).toEqual([
        {
          event: 'oidc_desktop_code_redeem_failed',
          registrationId: provider.registrationId,
          issuer: provider.issuer,
          requestId: 'request-fixture-redeem',
          errorClass: 'Error',
          code: 'XX000',
        },
      ])
      // Neither the message nor a stack is logged anywhere, the root logger included.
      expect(loggedText()).not.toContain(sentinel)
      expect(loggedText()).not.toContain('routes.externalOidcDesktopSignIn.test')
      expect(JSON.stringify(response.body)).not.toContain(sentinel)
    }
  )
})
