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

  it('forwards an upstream throttling body verbatim with its quota headers and no private state', async () => {
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
        ratelimit: 'limit=30, remaining=0, reset=17',
        'ratelimit-policy': '30;w=60',
        'x-ratelimit-limit': '30',
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': '1900000000',
        'x-request-id': 'upstream-request-7',
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
    expect(response.headers['retry-after']).toBe('17')
    expect(response.headers.ratelimit).toBe('limit=30, remaining=0, reset=17')
    expect(response.headers['ratelimit-policy']).toBe('30;w=60')
    expect(response.headers['x-ratelimit-limit']).toBe('30')
    expect(response.headers['x-ratelimit-remaining']).toBe('0')
    expect(response.headers['x-ratelimit-reset']).toBe('1900000000')
    // The request id stays a GFS-route relay; the internal bucket never crosses.
    expect(response.headers['x-request-id']).toBeUndefined()
    expect(response.headers['x-internal-bucket']).toBeUndefined()
  })

  it('drops throttling header values outside the numeric public bounds', async () => {
    const upstream = new ControlApiError(
      'raw rate limiter state',
      429,
      { error: 'rate_limited' },
      {
        'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT',
        'x-ratelimit-limit': '-1',
        'x-ratelimit-remaining': '12345678901',
        'x-ratelimit-reset': '1900000000',
      }
    )
    const response = await request(appThrowing(upstream)).get('/failure')

    expect(response.status).toBe(429)
    expect(response.body).toEqual({ error: 'rate_limited' })
    // Witness: the one in-bounds value of the same response is relayed.
    expect(response.headers['x-ratelimit-reset']).toBe('1900000000')
    expect(response.headers['retry-after']).toBeUndefined()
    expect(response.headers['x-ratelimit-limit']).toBeUndefined()
    expect(response.headers['x-ratelimit-remaining']).toBeUndefined()

    for (const outOfRange of ['0', '86401']) {
      const outage = await request(
        appThrowing(
          new ControlApiError(
            'raw outage',
            503,
            { error: 'session_backend_unavailable' },
            { 'retry-after': outOfRange, 'cache-control': 'no-store' }
          )
        )
      ).get('/failure')
      expect(outage.status).toBe(503)
      expect(outage.headers['cache-control']).toBe('no-store')
      expect(outage.headers['retry-after']).toBeUndefined()
    }
  })

  it.each([408, 425, 502, 504])(
    'relays retry guidance, and no quota state, on a retryable %i',
    async status => {
      const upstream = new ControlApiError(
        'raw upstream failure',
        status,
        { error: 'temporarily_unavailable' },
        {
          'retry-after': '5',
          ratelimit: 'limit=30, remaining=0, reset=5',
          'x-ratelimit-limit': '30',
          'cache-control': 'no-store',
        }
      )
      const response = await request(appThrowing(upstream)).get('/failure')

      expect(response.status).toBe(status)
      expect(response.body).toEqual({ error: 'temporarily_unavailable' })
      expect(response.headers['retry-after']).toBe('5')
      expect(response.headers.ratelimit).toBeUndefined()
      expect(response.headers['x-ratelimit-limit']).toBeUndefined()
      expect(response.headers['cache-control']).toBeUndefined()
    }
  )

  it('relays no retry or quota header on a non-retryable client error', async () => {
    const upstream = new ControlApiError(
      'raw validation failure',
      400,
      { error: { code: 'invalid_request', message: 'name is required' } },
      {
        'retry-after': '5',
        ratelimit: 'limit=30, remaining=29, reset=5',
        'x-ratelimit-limit': '30',
      }
    )
    const response = await request(appThrowing(upstream)).get('/failure')

    // Witness: the handler ran the ControlApiError branch and forwarded the body.
    expect(response.status).toBe(400)
    expect(response.body).toEqual({
      error: { code: 'invalid_request', message: 'name is required' },
    })
    expect(response.headers['retry-after']).toBeUndefined()
    expect(response.headers.ratelimit).toBeUndefined()
    expect(response.headers['x-ratelimit-limit']).toBeUndefined()
  })
})
