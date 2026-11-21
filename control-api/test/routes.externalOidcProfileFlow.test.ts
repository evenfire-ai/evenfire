import { describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { OidcPersistenceFailure, OidcProviderUnavailableError } from '../src/oidc/protocolResult.js'
import { createExternalOidcProfileFlowRouter } from '../src/routes/external/oidcProfileFlow.js'
import { createOidcR5ProtocolFixture } from './helpers/oidcR5ProtocolFixture.js'

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

describe('Control API OIDC Profile UI foundation boundary', () => {
  it('returns only the safe callback configuration and inactive-mode marker', async () => {
    const app = appFor({})
    const response = await request(app).get('/external/oidc/profile-flow/configuration')

    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      redirectUri: provider.redirectUri,
      memberAuthenticationActivated: false,
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

describe('Control API OIDC member sign-in (dev spike)', () => {
  const completeBody = {
    state: 'S'.repeat(43),
    code: 'provider-code',
    browserBinding: 'B'.repeat(43),
    issuer: provider.issuer,
  }
  const proof = {
    issuer: provider.issuer,
    subject: 'opaque-provider-subject',
    registrationId: provider.registrationId,
    attributes: { source: 'validated_id_token', email: 'member@example.test', emailVerified: true },
  }

  it('never signs a member in while the switch is off', async () => {
    const signInMember = vi.fn()
    const completeIdentityProofAttempt = vi.fn().mockResolvedValue(proof)
    const app = appFor({ completeIdentityProofAttempt }, { signInMember })
    const response = await request(app)
      .post('/external/oidc/profile-flow/complete')
      .send(completeBody)

    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      outcome: 'identity_proof_verified',
      memberAuthenticationActivated: false,
    })
    expect(completeIdentityProofAttempt).toHaveBeenCalledTimes(1)
    expect(signInMember).not.toHaveBeenCalled()
  })

  it('reports the switch in the Profile UI configuration', async () => {
    const response = await request(appFor({}, { memberSignIn: true })).get(
      '/external/oidc/profile-flow/configuration'
    )
    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      redirectUri: provider.redirectUri,
      memberAuthenticationActivated: true,
    })
  })

  it('returns the member session for a verified identity while the switch is on', async () => {
    const signInMember = vi.fn().mockResolvedValue({
      status: 'signed_in',
      userId: 'user-1',
      token: 'session-token-fixture',
      contract: 'v1',
    })
    const completeIdentityProofAttempt = vi.fn().mockResolvedValue(proof)
    const app = appFor({ completeIdentityProofAttempt }, { memberSignIn: true, signInMember })
    const response = await request(app)
      .post('/external/oidc/profile-flow/complete')
      .send(completeBody)

    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      outcome: 'member_signed_in',
      memberAuthenticationActivated: true,
      token: 'session-token-fixture',
      sessionContract: 'v1',
    })
    expect(signInMember).toHaveBeenCalledWith(proof)
    expect(JSON.stringify(response.body)).not.toMatch(/opaque-provider-subject|member@example/)
  })

  it('issues no session when no member matches the verified identity', async () => {
    const signInMember = vi
      .fn()
      .mockResolvedValue({ status: 'refused', reason: 'email_unverified' })
    const app = appFor(
      { completeIdentityProofAttempt: vi.fn().mockResolvedValue(proof) },
      { memberSignIn: true, signInMember }
    )
    const response = await request(app)
      .post('/external/oidc/profile-flow/complete')
      .send(completeBody)

    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      outcome: 'identity_proof_verified',
      memberAuthenticationActivated: true,
      memberSignIn: 'no_matching_member',
    })
    expect(signInMember).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(response.body)).not.toContain('email_unverified')
  })

  it('asks for a new attempt when session issuance fails after the attempt was consumed', async () => {
    const signInMember = vi.fn().mockRejectedValue(new Error('database unavailable'))
    const app = appFor(
      { completeIdentityProofAttempt: vi.fn().mockResolvedValue(proof) },
      { memberSignIn: true, signInMember }
    )
    const response = await request(app)
      .post('/external/oidc/profile-flow/complete')
      .send(completeBody)

    expect(response.status).toBe(503)
    expect(response.body).toEqual({ error: 'oidc_storage_unavailable', retrySameAttempt: false })
    expect(signInMember).toHaveBeenCalledTimes(1)
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
    const response = await request(app)
      .post('/external/oidc/profile-flow/complete')
      .send(completeBody)

    expect(response.status).toBe(503)
    expect(response.body.error).toBe('oidc_storage_unavailable')
    expect(signInMember).not.toHaveBeenCalled()
  })
})
