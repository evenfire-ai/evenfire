import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
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
})

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
    })
    const app = appFor({ beginIdentityProofAttempt })
    const browserBinding = 'B'.repeat(43)
    const response = await request(app)
      .post('/external/oidc/profile-flow/attempts')
      .send({ browserBinding, clientSecret: 'must-not-be-forwarded' })

    expect(response.status).toBe(200)
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
     * Each environment loads once its removed setting is taken out, so the
     * refusal comes from the removed name alone. The domain-list row keeps
     * account creation on, which needs a required claim value; the role row
     * leaves account creation unset.
     */
    const REMOVED_SETTING_ENV: Record<string, Record<string, string>> = {
      CONTROL_API_OIDC_ALLOWED_EMAIL_DOMAINS: {
        CONTROL_API_OIDC_ACCOUNT_CREATION: 'enabled',
        CONTROL_API_OIDC_REQUIRED_CLAIM_VALUE: 'Evenfire.Member',
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

    it.each([
      ['CONTROL_API_OIDC_ALLOWED_EMAIL_DOMAINS', 'retired-domain-list.example.test'],
      ['CONTROL_API_OIDC_REQUIRED_ROLE', 'Retired.Role.Assignment'],
    ])('answers 503 for a leftover %s when no registration is set', async (setting, value) => {
      for (const key of Object.keys(process.env)) {
        if (key.startsWith('CONTROL_API_OIDC_')) vi.stubEnv(key, undefined)
      }
      vi.stubEnv(setting, value)
      const app = express()
      app.use(express.json())
      app.use(createExternalOidcProfileFlowRouter())

      const configuration = await request(app).get('/external/oidc/profile-flow/configuration')

      expect(configuration.status).toBe(503)
      expect(configuration.body).toEqual({ error: 'oidc_configuration_unavailable' })
      expect(flowLog.error).toHaveBeenCalledTimes(1)
      expect(flowLog.error.mock.calls[0]?.[0]).toEqual({
        event: 'oidc_configuration_unavailable',
        errorClass: 'Error',
        fields: [setting],
      })
      expect(loggedText()).not.toContain(value)

      // With the leftover removed, the same empty registration is not configured.
      flowLog.error.mockReset()
      vi.stubEnv(setting, undefined)
      const absent = await request(app).get('/external/oidc/profile-flow/configuration')
      expect(absent.status).toBe(404)
      expect(absent.body).toEqual({ error: 'oidc_not_configured' })
      expect(flowLog.error).not.toHaveBeenCalled()
    })
  })
})
