import { describe, expect, it, vi } from 'vitest'
import express from 'express'
import type { Request } from 'express'
import { ApiException } from '@kubernetes/client-node'
import request from 'supertest'
import { clerumErrorHandler } from '../src/http/errorHandler.js'
import { K8sNotFoundError } from '../src/services/resourceService.js'
import { handlerRefused403, statusForbidden } from './helpers/apiserverErrors.js'

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

  /**
   * R4-M3: the service-layer K8sNotFoundError/K8sConflictError expose their
   * status ONLY on `.httpStatus` (no `.status` / `.statusCode` / `.code`). The
   * handler's status chain must read `.httpStatus`, otherwise a real 404
   * collapses to 500. Fixture derived from the real producer (T1): an actual
   * `K8sNotFoundError` instance, not a hand-built `{ httpStatus }` object.
   */
  it('forwards a K8sNotFoundError (status only on `.httpStatus`) as 404', async () => {
    const err = new K8sNotFoundError('host "product-agent" not found')
    // Sanity: the real producer carries its status on `.httpStatus` alone.
    expect((err as unknown as { httpStatus: number }).httpStatus).toBe(404)
    expect((err as unknown as { status?: unknown }).status).toBeUndefined()
    expect((err as unknown as { statusCode?: unknown }).statusCode).toBeUndefined()
    expect((err as unknown as { code?: unknown }).code).toBeUndefined()

    const res = await request(appThrowing(err)).get('/boom')
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
  /**
   * S1 follow-up (R1-M2, info disclosure to CLIENT on the 500 branch): the
   * non-production 500 branch returns a debug `message` to the client. It used to
   * forward `err.message` verbatim — but a K8s ApiException 5xx (etcd/apiserver
   * down) is an Error whose `.message` embeds the metav1.Status body AND every
   * apiserver header (Audit-Id, x-kubernetes-pf-*). So in dev/test the client got
   * those headers. The 500 branch must sanitize the message the same way the 4xx
   * branch does. Fixture derived from the real @kubernetes/client-node producer
   * (T1), not a hand-built shape.
   */
  it('does NOT leak headers/audit-id on the non-production 500 branch for a real K8s ApiException 5xx', async () => {
    const prev = process.env.NODE_ENV
    process.env.NODE_ENV = 'development'
    try {
      const body = {
        kind: 'Status',
        apiVersion: 'v1',
        status: 'Failure',
        message: 'etcdserver: request timed out',
        reason: 'ServiceUnavailable',
        code: 503,
      }
      const headers = {
        'audit-id': 'a1b2c3-secret-audit-uuid',
        'x-kubernetes-pf-flowschema-uid': 'internal-flowschema-uid',
        'content-type': 'application/json',
      }
      const err = new ApiException(503, 'ServiceUnavailable', body, headers)

      // Sanity: the real producer really does embed the leak in `.message`.
      expect(err.message).toContain('Headers:')
      expect(err.message).toContain('audit-id')

      const res = await request(appThrowing(err)).get('/boom')
      // 5xx never forwarded as the upstream status — collapses to 500.
      expect(res.status).toBe(500)
      expect(res.body.error).toBe('Internal Server Error')

      const serialized = JSON.stringify(res.body)
      expect(serialized).not.toContain('Headers:')
      expect(serialized).not.toContain('audit-id')
      expect(serialized).not.toContain('x-kubernetes-pf')
      expect(serialized).not.toContain(err.message)
      // A sanitized debug message still surfaces (the metav1.Status body.message,
      // which carries no headers) so dev debuggability is preserved.
      expect(res.body.message).toBe('etcdserver: request timed out')
    } finally {
      process.env.NODE_ENV = prev
    }
  })

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

/**
 * control-api calls Kubernetes with its OWN ServiceAccount, so a raw
 * ApiException 401, or a 403 no policy author wrote, is the apiserver refusing
 * control-api, never the caller's session. Forwarded as-is, a 401 logs the
 * Control UI operator out and a 403 shows apiserver text that can name the
 * ServiceAccount.
 */
describe('clerumErrorHandler — K8s ApiException 401/403', () => {
  const headers = { 'audit-id': 'a1b2c3-secret-audit-uuid' }
  const SA = 'system:serviceaccount:control-plane:control-api'

  it.each([
    [
      'ResourceQuota',
      'secrets "s1" is forbidden: exceeded quota: q1, requested: secrets=1, used: secrets=5, limited: secrets=5',
    ],
    [
      'NamespaceLifecycle',
      'secrets "s1" is forbidden: unable to create new content in namespace mcp-server because it is being terminated',
    ],
    [
      'RBAC on a named object',
      `secrets "s1" is forbidden: User "${SA}" cannot create resource "secrets" in API group "" in the namespace "mcp-server"`,
    ],
    [
      'RBAC on a list',
      `secrets is forbidden: User "${SA}" cannot list resource "secrets" in API group "" in the namespace "mcp-server"`,
    ],
    [
      'a policy message naming a ServiceAccount',
      `workflowrecipes.clerum.io "r1" is forbidden: ValidatingAdmissionPolicy 'p' with binding 'b' denied request: ${SA} may not do this`,
    ],
    [
      'a webhook denial without explanation',
      'admission webhook "w" denied the request without explanation',
    ],
    // The apiserver never emits this (extractResourceName falls back to "Unknown");
    // pins the fail-closed default.
    [
      'a policy-shaped message with no name',
      "workflowrecipes.clerum.io is forbidden: ValidatingAdmissionPolicy 'p' with binding 'b' denied request: m",
    ],
  ])(
    'answers %s with the fail-closed 502 and keeps the reason in the log',
    async (_label, text) => {
      const { app, warn } = appThrowingWithLogSpy(statusForbidden(text))
      const res = await request(app).get('/boom')

      expect(res.status).toBe(502)
      expect(res.body.error).toBe('kubernetes_access_denied')
      expect(res.body.correlationId).toEqual(expect.any(String))
      expect(res.body.message).toBe(handlerRefused403(res.body.correlationId))
      // Liveness witness: the branch ran, parsed the Status body, and logged it
      // under the id the message names. The negative assertions below rest on it.
      expect(warn).toHaveBeenCalledOnce()
      expect(warn.mock.calls[0][0]).toMatchObject({
        event: 'kubernetes_access_denied',
        upstreamStatus: 403,
        correlationId: res.body.correlationId,
        err: text,
      })
      const serialized = JSON.stringify(res.body)
      expect(serialized).not.toContain(text)
      expect(serialized).not.toContain('system:serviceaccount')
      expect(serialized).not.toContain('audit-id')
    }
  )

  it('answers a 403 whose body is not a Status with a 502 and never echoes the body', async () => {
    const marker = 'non-status-body-marker-6a1e'
    const err = new ApiException(403, 'Unknown API Status Code!', `<html>${marker}</html>`, headers)
    const { app, warn } = appThrowingWithLogSpy(err)
    const res = await request(app).get('/boom')

    expect(res.status).toBe(502)
    expect(res.body.error).toBe('kubernetes_access_denied')
    // Witness: the branch ran; clientErrorMessage fell back to the status text.
    expect(warn.mock.calls[0][0]).toMatchObject({
      event: 'kubernetes_access_denied',
      upstreamStatus: 403,
      err: 'Forbidden',
    })
    expect(JSON.stringify(res.body)).not.toContain(marker)
    expect(JSON.stringify(warn.mock.calls)).not.toContain(marker)
  })

  it.each([
    ['no name', 'Unknown'],
    ['a generateName prefix', 'r1-'],
  ])('keeps forwarding a policy denial on an object with %s', async (_label, name) => {
    const message = `workflowrecipes.clerum.io "${name}" is forbidden: ValidatingAdmissionPolicy 'p' with binding 'b' denied request: not allowed`
    const { app, warn } = appThrowingWithLogSpy(statusForbidden(message))
    const res = await request(app).get('/boom')

    expect(res.status).toBe(403)
    expect(res.body.error).toBe(message)
    expect(warn.mock.calls[0][0]).toMatchObject({ event: 'forwarded_client_error', status: 403 })
    expect(JSON.stringify(res.body)).not.toContain('audit-id')
  })

  it('answers a 401 with an undefined body, as the client raises it, with a credentials 502', async () => {
    const err = new ApiException(401, 'Unauthorized', undefined, headers)
    const { app, warn } = appThrowingWithLogSpy(err)
    const res = await request(app).get('/boom')

    expect(res.status).toBe(502)
    expect(res.body.error).toBe('kubernetes_access_denied')
    expect(res.body.message).toBe(
      "The Kubernetes API server refused control-api's own credentials (HTTP 401). " +
        'Your session is not the cause; check the control-api ServiceAccount token.'
    )
    expect(JSON.stringify(res.body)).not.toContain('audit-id')
    // Witness: the branch ran and recorded the upstream status.
    expect(warn).toHaveBeenCalledOnce()
    expect(warn.mock.calls[0][0]).toMatchObject({
      event: 'kubernetes_access_denied',
      upstreamStatus: 401,
    })
  })

  it('keeps forwarding a policy 403 as 403 with the policy message', async () => {
    const message =
      "workflowrecipes.clerum.io \"r1\" is forbidden: ValidatingAdmissionPolicy 'workflowrecipe-namespace-allowlist' with binding 'workflowrecipe-namespace-allowlist' denied request: Only the workflow-recipes controller may set WorkflowRecipe ownerReferences."
    const err = new ApiException(
      403,
      'Forbidden',
      { kind: 'Status', status: 'Failure', message, reason: 'Forbidden', code: 403 },
      headers
    )
    const res = await request(appThrowing(err)).get('/boom')

    expect(res.status).toBe(403)
    expect(res.body.error).toBe(message)
    expect(JSON.stringify(res.body)).not.toContain('audit-id')
  })

  it('keeps forwarding a service-layer 403 that is not an ApiException', async () => {
    const res = await request(appThrowing({ code: 403 })).get('/boom')
    expect(res.status).toBe(403)
  })

  it.each([404, 409])('keeps forwarding a real ApiException %i', async status => {
    const err = new ApiException(status, 'x', { kind: 'Status', message: 'm', code: status }, {})
    const res = await request(appThrowing(err)).get('/boom')
    expect(res.status).toBe(status)
    expect(res.body.error).toBe('m')
  })
})
