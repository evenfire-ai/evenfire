import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { DatabaseError } from 'pg'
import request from 'supertest'
import { pool } from '../src/db.js'
import { OidcPersistenceFailure, OidcProviderUnavailableError } from '../src/oidc/protocolResult.js'
import { createExternalOidcProfileFlowRouter } from '../src/routes/external/oidcProfileFlow.js'
import { createOidcR5ProtocolFixture } from './helpers/oidcR5ProtocolFixture.js'

/** What the route's own logger (component oidc_profile_flow) is asked to write. */
const flowLog = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}))

/** Every OidcProtocolEngine built in this file, with the arguments that matter here. */
const engineConstructions = vi.hoisted(
  () => [] as Array<{ generation: string; policyEvidenceClaimNames: unknown }>
)

vi.mock('../src/observability/logger.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/observability/logger.js')>()
  const rootLogger = new Proxy(actual.rootLogger, {
    get(target, prop, receiver) {
      if (prop !== 'child') return Reflect.get(target, prop, receiver)
      return (bindings: Record<string, unknown>, options?: object) =>
        bindings?.component === 'oidc_profile_flow' ? flowLog : target.child(bindings, options)
    },
  })
  return { ...actual, rootLogger }
})

/**
 * The store's context insert, seen by the route's default writer. The Desktop
 * tests inject their own writer; one test leaves the default in place.
 */
const storeInsertDesktopSignInContext = vi.hoisted(() => vi.fn())

vi.mock('../src/oidc/attemptSignInContextStore.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/oidc/attemptSignInContextStore.js')>()
  return { ...actual, insertDesktopSignInContext: storeInsertDesktopSignInContext }
})

// The route's default engine is the real class, recorded on construction. Its
// network and storage operations are stubbed: the engine cache test only needs
// to see how many engines the route builds, and with which settings.
vi.mock('../src/oidc/protocolEngine.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/oidc/protocolEngine.js')>()
  class RecordedOidcProtocolEngine extends actual.OidcProtocolEngine {
    constructor(...args: ConstructorParameters<typeof actual.OidcProtocolEngine>) {
      super(...args)
      engineConstructions.push({
        generation: args[0].configurationGeneration,
        policyEvidenceClaimNames: args[1].policyEvidenceClaimNames,
      })
    }

    override async beginIdentityProofAttempt() {
      return {
        authorizationUrl: 'https://issuer.example.test/authorize?state=opaque-state',
        expiresAt: new Date('2026-10-30T18:00:00.000Z'),
        attemptId: '7d1f3c2a-9b4e-4f6a-8c5d-2e1b0a9f8c7d',
      }
    }

    override async cancelIdentityProofAttempt() {
      return true
    }
  }
  return { ...actual, OidcProtocolEngine: RecordedOidcProtocolEngine }
})

const provider = createOidcR5ProtocolFixture({ hostPrefix: 'profile-route-contract' }).provider

function appFor(
  engine: object,
  options: { memberSignIn?: boolean; signInMember?: (...args: never[]) => unknown } = {}
) {
  const router = createExternalOidcProfileFlowRouter({
    getProvider: () =>
      options.memberSignIn ? { ...provider, memberAuthenticationActivated: true } : provider,
    createEngine: () => engine as never,
    ...(options.signInMember ? { signInMember: options.signInMember as never } : {}),
  })
  const app = express()
  app.use(express.json())
  app.use(router)
  return app
}

beforeEach(() => {
  for (const method of Object.values(flowLog)) method.mockReset()
  storeInsertDesktopSignInContext.mockReset()
})

/** Every call the route made to its logger, Error objects expanded to their own properties. */
function loggedText(): string {
  const calls = Object.entries(flowLog).map(([level, method]) => [level, method.mock.calls])
  return JSON.stringify(calls, (_key, value) =>
    value instanceof Error ? { message: value.message, stack: value.stack, ...value } : value
  )
}

function loggedEvents(): Array<Record<string, unknown>> {
  return Object.values(flowLog).flatMap(method =>
    method.mock.calls.map(call => call[0] as Record<string, unknown>)
  )
}

