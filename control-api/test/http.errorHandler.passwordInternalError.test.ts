import { describe, expect, it } from 'vitest'
import express from 'express'
import request from 'supertest'
import { clerumErrorHandler } from '../src/http/errorHandler.js'
import { correlationIdMiddleware } from '../src/middleware/correlationId.js'
import { PasswordMutationInternalError } from '../src/services/auth/passwordAdmissionError.js'

function appThrowingPasswordMutationInternalError() {
  const app = express()
  app.use(correlationIdMiddleware)
  app.post('/boom', (_req, res, next) => {
    res.set({
      'RateLimit-Limit': '10',
      'RateLimit-Remaining': '9',
      'RateLimit-Policy': '10;w=60',
      'X-RateLimit-Limit': '10',
      'X-RateLimit-Remaining': '9',
      'X-RateLimit-Reset': '1776000000',
      'Retry-After': '30',
    })
    next(new PasswordMutationInternalError())
  })
  app.use(clerumErrorHandler)
  return app
}

describe('clerumErrorHandler password mutation internal response', () => {
  it('clears inherited rate metadata and marks the sanitized 500 as non-cacheable', async () => {
    const correlationId = '0f1056c1-0f18-4818-8183-000000000085'
    const response = await request(appThrowingPasswordMutationInternalError())
      .post('/boom')
      .set('x-correlation-id', correlationId)

    expect(response.status).toBe(500)
    expect(response.body).toEqual({
      error: 'internal_error',
      correlationId,
    })
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.headers['retry-after']).toBeUndefined()
    expect(response.headers['ratelimit-limit']).toBeUndefined()
    expect(response.headers['ratelimit-remaining']).toBeUndefined()
    expect(response.headers['ratelimit-policy']).toBeUndefined()
    expect(response.headers['x-ratelimit-limit']).toBeUndefined()
    expect(response.headers['x-ratelimit-remaining']).toBeUndefined()
    expect(response.headers['x-ratelimit-reset']).toBeUndefined()
  })
})
