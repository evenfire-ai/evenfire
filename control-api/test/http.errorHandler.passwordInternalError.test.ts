import { describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { clerumErrorHandler } from '../src/http/errorHandler.js'
import { correlationIdMiddleware } from '../src/middleware/correlationId.js'
import { PasswordMutationInternalError } from '../src/services/auth/passwordAdmissionError.js'

function appThrowingPasswordMutationInternalError(
  cause: unknown,
  logError: ReturnType<typeof vi.fn>
) {
  const app = express()
  app.use(correlationIdMiddleware)
  app.use((req, _res, next) => {
    req.log = { error: logError } as unknown as NonNullable<typeof req.log>
    next()
  })
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
    next(new PasswordMutationInternalError(cause))
  })
  app.use(clerumErrorHandler)
  return app
}

describe('clerumErrorHandler password mutation internal response', () => {
  it.each([
    ['TypeError', () => new TypeError('private callback diagnostic'), 'type_error'],
    ['ReferenceError', () => new ReferenceError('private callback diagnostic'), 'reference_error'],
    ['RangeError', () => new RangeError('private callback diagnostic'), 'range_error'],
    ['SyntaxError', () => new SyntaxError('private callback diagnostic'), 'syntax_error'],
    ['Error', () => new Error('private callback diagnostic'), 'error'],
    ['non-Error', () => 'private callback diagnostic', 'non_error'],
  ] as const)(
    'logs only safe callback provenance for %s and marks the sanitized 500 non-cacheable',
    async (_label, makeCause, causeKind) => {
      const correlationId = '0f1056c1-0f18-4818-8183-000000000085'
      const logError = vi.fn()
      const response = await request(
        appThrowingPasswordMutationInternalError(makeCause(), logError)
      )
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
      expect(logError).toHaveBeenCalledTimes(1)
      expect(logError).toHaveBeenCalledWith(
        {
          event: 'password_mutation_callback_failed',
          stage: 'mutation_callback',
          causeKind,
          correlationId,
        },
        'password mutation callback failed'
      )
      expect(JSON.stringify(logError.mock.calls)).not.toContain('private callback diagnostic')
    }
  )
})
