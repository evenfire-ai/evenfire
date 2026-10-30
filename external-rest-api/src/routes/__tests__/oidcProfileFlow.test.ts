import { afterEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import * as controlApiClient from '../../controlApiClient.js'
import { createOidcProfileFlowRouter } from '../oidcProfileFlow.js'

const requestSpy = vi.spyOn(controlApiClient, 'controlApiRequestWithStatus')

function app() {
  const server = express()
  server.use(express.json())
  server.use(createOidcProfileFlowRouter())
  return server
}

afterEach(() => requestSpy.mockReset())

describe('External REST OIDC Profile UI bridge', () => {
  it('uses only fixed configuration and attempt paths through its service client', async () => {
    requestSpy.mockResolvedValue({
      data: {
        authorizationUrl: 'https://issuer.example.test/authorize?state=opaque',
        expiresAt: '2026-10-30T18:00:00.000Z',
      },
      status: 200,
    } as never)
    const response = await request(app())
      .post('/oidc/profile-flow/attempts')
      .send({ browserBinding: 'B'.repeat(43), path: '/admin/delete' })

    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      authorizationUrl: 'https://issuer.example.test/authorize?state=opaque',
      expiresAt: '2026-10-30T18:00:00.000Z',
    })
    expect(requestSpy).toHaveBeenCalledWith('POST', '/external/oidc/profile-flow/attempts', {
      body: { browserBinding: 'B'.repeat(43) },
    })
  })

  it('returns only the verified-proof completion outcome, never the proof payload', async () => {
    requestSpy.mockResolvedValue({
      data: {
        outcome: 'identity_proof_verified',
        memberAuthenticationActivated: false,
        proof: { subject: 'must-not-escape' },
      },
      status: 200,
    } as never)
    const response = await request(app())
      .post('/oidc/profile-flow/complete')
      .send({ state: 'S'.repeat(43), code: 'provider-code', browserBinding: 'B'.repeat(43) })

    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      outcome: 'identity_proof_verified',
      memberAuthenticationActivated: false,
    })
    expect(JSON.stringify(response.body)).not.toContain('must-not-escape')
  })

  it('does not forward an invalid binding or caller-selected URL/path', async () => {
    const response = await request(app())
      .post('/oidc/profile-flow/attempts')
      .send({ browserBinding: 'short', path: '/admin/delete' })

    expect(response.status).toBe(400)
    expect(response.body).toEqual({ error: 'invalid_oidc_attempt' })
    expect(requestSpy).not.toHaveBeenCalled()
  })

  it('maps unknown internal errors to a bounded unavailable response', async () => {
    requestSpy.mockRejectedValue(
      new controlApiClient.ControlApiError('private upstream detail', 500, {
        error: 'database_password_exposed',
      })
    )
    const response = await request(app()).get('/oidc/profile-flow/configuration')

    expect(response.status).toBe(503)
    expect(response.body).toEqual({ error: 'oidc_unavailable' })
  })
})
