import { describe, expect, it, vi } from 'vitest'
import express from 'express'
import type { Request } from 'express'
import { ApiException } from '@kubernetes/client-node'
import request from 'supertest'
import { clerumErrorHandler } from '../src/http/errorHandler.js'

/**
 * UT-2a (FIX-B): the global error handler must forward a K8s error's real 4xx
 * status instead of collapsing it to 500. Raw @kubernetes/client-node errors
 * carry their status on `.code` / `.statusCode` / `.response.*`, NOT a top-level
 * `.status` — the field the OLD inline handler read exclusively.
 */

/** Build a minimal Express app whose single route throws `err` (no auth). */
function appThrowing(err: unknown) {
  const app = express()
  app.get('/boom', (_req, _res, next) => next(err))
  app.use(clerumErrorHandler)
  return app
}

/**
 * Like `appThrowing` but injects a spy logger on `req.log` so a test can assert
 * on what the handler writes to the INTERNAL log (not just the client body).
 */
function appThrowingWithLogSpy(err: unknown) {
  const warn = vi.fn()
  const spyLogger = { warn, error: vi.fn(), info: vi.fn(), debug: vi.fn() }
  const app = express()
  app.get('/boom', (req: Request, _res, next) => {
    ;(req as unknown as { log: unknown }).log = spyLogger
    next(err)
  })
  app.use(clerumErrorHandler)
  return { app, warn }
}

describe('clerumErrorHandler — K8s status forwarding (UT-2a)', () => {
  it('forwards {code:422} as 422 with a sanitized (non-leaking) body', async () => {
    const res = await request(appThrowing({ code: 422, message: 'raw k8s internals' })).get('/boom')
    expect(res.status).toBe(422)
    // Plain (non-Error) objects must not leak their raw message.
    expect(res.body.error).toBe('Bad Request')
  })

  it.each([
    [{ code: 400 }, 400],
    [{ code: 403 }, 403],
    [{ code: 409 }, 409],
    [{ statusCode: 422 }, 422],
    [{ response: { statusCode: 422 } }, 422],
    [{ response: { status: 404 } }, 404],
  ])('forwards %o as %i', async (err, expected) => {
    const res = await request(appThrowing(err)).get('/boom')
    expect(res.status).toBe(expected)
  })

  it('preserves the legacy `.status` path (404)', async () => {
    const res = await request(appThrowing({ status: 404, message: 'not found' })).get('/boom')
    expect(res.status).toBe(404)
  })

  it('does NOT forward a 5xx code — {code:500} still collapses to 500', async () => {
    const res = await request(appThrowing({ code: 500 })).get('/boom')
    expect(res.status).toBe(500)
    expect(res.body.error).toBe('Internal Server Error')
  })

  it('a status-less TypeError still collapses to 500 (no regression)', async () => {
    const res = await request(appThrowing(new TypeError('kaboom'))).get('/boom')
    expect(res.status).toBe(500)
    expect(res.body.error).toBe('Internal Server Error')
  })

  /**
   * S1 (security, info disclosure): a REAL @kubernetes/client-node ApiException
   * — derived from its actual constructor (T1: fixture from the real producer,
   * NOT a hand-built {code} object) — embeds the full metav1.Status body AND
   * every apiserver response header (Audit-Id, x-kubernetes-pf-*) inside its
   * `.message`. The 4xx branch must forward the real status but MUST NOT leak
   * that message. Only the metav1.Status `body.message` may surface.
   */
  it('collapses a real K8s ApiException 4xx — forwards status, never leaks headers/raw message', async () => {
    const body = {
      kind: 'Status',
      apiVersion: 'v1',
      status: 'Failure',
      message: 'hosts.clerum.io "product-agent" already exists',
      reason: 'AlreadyExists',
      code: 409,
    }
    const headers = {
      'audit-id': 'a1b2c3-secret-audit-uuid',
      'x-kubernetes-pf-flowschema-uid': 'internal-flowschema-uid',
      'content-type': 'application/json',
    }
    const err = new ApiException(409, 'Conflict', body, headers)

    // Sanity: the real producer really does embed the leak in `.message`.
    expect(err.message).toContain('Headers:')
    expect(err.message).toContain('audit-id')

    const res = await request(appThrowing(err)).get('/boom')
    expect(res.status).toBe(409)

    const serialized = JSON.stringify(res.body)
    expect(serialized).not.toContain('Headers:')
    expect(serialized).not.toContain('audit-id')
    expect(serialized).not.toContain('x-kubernetes-pf')
    expect(serialized).not.toContain(err.message)
    // The safe metav1.Status body.message may surface as the client-facing text.
    expect(res.body.error).toBe('hosts.clerum.io "product-agent" already exists')
  })

  /**
   * S1 follow-up (info disclosure to INTERNAL logs): the 4xx branch already
   * sanitizes the CLIENT body, but the internal `log.warn` still logged the raw
   * `err.message` of a K8s ApiException — which embeds the metav1.Status body AND
   * every apiserver header (Audit-Id, x-kubernetes-pf-*). That is PID/PII of
   * infrastructure in internal logs. The logged message must be sanitized the
   * same way the client body is: status + a safe message, never the headers or
   * the raw `.message`.
   */
  it('does NOT log the raw ApiException message (headers/audit-id) for a forwarded 4xx', async () => {
    const body = {
      kind: 'Status',
      apiVersion: 'v1',
      status: 'Failure',
      message: 'hosts.clerum.io "product-agent" already exists',
      reason: 'AlreadyExists',
      code: 409,
    }
    const headers = {
      'audit-id': 'a1b2c3-secret-audit-uuid',
      'x-kubernetes-pf-flowschema-uid': 'internal-flowschema-uid',
      'content-type': 'application/json',
    }
    const err = new ApiException(409, 'Conflict', body, headers)

    // Sanity: the real producer really does embed the leak in `.message`.
    expect(err.message).toContain('Headers:')
    expect(err.message).toContain('audit-id')

    const { app, warn } = appThrowingWithLogSpy(err)
    await request(app).get('/boom').expect(409)

    expect(warn).toHaveBeenCalled()
    const logged = JSON.stringify(warn.mock.calls)
    expect(logged).not.toContain('Headers:')
    expect(logged).not.toContain('audit-id')
    expect(logged).not.toContain('x-kubernetes-pf')
    expect(logged).not.toContain(err.message)
  })
})
