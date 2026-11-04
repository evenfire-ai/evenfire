import { afterEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { externalRestPublicErrorHandler } from '../app.js'
import { ControlApiError, controlApiRequest } from '../controlApiClient.js'
import { sanitizeControlApiPublicError, selectPublicCorrelationId } from '../http/publicApiError.js'

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
    const sentinel = privatePostgresSentinel('/var/run/service.sock')
    for (const status of [
      400, 401, 403, 404, 408, 409, 410, 411, 412, 413, 422, 425, 429, 500, 502, 503, 504, 507,
    ]) {
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

  it.each([
    [408, 'request_timeout', true, { 'retry-after': '7' }],
    [411, 'length_required', false, {}],
    [413, 'payload_too_large', false, { 'upload-length': '209715200' }],
    [425, 'too_early', true, { 'retry-after': '7' }],
    [507, 'insufficient_storage', false, {}],
  ] as const)(
    'preserves the safe typed public GFS contract for %s',
    (status, expectedCode, retryable, expectedHeaders) => {
      const sentinel = `private upstream detail at ${privatePostgresSentinel()}`
      const sanitized = sanitizeControlApiPublicError(
        new ControlApiError(
          sentinel,
          status,
          { error: { code: expectedCode, message: sentinel, details: { secret: sentinel } } },
          {
            'retry-after': '7',
            'upload-length': '209715200',
            'x-ratelimit-limit': '16',
            'x-internal-secret': sentinel,
          }
        ),
        new Set([status])
      )

      expect(sanitized).toMatchObject({
        status,
        headers: expectedHeaders,
        body: { error: { code: expectedCode, retryable } },
      })
      expect(JSON.stringify(sanitized)).not.toContain(sentinel)
    }
  )

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
