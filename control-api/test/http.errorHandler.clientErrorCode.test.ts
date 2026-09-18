import { describe, expect, it } from 'vitest'
import express from 'express'
import request from 'supertest'
import { clerumErrorHandler } from '../src/http/errorHandler.js'
import {
  TracingIdempotencyConflictError,
  UnsafeTracingInputError,
} from '../src/services/tracing/append.js'
import {
  InvalidTracingInputError,
  TracingBindingUnavailableError,
} from '../src/services/tracing/routeSubmissionService.js'

/**
 * Internal reporters (HCC) must tell a deterministic tracing rejection, which
 * they must not retry, from a transient one (#326/#327). The global handler
 * exposes a stable `code` for an allowlist of our own error types only.
 */
function appThrowing(err: unknown) {
  const app = express()
  app.post('/boom', (_req, _res, next) => next(err))
  app.use(clerumErrorHandler)
  return app
}

describe('clerumErrorHandler — machine-readable code on allowlisted 4xx', () => {
  it.each([
    [
      new TracingIdempotencyConflictError('administrative', 'hcc_internal_control', 'e-1'),
      409,
      'tracing_idempotency_conflict',
    ],
    [new UnsafeTracingInputError('payload.gfs_subject'), 400, 'unsafe_tracing_input'],
  ])('forwards %s with its code', async (err, status, code) => {
    const res = await request(appThrowing(err)).post('/boom')

    expect(res.status).toBe(status)
    expect(res.body).toMatchObject({ code, error: expect.any(String) })
    expect(res.body.correlationId).toEqual(expect.any(String))
  })

  it.each([
    [new TracingBindingUnavailableError('operation', 0), 403],
    [new InvalidTracingInputError('events[0].kind is not supported'), 400],
    [{ code: 409 }, 409],
  ])('keeps the body without code for a non-allowlisted 4xx (%s)', async (err, status) => {
    const res = await request(appThrowing(err)).post('/boom')

    // Liveness: the 4xx branch ran (status forwarded, correlation id present).
    expect(res.status).toBe(status)
    expect(res.body.correlationId).toEqual(expect.any(String))
    expect(res.body).not.toHaveProperty('code')
  })
})