describe('Control API OIDC Profile UI foundation boundary', () => {
  it('returns only the safe callback configuration and inactive-mode marker', async () => {
    const app = appFor({})
    const response = await request(app).get('/external/oidc/profile-flow/configuration')

    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      redirectUri: provider.redirectUri,
      memberAuthenticationActivated: false,
      displayLabel: provider.displayLabel,
    })
  })

  it('binds the new protocol attempt and returns no proof or secret material', async () => {
    const beginIdentityProofAttempt = vi.fn().mockResolvedValue({
      authorizationUrl: 'https://issuer.example.test/authorize?state=opaque-state',
      expiresAt: new Date('2026-10-30T18:00:00.000Z'),
      attemptId: '7d1f3c2a-9b4e-4f6a-8c5d-2e1b0a9f8c7d',
    })
    const app = appFor({ beginIdentityProofAttempt })
    const browserBinding = 'B'.repeat(43)
    const response = await request(app)
      .post('/external/oidc/profile-flow/attempts')
      .send({ browserBinding, clientSecret: 'must-not-be-forwarded' })

    expect(response.status).toBe(200)
    // Exact: the attempt id begin returns stays on the server.
    expect(response.body).toEqual({
      authorizationUrl: 'https://issuer.example.test/authorize?state=opaque-state',
      expiresAt: '2026-10-30T18:00:00.000Z',
    })
    expect(beginIdentityProofAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ browserBinding, signal: expect.any(AbortSignal) })
    )
    expect(JSON.stringify(response.body)).not.toContain('must-not-be-forwarded')
  })

  it('discards the validated identity proof and claims from the browser bridge response', async () => {
    const completeIdentityProofAttempt = vi.fn().mockResolvedValue({
      issuer: provider.issuer,
      subject: 'opaque-provider-subject',
      attributes: { email: 'private@example.test' },
      claims: { tenant_id: 'private-tenant' },
      authenticationTime: new Date(),
    })
    const app = appFor({ completeIdentityProofAttempt })
    const response = await request(app)
      .post('/external/oidc/profile-flow/complete')
      .send({
        state: 'S'.repeat(43),
        code: 'provider-code',
        browserBinding: 'B'.repeat(43),
        issuer: provider.issuer,
      })

    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      outcome: 'identity_proof_verified',
      memberAuthenticationActivated: false,
    })
    expect(completeIdentityProofAttempt).toHaveBeenCalledWith(
      {
        state: 'S'.repeat(43),
        code: 'provider-code',
        browserBinding: 'B'.repeat(43),
        issuer: provider.issuer,
      },
      { signal: expect.any(AbortSignal) }
    )
    expect(JSON.stringify(response.body)).not.toMatch(
      /opaque-provider-subject|private@example|private-tenant/
    )
  })

  it('rejects malformed binding values before protocol operations', async () => {
    const beginIdentityProofAttempt = vi.fn()
    const app = appFor({ beginIdentityProofAttempt })
    const response = await request(app)
      .post('/external/oidc/profile-flow/attempts')
      .send({ browserBinding: 'short' })

    expect(response.status).toBe(400)
    expect(response.body).toEqual({ error: 'invalid_oidc_attempt' })
    expect(beginIdentityProofAttempt).not.toHaveBeenCalled()
  })

  it('returns bounded retryability for an unavailable consumed attempt', async () => {
    const error = Object.assign(new OidcProviderUnavailableError(), { retrySameAttempt: false })
    const completeIdentityProofAttempt = vi.fn().mockRejectedValue(error)
    const app = appFor({ completeIdentityProofAttempt })
    const response = await request(app)
      .post('/external/oidc/profile-flow/complete')
      .send({
        state: 'S'.repeat(43),
        code: 'provider-code',
        browserBinding: 'B'.repeat(43),
        issuer: provider.issuer,
      })

    expect(response.status).toBe(503)
    expect(response.body).toEqual({
      error: 'oidc_provider_unavailable',
      retrySameAttempt: false,
    })
  })

  it('returns non-retryable status when cancellation persistence has an unknown outcome', async () => {
    const cancelIdentityProofAttempt = vi
      .fn()
      .mockRejectedValue(new OidcPersistenceFailure('finalize', undefined, undefined, false))
    const app = appFor({ cancelIdentityProofAttempt })
    const response = await request(app)
      .post('/external/oidc/profile-flow/cancel')
      .send({ state: 'S'.repeat(43), browserBinding: 'B'.repeat(43) })

    expect(response.status).toBe(503)
    expect(response.body).toEqual({
      error: 'oidc_storage_unavailable',
      retrySameAttempt: false,
    })
    expect(JSON.stringify(response.body)).not.toContain('finalize')
  })
})

