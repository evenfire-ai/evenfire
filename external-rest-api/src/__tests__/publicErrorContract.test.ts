import { describe, expect, it } from 'vitest'
import express from 'express'
import request from 'supertest'
import { externalRestPublicErrorHandler } from '../app.js'
import { ControlApiError } from '../controlApiClient.js'
import { sanitizeControlApiPublicError } from '../http/publicApiError.js'

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
    const upstream = new ControlApiError(
      'raw rate limiter state',
      429,
      {
        error: {
          code: 'rate_limited',
          details: { retryAfterSeconds: 17, bucket: 'secret-internal-bucket' },
        },
      },
      {
        'retry-after': '17',
        'x-ratelimit-limit': '30',
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': '1900000000',
        'x-internal-bucket': 'secret-internal-bucket',
      }
    )
    const response = await request(appThrowing(upstream)).get('/failure')

    expect(response.status).toBe(429)
    expect(response.body.error).toEqual({
      code: 'rate_limited',
      message: 'Too many requests; retry later.',
      correlationId: expect.any(String),
      retryable: true,
      details: { retryAfterSeconds: 17 },
    })
    expect(response.headers['retry-after']).toBe('17')
    expect(response.headers['x-ratelimit-limit']).toBe('30')
    expect(response.headers['x-ratelimit-remaining']).toBe('0')
    expect(response.headers['x-ratelimit-reset']).toBe('1900000000')
    expect(response.headers['x-internal-bucket']).toBeUndefined()
    expect(JSON.stringify(response.body)).not.toContain('secret-internal-bucket')
  })

  it('preserves only a bounded retry delay from legacy rate-limit bodies', () => {
    const sanitized = sanitizeControlApiPublicError(
      new ControlApiError('raw', 429, {
        error: 'Too Many Requests',
        retryAfterSeconds: 17,
        bucket: 'secret-internal-bucket',
      }),
      new Set([429])
    )

    expect(sanitized?.body).toMatchObject({
      error: {
        code: 'rate_limited',
        details: { retryAfterSeconds: 17 },
      },
    })
    expect(JSON.stringify(sanitized?.body)).not.toContain('secret-internal-bucket')
  })

  it('preserves only allowlisted GFS denial details from legacy bodies', () => {
    const sanitized = sanitizeControlApiPublicError(
      new ControlApiError('raw', 400, {
        error: 'subjects_invalid',
        invalidIndexes: [0, 2],
        sql: 'SELECT secret',
      }),
      new Set([400])
    )

    expect(sanitized?.body).toMatchObject({
      error: {
        code: 'invalid_request',
        details: { reason: 'subjects_invalid', invalidIndexes: [0, 2] },
      },
    })
    expect(JSON.stringify(sanitized?.body)).not.toContain('SELECT secret')
  })

  it('rebuilds every forwarded route class from a bounded typed envelope', () => {
    const sentinel = 'postgres://secret@internal/var/run/service.sock'
    for (const status of [400, 401, 403, 404, 409, 410, 412, 422, 429, 500, 502, 503, 504]) {
      const sanitized = sanitizeControlApiPublicError(
        new ControlApiError(sentinel, status, {
          error: {
            code: status === 409 ? 'access_path_required' : 'made_up_internal_code',
            message: sentinel,
            correlationId: `bad/${sentinel}`,
            details: { sql: sentinel, path: sentinel, secret: sentinel },
          },
        }),
        new Set([status])
      )

      expect(sanitized?.status).toBe(status)
      expect(JSON.stringify(sanitized?.body)).not.toContain(sentinel)
      expect(JSON.stringify(sanitized?.body)).not.toContain('made_up_internal_code')
    }
  })

  it('preserves only bounded access-path descriptors for an ambiguity response', () => {
    const pathId = `ap1_${'a'.repeat(43)}`
    const sanitized = sanitizeControlApiPublicError(
      new ControlApiError('raw', 409, {
        error: {
          code: 'access_path_required',
          message: 'raw',
          details: {
            paths: [{ id: pathId, kind: 'team', teamId: 'team-safe' }],
            sql: 'SELECT secret',
          },
        },
      }),
      new Set([409])
    )

    expect(sanitized?.body).toMatchObject({
      error: {
        code: 'access_path_required',
        details: { paths: [{ id: pathId, kind: 'team', teamId: 'team-safe' }] },
      },
    })
    expect(JSON.stringify(sanitized?.body)).not.toContain('SELECT secret')
  })
})
