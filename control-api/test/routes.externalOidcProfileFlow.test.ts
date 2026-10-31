import { describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { OidcPersistenceFailure, OidcProviderUnavailableError } from '../src/oidc/protocolResult.js'
import { createExternalOidcProfileFlowRouter } from '../src/routes/external/oidcProfileFlow.js'
import { createOidcR5ProtocolFixture } from './helpers/oidcR5ProtocolFixture.js'

const provider = createOidcR5ProtocolFixture({ hostPrefix: 'profile-route-contract' }).provider

function appFor(engine: object) {
  const router = createExternalOidcProfileFlowRouter({
    getProvider: () => provider,
    createEngine: () => engine as never,
  })
  const app = express()
  app.use(express.json())
  app.use('/external', router)
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
    expect(beginIdentityProofAttempt).toHaveBeenCalledWith({ browserBinding })
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
    expect(completeIdentityProofAttempt).toHaveBeenCalledWith({
      state: 'S'.repeat(43),
      code: 'provider-code',
      browserBinding: 'B'.repeat(43),
      issuer: provider.issuer,
    })
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