describe('Control API OIDC member sign-in completion', () => {
  const COMPLETE_PATH = '/external/oidc/profile-flow/complete'
  const completeBody = {
    state: 'S'.repeat(43),
    code: 'provider-code',
    browserBinding: 'B'.repeat(43),
    issuer: provider.issuer,
  }
  const MEMBER_EMAIL = 'member@example.test'
  const SUBJECT = 'opaque-provider-subject'
  const proof = {
    issuer: provider.issuer,
    subject: SUBJECT,
    registrationId: provider.registrationId,
    attributes: { source: 'validated_id_token', email: MEMBER_EMAIL, emailVerified: true },
  }
  const REFUSAL_REASONS = [
    'account_disabled',
    'identity_conflict',
    'account_needs_attention',
    'email_claim_missing',
    'email_unverified',
    'not_eligible',
    'no_account',
    'provider_configuration',
  ] as const

  function appWithMemberSignIn(signInMember: (...args: never[]) => unknown, memberSignIn = true) {
    return appFor(
      { completeIdentityProofAttempt: vi.fn().mockResolvedValue(proof) },
      { memberSignIn, signInMember }
    )
  }

  it('configuration includes displayLabel', async () => {
    const response = await request(appFor({}, { memberSignIn: true })).get(
      '/external/oidc/profile-flow/configuration'
    )

    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      redirectUri: provider.redirectUri,
      memberAuthenticationActivated: true,
      displayLabel: provider.displayLabel,
    })
  })

  it('switch off never calls signInMember and returns the exact proof body', async () => {
    // Answers like the real sign-in, so a missing switch check fails on the
    // assertions below rather than on an undefined result.
    const signInMember = vi.fn().mockResolvedValue({ status: 'refused', reason: 'no_account' })
    const completeIdentityProofAttempt = vi.fn().mockResolvedValue(proof)
    const app = appFor({ completeIdentityProofAttempt }, { signInMember })

    const response = await request(app).post(COMPLETE_PATH).send(completeBody)

    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      outcome: 'identity_proof_verified',
      memberAuthenticationActivated: false,
    })
    // The proof was verified, so the sign-in decision was reached and declined.
    expect(completeIdentityProofAttempt).toHaveBeenCalledTimes(1)
    expect(signInMember).not.toHaveBeenCalled()
  })

  it('member_signed_in carries the token', async () => {
    const signInMember = vi.fn().mockResolvedValue({
      status: 'signed_in',
      userId: 'user-1',
      token: 'session-token-fixture',
      contract: 'v1',
      created: { account: true, link: true },
      invitationsApplied: 2,
    })
    const app = appWithMemberSignIn(signInMember)

    const response = await request(app)
      .post(COMPLETE_PATH)
      .set('x-request-id', 'request-fixture-1')
      .send(completeBody)

    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      outcome: 'member_signed_in',
      memberAuthenticationActivated: true,
      token: 'session-token-fixture',
      sessionContract: 'v1',
    })
    // The positive control for the switch-off test: with the switch on, the
    // route calls sign-in once, with the proof and the provider it loaded.
    expect(signInMember).toHaveBeenCalledTimes(1)
    expect(signInMember).toHaveBeenCalledWith(
      proof,
      expect.objectContaining({
        registrationId: provider.registrationId,
        configurationGeneration: provider.configurationGeneration,
        memberAuthenticationActivated: true,
      })
    )
    expect(JSON.stringify(response.body)).not.toMatch(/opaque-provider-subject|member@example/)

    const context = {
      registrationId: provider.registrationId,
      issuer: provider.issuer,
      subjectFingerprint: expect.stringMatching(/^[0-9a-f]{16}$/),
      userId: 'user-1',
      requestId: 'request-fixture-1',
    }
    expect(flowLog.info.mock.calls.map(call => call[0])).toEqual([
      { event: 'oidc_member_account_created', ...context },
      { event: 'oidc_member_link_created', ...context },
      { event: 'oidc_member_invitation_applied', ...context, count: 2 },
      { event: 'oidc_member_signed_in', ...context, sessionContract: 'v1' },
    ])
    expect(flowLog.error).not.toHaveBeenCalled()
    expect(loggedText()).not.toMatch(/session-token-fixture|opaque-provider-subject|member@example/)
  })

  it('logs only the sign-in event for an existing linked member with no invitations', async () => {
    const signInMember = vi.fn().mockResolvedValue({
      status: 'signed_in',
      userId: 'user-2',
      token: 'session-token-fixture',
      contract: 'v2',
      created: { account: false, link: false },
      invitationsApplied: 0,
    })

    const response = await request(appWithMemberSignIn(signInMember))
      .post(COMPLETE_PATH)
      .send(completeBody)

    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({ outcome: 'member_signed_in', sessionContract: 'v2' })
    expect(loggedEvents().map(event => event.event)).toEqual(['oidc_member_signed_in'])
    expect(loggedEvents()[0]).toMatchObject({ userId: 'user-2' })
  })

  it.each(REFUSAL_REASONS)(
    'each refusal reason passes through as outcome refused: %s',
    async reason => {
      const signInMember = vi.fn().mockResolvedValue({ status: 'refused', reason })
      const app = appWithMemberSignIn(signInMember)

      const response = await request(app).post(COMPLETE_PATH).send(completeBody)

      expect(response.status).toBe(200)
      expect(response.body).toEqual({
        outcome: 'refused',
        memberAuthenticationActivated: true,
        reason,
      })
      expect(signInMember).toHaveBeenCalledTimes(1)
      expect(loggedEvents()).toEqual([
        {
          event: 'oidc_member_refused',
          registrationId: provider.registrationId,
          issuer: provider.issuer,
          subjectFingerprint: expect.stringMatching(/^[0-9a-f]{16}$/),
          reason,
        },
      ])
      expect(loggedText()).not.toMatch(/opaque-provider-subject|member@example/)
    }
  )

  it.each([
    ['connection_mismatch', { action: 'use a new registration id' }],
    ['unknown_new_member_team', {}],
    ['email_domain_claim_missing', { action: 'add the xms_edov optional claim to the ID token' }],
  ] as const)(
    'a provider_configuration refusal logs its cause %s and keeps it off the wire',
    async (cause, extra) => {
      const signInMember = vi
        .fn()
        .mockResolvedValue({ status: 'refused', reason: 'provider_configuration', cause })
      const app = appWithMemberSignIn(signInMember)

      const response = await request(app).post(COMPLETE_PATH).send(completeBody)

      expect(response.status).toBe(200)
      expect(response.body).toEqual({
        outcome: 'refused',
        memberAuthenticationActivated: true,
        reason: 'provider_configuration',
      })
      expect(JSON.stringify(response.body)).not.toContain(cause)
      expect(signInMember).toHaveBeenCalledTimes(1)
      expect(flowLog.info).not.toHaveBeenCalled()
      expect(flowLog.warn).toHaveBeenCalledTimes(1)
      expect(flowLog.warn.mock.calls[0]?.[0]).toEqual({
        event: 'oidc_member_refused',
        registrationId: provider.registrationId,
        issuer: provider.issuer,
        subjectFingerprint: expect.stringMatching(/^[0-9a-f]{16}$/),
        reason: 'provider_configuration',
        cause,
        ...extra,
      })
      expect(flowLog.warn.mock.calls[0]?.[1]).toBe(
        {
          connection_mismatch:
            'OIDC member sign-in refused: the registration id is recorded for another issuer or client; use a new registration id',
          unknown_new_member_team:
            'OIDC member sign-in refused: the configured new-member team does not exist',
          email_domain_claim_missing:
            'OIDC member sign-in refused: the ID token has no xms_edov claim; add it as an optional claim in the app registration',
        }[cause]
      )
      expect(loggedText()).not.toMatch(/opaque-provider-subject|member@example/)
    }
  )

  it('sign-in failure is a non-retryable 503 and the log has no err detail', async () => {
    const failure = Object.assign(
      new Error(`duplicate key value violates unique constraint for ${MEMBER_EMAIL}`),
      { code: '23505', detail: `Key (lower(email))=(${MEMBER_EMAIL}) already exists.` }
    )
    const signInMember = vi.fn().mockRejectedValue(failure)
    const app = appWithMemberSignIn(signInMember)

    const response = await request(app).post(COMPLETE_PATH).send(completeBody)

    expect(response.status).toBe(503)
    expect(response.body).toEqual({ error: 'oidc_storage_unavailable', retrySameAttempt: false })
    expect(signInMember).toHaveBeenCalledTimes(1)
    // The failure is logged, with the error reduced to its class and code.
    expect(flowLog.error).toHaveBeenCalledTimes(1)
    expect(flowLog.error.mock.calls[0]?.[0]).toEqual({
      event: 'oidc_member_sign_in_failed',
      registrationId: provider.registrationId,
      issuer: provider.issuer,
      subjectFingerprint: expect.stringMatching(/^[0-9a-f]{16}$/),
      errorClass: 'Error',
      code: '23505',
    })
    const logged = loggedText()
    expect(logged).not.toContain('detail')
    expect(logged).not.toContain(MEMBER_EMAIL)
    expect(logged).not.toContain('duplicate key')
    expect(logged).not.toContain(SUBJECT)
  })

  it('does not attempt sign-in when the identity proof is rejected', async () => {
    const signInMember = vi.fn()
    const app = appFor(
      {
        completeIdentityProofAttempt: vi
          .fn()
          .mockRejectedValue(new OidcPersistenceFailure('claim', undefined, undefined, false)),
      },
      { memberSignIn: true, signInMember }
    )
    const response = await request(app).post(COMPLETE_PATH).send(completeBody)

    expect(response.status).toBe(503)
    expect(response.body.error).toBe('oidc_storage_unavailable')
    expect(signInMember).not.toHaveBeenCalled()
  })

  it('the engine is created once per configuration generation', async () => {
    const generations = {
      a: { ...provider, configurationGeneration: 'engine-cache-generation-a' },
      b: { ...provider, configurationGeneration: 'engine-cache-generation-b' },
    }
    let current = generations.a
    // The default createEngine, so the engine the route builds is the real class.
    const router = createExternalOidcProfileFlowRouter({ getProvider: () => current })
    const app = express()
    app.use(express.json())
    app.use(router)
    const attempt = () =>
      request(app)
        .post('/external/oidc/profile-flow/attempts')
        .send({ browserBinding: 'B'.repeat(43) })
    const cancel = () =>
      request(app)
        .post('/external/oidc/profile-flow/cancel')
        .send({ state: 'S'.repeat(43), browserBinding: 'B'.repeat(43) })
    engineConstructions.length = 0

    expect((await attempt()).status).toBe(200)
    expect((await cancel()).status).toBe(200)
    expect(engineConstructions.map(entry => entry.generation)).toEqual([
      'engine-cache-generation-a',
    ])

    current = generations.b
    expect((await attempt()).status).toBe(200)
    // One entry only: going back to the first generation builds its engine again.
    current = generations.a
    expect((await cancel()).status).toBe(200)

    expect(engineConstructions).toEqual([
      {
        generation: 'engine-cache-generation-a',
        policyEvidenceClaimNames: ['acct', 'idp', 'roles', 'tid', 'xms_edov'],
      },
      {
        generation: 'engine-cache-generation-b',
        policyEvidenceClaimNames: ['acct', 'idp', 'roles', 'tid', 'xms_edov'],
      },
      {
        generation: 'engine-cache-generation-a',
        policyEvidenceClaimNames: ['acct', 'idp', 'roles', 'tid', 'xms_edov'],
      },
    ])
  })

  describe('with the default getProvider', () => {
    const REGISTRATION_ENV = {
      CONTROL_API_OIDC_REGISTRATION_ID: 'company-login',
      CONTROL_API_OIDC_DISPLAY_LABEL: 'Company login',
      CONTROL_API_OIDC_ISSUER: 'https://issuer.example.test/tenant/v2.0',
      CONTROL_API_OIDC_CLIENT_ID: 'test-client-id',
      CONTROL_API_OIDC_CLIENT_SECRET: 'a-test-only-oidc-provider-fixture-secret',
      CONTROL_API_OIDC_CLIENT_AUTH_METHOD: 'client_secret_basic',
      CONTROL_API_OIDC_REDIRECT_URI: 'https://profile.example.test/api/oidc/callback',
      CONTROL_API_OIDC_RESPONSE_MODE: 'query',
      CONTROL_API_OIDC_TRUST_GENERATION: 'config-2026-11-21-1',
    } as const

    function stubOidcEnvironment(guard: string | undefined): void {
      for (const [name, value] of Object.entries(REGISTRATION_ENV)) vi.stubEnv(name, value)
      vi.stubEnv('CONTROL_API_OIDC_MEMBER_SIGN_IN', 'enabled')
      vi.stubEnv('CONTROL_API_OIDC_UNRELEASED', guard)
    }

    afterEach(() => {
      vi.unstubAllEnvs()
    })

    it('the switch without the guard answers 503 oidc_configuration_unavailable with the default getProvider', async () => {
      const signInMember = vi.fn()
      const createEngine = vi.fn()
      const app = express()
      app.use(express.json())
      app.use(createExternalOidcProfileFlowRouter({ createEngine, signInMember }))

      // Positive control: with the guard acknowledged, the same environment loads.
      stubOidcEnvironment('acknowledged')
      const configured = await request(app).get('/external/oidc/profile-flow/configuration')
      expect(configured.status).toBe(200)
      expect(configured.body).toEqual({
        redirectUri: REGISTRATION_ENV.CONTROL_API_OIDC_REDIRECT_URI,
        memberAuthenticationActivated: true,
        displayLabel: REGISTRATION_ENV.CONTROL_API_OIDC_DISPLAY_LABEL,
      })
      expect(flowLog.error).not.toHaveBeenCalled()

      for (const guard of [
        undefined,
        'yes',
        'Acknowledged',
        'ACKNOWLEDGED',
        ' acknowledged',
        'acknowledged ',
      ]) {
        flowLog.error.mockReset()
        stubOidcEnvironment(guard)

        const configuration = await request(app).get('/external/oidc/profile-flow/configuration')
        const attempt = await request(app)
          .post('/external/oidc/profile-flow/attempts')
          .send({ browserBinding: 'B'.repeat(43) })
        const completion = await request(app).post(COMPLETE_PATH).send(completeBody)

        for (const response of [configuration, attempt, completion]) {
          expect(response.status).toBe(503)
          expect(response.body).toEqual({ error: 'oidc_configuration_unavailable' })
        }
        // Loud: every refusal names the guard setting, and nothing else about it.
        expect(flowLog.error).toHaveBeenCalledTimes(3)
        for (const [payload] of flowLog.error.mock.calls) {
          expect(payload).toEqual({
            event: 'oidc_configuration_unavailable',
            errorClass: 'Error',
            fields: ['CONTROL_API_OIDC_UNRELEASED'],
          })
        }
        expect(loggedText()).not.toContain(REGISTRATION_ENV.CONTROL_API_OIDC_CLIENT_SECRET)
      }
      expect(createEngine).not.toHaveBeenCalled()
      expect(signInMember).not.toHaveBeenCalled()
    })

    it('builds a new engine with the new evidence list when the claim name changes', async () => {
      // The default getProvider and createEngine: the route loads the provider
      // from the environment and builds the engine from it.
      const app = express()
      app.use(express.json())
      app.use(createExternalOidcProfileFlowRouter())
      const attemptRequiring = (claimName: string) => {
        stubOidcEnvironment('acknowledged')
        vi.stubEnv('CONTROL_API_OIDC_REQUIRED_CLAIM_NAME', claimName)
        vi.stubEnv('CONTROL_API_OIDC_REQUIRED_CLAIM_VALUE', 'evenfire-users')
        return request(app)
          .post('/external/oidc/profile-flow/attempts')
          .send({ browserBinding: 'B'.repeat(43) })
      }
      engineConstructions.length = 0

      expect((await attemptRequiring('groups')).status).toBe(200)
      expect((await attemptRequiring('department')).status).toBe(200)

      expect(engineConstructions).toHaveLength(2)
      const [first, second] = engineConstructions
      expect(first!.generation).not.toBe(second!.generation)
      expect(first!.policyEvidenceClaimNames).toEqual([
        'acct',
        'groups',
        'idp',
        'roles',
        'tid',
        'xms_edov',
      ])
      expect(second!.policyEvidenceClaimNames).toEqual([
        'acct',
        'department',
        'idp',
        'roles',
        'tid',
        'xms_edov',
      ])
      expect(flowLog.error).not.toHaveBeenCalled()
    })

    /**
     * Each environment loaded before its setting was removed, so the refusal
     * comes from the removed name alone. Account creation then required a
     * domain list, so the role row leaves account creation unset rather than
     * name two removed settings.
     */
    const REMOVED_SETTING_ENV: Record<string, Record<string, string>> = {
      CONTROL_API_OIDC_ALLOWED_EMAIL_DOMAINS: {
        CONTROL_API_OIDC_ACCOUNT_CREATION: 'enabled',
        CONTROL_API_OIDC_ALLOWED_EMAIL_DOMAINS: 'company.example.test',
      },
      CONTROL_API_OIDC_REQUIRED_ROLE: {
        CONTROL_API_OIDC_REQUIRED_ROLE: 'Evenfire.Member',
      },
    }

    it.each(['CONTROL_API_OIDC_ALLOWED_EMAIL_DOMAINS', 'CONTROL_API_OIDC_REQUIRED_ROLE'])(
      'answers 503 and logs the failure for the removed setting %s',
      async setting => {
        const signInMember = vi.fn()
        const createEngine = vi.fn()
        const app = express()
        app.use(express.json())
        app.use(createExternalOidcProfileFlowRouter({ createEngine, signInMember }))
        const settingEnv = REMOVED_SETTING_ENV[setting]!
        stubOidcEnvironment('acknowledged')
        for (const [name, value] of Object.entries(settingEnv)) vi.stubEnv(name, value)

        const configuration = await request(app).get('/external/oidc/profile-flow/configuration')
        const attempt = await request(app)
          .post('/external/oidc/profile-flow/attempts')
          .send({ browserBinding: 'B'.repeat(43) })
        const completion = await request(app).post(COMPLETE_PATH).send(completeBody)

        for (const response of [configuration, attempt, completion]) {
          expect(response.status).toBe(503)
          expect(response.body).toEqual({ error: 'oidc_configuration_unavailable' })
        }
        // Every refusal names the removed setting, and never its value.
        expect(flowLog.error).toHaveBeenCalledTimes(3)
        for (const [payload] of flowLog.error.mock.calls) {
          expect(payload).toEqual({
            event: 'oidc_configuration_unavailable',
            errorClass: 'Error',
            fields: [setting],
          })
        }
        expect(loggedText()).not.toContain(settingEnv[setting])
        expect(createEngine).not.toHaveBeenCalled()
        expect(signInMember).not.toHaveBeenCalled()

        // Control: without the removed setting, the same environment loads.
        flowLog.error.mockReset()
        vi.stubEnv(setting, undefined)
        const configured = await request(app).get('/external/oidc/profile-flow/configuration')
        expect(configured.status).toBe(200)
        expect(configured.body).toEqual({
          redirectUri: REGISTRATION_ENV.CONTROL_API_OIDC_REDIRECT_URI,
          memberAuthenticationActivated: true,
          displayLabel: REGISTRATION_ENV.CONTROL_API_OIDC_DISPLAY_LABEL,
        })
        expect(flowLog.error).not.toHaveBeenCalled()
      }
    )
  })
})

