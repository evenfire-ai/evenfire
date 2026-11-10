import { afterEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import {
  type PublicApiErrorCode,
  publicApiErrorBody,
} from '../../control-api/src/http/publicApiError.js'
import { externalRestPublicErrorHandler } from '../src/app.js'
import { createAuthRouter } from '../src/routes/auth.js'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/v1', createAuthRouter())
  app.use(externalRestPublicErrorHandler)
  return app
}

const SESSION_ISSUANCE_SENTENCE =
  'A session could not be issued right now. Try again in two seconds.'

function stubControlApiError(
  status: number,
  code: PublicApiErrorCode,
  headers: Record<string, string>,
  message = 'private upstream message'
) {
  const body = publicApiErrorBody('issuance_ID-42', code, message, true)
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json', ...headers },
      })
    )
  )
}

describe('password admission error forwarding', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('preserves the typed temporary V1 session issuance contract', async () => {
    stubControlApiError(
      503,
      'session_issuance_temporarily_unavailable',
      {
        'retry-after': '2',
        'cache-control': 'no-store',
      },
      SESSION_ISSUANCE_SENTENCE
    )

    const response = await request(buildApp())
      .post('/api/v1/auth/password-login')
      .send({ email: 'user@example.invalid', password: 'synthetic-valid-password' })

    expect(response.status).toBe(503)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.headers['retry-after']).toBe('2')
    expect(response.headers['set-cookie']).toBeUndefined()
    // The producer's own sentence reaches the client: the edge no longer
    // rebuilds a fixed copy for a forwarded 503.
    expect(response.body).toEqual(
      publicApiErrorBody(
        'issuance_ID-42',
        'session_issuance_temporarily_unavailable',
        SESSION_ISSUANCE_SENTENCE,
        true
      )
    )
  })

  it('keeps generic authority failures on the bounded admission response', async () => {
    stubControlApiError(503, 'authority_unavailable', {
      'retry-after': '5',
      'cache-control': 'no-store',
    })

    const response = await request(buildApp())
      .post('/api/v1/auth/password-login')
      .send({ email: 'user@example.invalid', password: 'synthetic-valid-password' })

    expect(response.status).toBe(503)
    expect(response.headers['retry-after']).toBe('5')
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.body).toEqual({ error: 'authority_unavailable', retryAfterSeconds: 5 })
  })

  it('keeps password admission throttling on the bounded rate-limit response', async () => {
    stubControlApiError(429, 'rate_limited', { 'retry-after': '7', 'x-ratelimit-limit': '5' })

    const response = await request(buildApp())
      .post('/api/v1/auth/password-login')
      .send({ email: 'user@example.invalid', password: 'synthetic-valid-password' })

    expect(response.status).toBe(429)
    expect(response.headers['retry-after']).toBe('7')
    expect(response.headers['x-ratelimit-limit']).toBeUndefined()
    expect(response.body).toEqual({ error: 'rate_limited', retryAfterSeconds: 7 })
  })
})
