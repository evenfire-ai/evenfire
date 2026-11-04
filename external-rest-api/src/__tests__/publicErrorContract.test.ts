import { afterEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { externalRestPublicErrorHandler } from '../app.js'
import { ControlApiError, controlApiRequest } from '../controlApiClient.js'
import { selectPublicCorrelationId } from '../http/publicApiError.js'

function appThrowing(error: Error) {
  const app = express()
  app.get('/failure', (_req, _res, next) => next(error))
  app.use(externalRestPublicErrorHandler)
  return app
}

function privatePostgresSentinel(suffix = ''): string {
  return ['postgres://secret@', 'internal', suffix].join('')
}

describe('External REST public error contract', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('preserves only bounded public correlation IDs through the mounted global handler', async () => {
    const valid = await request(appThrowing(new Error('private')))
      .get('/failure')
      .set('x-correlation-id', 'request_ID-42')
    expect(valid.body.error.correlationId).toBe('request_ID-42')

    for (const rejected of ['request/with/delimiters', 'x'.repeat(129)]) {
      const response = await request(appThrowing(new Error('private')))
        .get('/failure')
        .set('x-correlation-id', rejected)
      expect(response.body.error.correlationId).not.toBe(rejected)
      expect(response.body.error.correlationId).toMatch(/^[A-Za-z0-9_-]{1,128}$/)
    }
  })

  it('requires the supplied correlation value itself to match without whitespace normalization', () => {
    expect(selectPublicCorrelationId(' upstream_ID-42 ', 'request_ID-42')).toBe('request_ID-42')
    const generated = selectPublicCorrelationId(' request_ID-42 ')
    expect(generated).not.toBe('request_ID-42')
    expect(generated).toMatch(/^[A-Za-z0-9_-]{1,128}$/)
  })

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

  it('forwards a control-api 503 body verbatim and never the internal wrapper', async () => {
    const response = await request(
      appThrowing(
        new ControlApiError('raw postgres failure at ' + privatePostgresSentinel(), 503, {
          error: 'session_backend_unavailable',
        })
      )
    ).get('/failure')

    expect(response.status).toBe(503)
    expect(response.body).toEqual({ error: 'session_backend_unavailable' })
    expect(JSON.stringify(response.body)).not.toContain('postgres')
    expect(JSON.stringify(response.body)).not.toContain('Control API')
  })

  it('preserves bounded retry guidance for inadmissible V1 session issuance', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              code: 'session_issuance_temporarily_unavailable',
              message: 'private upstream message',
              correlationId: 'correlation_123',
              retryable: true,
            },
          }),
          {
            status: 503,
            headers: {
              'content-type': 'application/json',
              'retry-after': '2',
              'cache-control': 'no-store',
              'x-internal-secret': 'must-not-cross',
            },
          }
        )
      )
    )

    const upstream = await controlApiRequest('POST', '/external/auth/password-login').catch(
      (error: unknown) => error
    )
    expect(upstream).toBeInstanceOf(ControlApiError)
    if (!(upstream instanceof ControlApiError)) throw new Error('expected ControlApiError')

    const response = await request(appThrowing(upstream)).get('/failure')
    expect(response.status).toBe(503)
    expect(response.headers['retry-after']).toBe('2')
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.body).toEqual({
      error: {
        code: 'session_issuance_temporarily_unavailable',
        message: 'private upstream message',
        correlationId: 'correlation_123',
        retryable: true,
      },
    })
    expect(response.headers['x-internal-secret']).toBeUndefined()
    expect(JSON.stringify(response.body)).not.toContain('Control API')
  })

  it('forwards an upstream throttling body verbatim without relaying private state', async () => {
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
    expect(response.body).toEqual({
      error: {
        code: 'rate_limited',
        details: { retryAfterSeconds: 17, bucket: 'secret-internal-bucket' },
      },
    })
    // The global handler relays outage headers for a 503 only; the GFS route
    // keeps its own allowlist. The internal bucket never crosses.
    expect(response.headers['retry-after']).toBeUndefined()
    expect(response.headers['x-internal-bucket']).toBeUndefined()
  })
})