describe('Desktop sign-in at /attempts', () => {
  const ATTEMPTS_PATH = '/external/oidc/profile-flow/attempts'
  const ATTEMPT_ID = '3b9c2e71-5d4a-4f08-9e6b-1a7c8d2f0e45'
  /** The S256 challenge of RFC 7636 Appendix B. */
  const CODE_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'
  const browserBinding = 'B'.repeat(43)
  const begun = {
    authorizationUrl: 'https://issuer.example.test/authorize?state=opaque-state',
    expiresAt: new Date('2026-10-30T18:00:00.000Z'),
    attemptId: ATTEMPT_ID,
  }
  const desktopBody = { browserBinding, desktopSignIn: { codeChallenge: CODE_CHALLENGE } }

  /**
   * The route with member sign-in on (unless switched off), the given engine
   * and context writer (`null` keeps the route's default), and, when `events`
   * is passed, a record of the moment the route answers.
   */
  function desktopApp(
    engine: object,
    writeDesktopSignInContext: ((attemptId: string, codeChallenge: string) => Promise<void>) | null,
    options: { memberSignIn?: boolean; events?: string[] } = {}
  ) {
    const router = createExternalOidcProfileFlowRouter({
      getProvider: () => ({
        ...provider,
        memberAuthenticationActivated: options.memberSignIn ?? true,
      }),
      createEngine: () => engine as never,
      ...(writeDesktopSignInContext ? { writeDesktopSignInContext } : {}),
    })
    const app = express()
    app.use(express.json())
    const events = options.events
    if (events) {
      app.use((_req, res, next) => {
        const json = res.json.bind(res)
        res.json = body => {
          events.push('response')
          return json(body)
        }
        next()
      })
    }
    app.use(router)
    return app
  }

  it('writes no context and sends no echo without desktopSignIn', async () => {
    const beginIdentityProofAttempt = vi.fn().mockResolvedValue(begun)
    const writeDesktopSignInContext = vi.fn().mockResolvedValue(undefined)
    const app = desktopApp({ beginIdentityProofAttempt }, writeDesktopSignInContext)

    const response = await request(app).post(ATTEMPTS_PATH).send({ browserBinding })

    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      authorizationUrl: begun.authorizationUrl,
      expiresAt: '2026-10-30T18:00:00.000Z',
    })
    // Positive control: the attempt was begun, with member sign-in on, and no
    // context went with it.
    expect(beginIdentityProofAttempt).toHaveBeenCalledTimes(1)
    expect(writeDesktopSignInContext).not.toHaveBeenCalled()
  })

  it('answers 409 desktop_sign_in_unavailable and begins nothing when member sign-in is off', async () => {
    const beginIdentityProofAttempt = vi.fn().mockResolvedValue(begun)
    const writeDesktopSignInContext = vi.fn().mockResolvedValue(undefined)
    const app = desktopApp({ beginIdentityProofAttempt }, writeDesktopSignInContext, {
      memberSignIn: false,
    })

    const response = await request(app).post(ATTEMPTS_PATH).send(desktopBody)

    expect(response.status).toBe(409)
    expect(response.body).toEqual({ error: 'desktop_sign_in_unavailable' })
    expect(beginIdentityProofAttempt).not.toHaveBeenCalled()
    expect(writeDesktopSignInContext).not.toHaveBeenCalled()
  })

  it('begins the attempt when member sign-in is on', async () => {
    const beginIdentityProofAttempt = vi.fn().mockResolvedValue(begun)
    const writeDesktopSignInContext = vi.fn().mockResolvedValue(undefined)
    const app = desktopApp({ beginIdentityProofAttempt }, writeDesktopSignInContext)

    const response = await request(app).post(ATTEMPTS_PATH).send(desktopBody)

    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({ signInContext: 'desktop_sign_in' })
    expect(beginIdentityProofAttempt).toHaveBeenCalledTimes(1)
    expect(beginIdentityProofAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ browserBinding, signal: expect.any(AbortSignal) })
    )
    expect(writeDesktopSignInContext).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['a 42-character challenge', { codeChallenge: 'C'.repeat(42) }],
    ['a 44-character challenge', { codeChallenge: 'C'.repeat(44) }],
    ['a challenge outside base64url', { codeChallenge: `${'C'.repeat(42)}+` }],
    ['a challenge that is not a string', { codeChallenge: 43 }],
    ['no challenge', {}],
    ['an extra key', { codeChallenge: CODE_CHALLENGE, codeChallengeMethod: 'S256' }],
    ['null', null],
    ['false', false],
    ['a string', CODE_CHALLENGE],
    ['an array', [CODE_CHALLENGE]],
  ])('refuses a malformed desktopSignIn with 400: %s', async (_label, desktopSignIn) => {
    // Member sign-in is on and begin would succeed: only the shape refuses.
    const beginIdentityProofAttempt = vi.fn().mockResolvedValue(begun)
    const writeDesktopSignInContext = vi.fn().mockResolvedValue(undefined)
    const app = desktopApp({ beginIdentityProofAttempt }, writeDesktopSignInContext)

    const response = await request(app).post(ATTEMPTS_PATH).send({ browserBinding, desktopSignIn })

    expect(response.status).toBe(400)
    expect(response.body).toEqual({ error: 'invalid_oidc_attempt' })
    expect(beginIdentityProofAttempt).not.toHaveBeenCalled()
    expect(writeDesktopSignInContext).not.toHaveBeenCalled()
  })

  it('answers 503 with no authorizationUrl when the context write fails, and logs no challenge', async () => {
    // Postgres 16's answer to a refused context insert: the class, message,
    // length, code, table, constraint and detail layout are copied from a live
    // run; the detail's row carries this test's attempt id and challenge.
    const failure = Object.assign(
      new DatabaseError(
        'new row for relation "oidc_attempt_sign_in_contexts" violates check constraint "oidc_attempt_sign_in_contexts_desktop_code_challenge_check"',
        471,
        'error'
      ),
      {
        severity: 'ERROR',
        code: '23514',
        detail: `Failing row contains (${ATTEMPT_ID}, desktop_sign_in, ${CODE_CHALLENGE}, null, null, 2026-11-24 18:06:06.001167+00).`,
        table: 'oidc_attempt_sign_in_contexts',
        constraint: 'oidc_attempt_sign_in_contexts_desktop_code_challenge_check',
      }
    )
    const beginIdentityProofAttempt = vi.fn().mockResolvedValue(begun)
    const writeDesktopSignInContext = vi.fn().mockRejectedValue(failure)
    const app = desktopApp({ beginIdentityProofAttempt }, writeDesktopSignInContext)

    const response = await request(app).post(ATTEMPTS_PATH).send(desktopBody)

    expect(response.status).toBe(503)
    expect(response.body).toEqual({ error: 'oidc_storage_unavailable' })
    expect(JSON.stringify(response.body)).not.toContain('issuer.example.test')
    expect(beginIdentityProofAttempt).toHaveBeenCalledTimes(1)
    expect(writeDesktopSignInContext).toHaveBeenCalledWith(ATTEMPT_ID, CODE_CHALLENGE)
    // The failure is logged, reduced to its class and code.
    expect(flowLog.error).toHaveBeenCalledTimes(1)
    expect(loggedEvents()).toEqual([
      { event: 'oidc_desktop_context_write_failed', errorClass: 'DatabaseError', code: '23514' },
    ])
    const logged = loggedText()
    expect(logged).not.toContain(CODE_CHALLENGE)
    expect(logged).not.toContain('Failing row')
    expect(logged).not.toContain('violates check constraint')
  })

  it('echoes signInContext after the context is written', async () => {
    const events: string[] = []
    const beginIdentityProofAttempt = vi.fn(async () => {
      events.push('begin')
      return begun
    })
    const writeDesktopSignInContext = vi.fn(async (_attemptId: string, _challenge: string) => {
      events.push('write started')
      // Yield to the event loop: an answer sent without awaiting the write
      // lands before the write finishes.
      await new Promise(resolve => setImmediate(resolve))
      events.push('write finished')
    })
    const app = desktopApp({ beginIdentityProofAttempt }, writeDesktopSignInContext, { events })

    const response = await request(app).post(ATTEMPTS_PATH).send(desktopBody)

    expect(response.status).toBe(200)
    // Exact: the attempt id stays on the server.
    expect(response.body).toEqual({
      authorizationUrl: begun.authorizationUrl,
      expiresAt: '2026-10-30T18:00:00.000Z',
      signInContext: 'desktop_sign_in',
    })
    expect(writeDesktopSignInContext).toHaveBeenCalledTimes(1)
    expect(writeDesktopSignInContext).toHaveBeenCalledWith(ATTEMPT_ID, CODE_CHALLENGE)
    expect(events).toEqual(['begin', 'write started', 'write finished', 'response'])
  })

  it('writes the context through the store on the service pool by default', async () => {
    const beginIdentityProofAttempt = vi.fn().mockResolvedValue(begun)
    storeInsertDesktopSignInContext.mockResolvedValue(undefined)
    const app = desktopApp({ beginIdentityProofAttempt }, null)

    const response = await request(app).post(ATTEMPTS_PATH).send(desktopBody)

    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({ signInContext: 'desktop_sign_in' })
    expect(storeInsertDesktopSignInContext).toHaveBeenCalledTimes(1)
    expect(storeInsertDesktopSignInContext).toHaveBeenCalledWith(pool, ATTEMPT_ID, CODE_CHALLENGE)
  })
})
