import { describe, expect, it } from 'vitest'
import express from 'express'
import request from 'supertest'
import { externalRestPublicErrorHandler } from '../app.js'
import { ControlApiError } from '../controlApiClient.js'

function appThrowing(error: Error) {
  const app = express()
  app.get('/failure', (_req, _res, next) => next(error))
  app.use(externalRestPublicErrorHandler)
  return app
}

describe('External REST public error contract', () => {
  it('never reflects an internal upstream message, path, or secret-like value', async () => {
    const sentinel = 'oauth-secret-at-/var/run/internal/provider.json'
    const response = await request(appThrowing(new Error(sentinel))).get('/failure')

    expect(response.status).toBe(500)
    expect(response.body.error).toEqual({
      code: 'internal_error',
      message: 'The request could not be completed.',
      correlationId: expect.any(String),
      retryable: false,
    })
    expect(JSON.stringify(response.body)).not.toContain(sentinel)
    expect(JSON.stringify(response.body)).not.toContain('/var/run/internal')
  })

  it('preserves authority unavailability without reflecting the Control API body', async () => {
    const response = await request(
      appThrowing(
        new ControlApiError('raw postgres failure', 503, {
          error: 'raw failure at postgres://secret@internal',
        })
      )
    ).get('/failure')

    expect(response.status).toBe(503)
    expect(response.body.error).toEqual({
      code: 'authority_unavailable',
      message: 'Authorization is temporarily unavailable.',
      correlationId: expect.any(String),
      retryable: true,
    })
    expect(JSON.stringify(response.body)).not.toContain('postgres')
    expect(JSON.stringify(response.body)).not.toContain('secret')
  })

  it('maps upstream throttling to the stable retryable rate-limit error', async () => {
    const response = await request(
      appThrowing(new ControlApiError('raw rate limiter state', 429, { internal: 'bucket-key' }))
    ).get('/failure')

    expect(response.status).toBe(429)
    expect(response.body.error).toEqual({
      code: 'rate_limited',
      message: 'Too many requests; retry later.',
      correlationId: expect.any(String),
      retryable: true,
    })
    expect(JSON.stringify(response.body)).not.toContain('bucket-key')
  })
})
