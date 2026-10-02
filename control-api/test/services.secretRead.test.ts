import { afterEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { ApiException } from '@kubernetes/client-node'
import request from 'supertest'
import { clerumErrorHandler } from '../src/http/errorHandler.js'
import { rootLogger } from '../src/observability/logger.js'
import {
  SecretReadError,
  WorkflowRecipeListError,
  listWorkflowRecipes,
  readSecretOrNull,
} from '../src/services/secretRead.js'
import { controlApiForbiddenRead, rejectedAccessMessage } from './helpers/secretReadFailure.js'

function readerRejecting(err: unknown) {
  return { getSecret: vi.fn(async () => Promise.reject(err)) }
}

function listerRejecting(err: unknown) {
  return { listResource: vi.fn(async () => Promise.reject(err)) }
}

/** node-fetch's shape for a refused connection (no HTTP response at all). */
function connectionRefused(): Error {
  return Object.assign(new Error('request to https://10.96.0.1/api failed, reason: connect'), {
    name: 'FetchError',
    type: 'system',
    code: 'ECONNREFUSED',
    errno: 'ECONNREFUSED',
  })
}

async function captureError(p: Promise<unknown>): Promise<unknown> {
  try {
    await p
  } catch (err) {
    return err
  }
  throw new Error('expected the read to reject')
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('readSecretOrNull', () => {
  it('returns the Secret when the read succeeds', async () => {
    const secret = { metadata: { name: 's1' } }
    const gateway = { getSecret: vi.fn(async () => secret) }
    await expect(readSecretOrNull(gateway, 's1', 'mcp-host')).resolves.toBe(secret)
    expect(gateway.getSecret).toHaveBeenCalledWith('s1', 'mcp-host')
  })

  it('returns null only for a 404', async () => {
    const gateway = readerRejecting(new ApiException(404, 'Not Found', '{"code":404}', {}))
    await expect(readSecretOrNull(gateway, 'ghost', 'mcp-host')).resolves.toBeNull()
    expect(gateway.getSecret).toHaveBeenCalledWith('ghost', 'mcp-host')
  })

  it.each([401, 403] as const)('maps a %i to a 502 naming control-api access', async status => {
    const upstream = new ApiException(status, 'Rejected', '{}', { 'audit-id': 'x' })
    const err = await captureError(
      readSecretOrNull(readerRejecting(upstream), 'k', 'sandbox-recipes')
    )
    expect(err).toBeInstanceOf(SecretReadError)
    const e = err as SecretReadError
    expect(e.status).toBe(502)
    expect(e.code).toBe('secret_read_failed')
    expect(e.upstreamStatus).toBe(status)
    expect(e.message).toBe(rejectedAccessMessage('k', 'sandbox-recipes', status))
  })

  it.each([500, 503, 429, 400, 409])(
    'maps an HTTP %i to a 503 stating the status',
    async status => {
      const err = await captureError(
        readSecretOrNull(readerRejecting(new ApiException(status, 'x', '{}', {})), 'k', 'mcp-host')
      )
      expect(err).toBeInstanceOf(SecretReadError)
      expect((err as SecretReadError).status).toBe(503)
      expect((err as SecretReadError).message).toBe(
        `control-api could not read Secret "k" in namespace "mcp-host": the Kubernetes API server returned HTTP ${status}.`
      )
    }
  )

  it('maps a transport failure (no HTTP response) to a 503 "could not be reached"', async () => {
    const err = await captureError(
      readSecretOrNull(readerRejecting(connectionRefused()), 'k', 'mcp-host')
    )
    expect(err).toBeInstanceOf(SecretReadError)
    expect((err as SecretReadError).status).toBe(503)
    expect((err as SecretReadError).upstreamStatus).toBeNull()
    expect((err as SecretReadError).message).toBe(
      'control-api could not read Secret "k" in namespace "mcp-host": the Kubernetes API server could not be reached.'
    )
  })

  it('maps an aborted request (AbortError) to a 503 with the error name as the reason', async () => {
    const aborted = Object.assign(new Error('The user aborted a request.'), { name: 'AbortError' })
    const err = (await captureError(
      readSecretOrNull(readerRejecting(aborted), 'k', 'mcp-host')
    )) as SecretReadError
    expect(err).toBeInstanceOf(SecretReadError)
    expect(err.status).toBe(503)
    expect(err.upstreamReason).toBe('AbortError')
  })

  it('rethrows a status-less non-transport error unchanged (not an apiserver failure)', async () => {
    const bug = new TypeError("Cannot read properties of undefined (reading 'metadata')")
    const gateway = readerRejecting(bug)
    const err = await captureError(readSecretOrNull(gateway, 'k', 'mcp-host'))
    expect(gateway.getSecret).toHaveBeenCalledOnce()
    expect(err).toBe(bug)
  })

  it("rethrows a FetchError that is not type 'system' unchanged", async () => {
    const timeout = Object.assign(new Error('network timeout'), {
      name: 'FetchError',
      type: 'request-timeout',
    })
    const gateway = readerRejecting(timeout)
    const err = await captureError(readSecretOrNull(gateway, 'k', 'mcp-host'))
    expect(gateway.getSecret).toHaveBeenCalledOnce()
    expect(err).toBe(timeout)
  })

  it('carries the Status message as the reason, and nothing else from the ApiException', async () => {
    const err = (await captureError(
      readSecretOrNull(readerRejecting(controlApiForbiddenRead('k', 'mcp-host')), 'k', 'mcp-host')
    )) as SecretReadError
    expect(err.upstreamStatus).toBe(403)
    expect(err.upstreamReason).toContain('cannot get resource "secrets"')
    // No `cause`: pino's err serializer follows it and would print the headers.
    expect((err as { cause?: unknown }).cause).toBeUndefined()
    expect(JSON.stringify({ ...err, message: err.message, stack: err.stack })).not.toContain(
      '5f0c7a4e-secret-read'
    )
  })

  it('carries no reason (rather than the header-laden message) when the Status body is empty', async () => {
    const upstream = new ApiException(403, 'Forbidden', '', { 'audit-id': 'empty-body-audit' })
    expect(upstream.message).toContain('empty-body-audit')
    const err = (await captureError(
      readSecretOrNull(readerRejecting(upstream), 'k', 'mcp-host')
    )) as SecretReadError
    expect(err.upstreamStatus).toBe(403)
    expect(err.upstreamReason).toBeNull()
  })

  it('carries the errno code as the reason for a transport failure', async () => {
    const err = (await captureError(
      readSecretOrNull(readerRejecting(connectionRefused()), 'k', 'mcp-host')
    )) as SecretReadError
    expect(err.upstreamStatus).toBeNull()
    expect(err.upstreamReason).toBe('ECONNREFUSED')
  })
})

describe('listWorkflowRecipes', () => {
  it('returns the listed items', async () => {
    const items = [{ metadata: { name: 'r1' } }]
    const gateway = { listResource: vi.fn(async () => items) }
    await expect(listWorkflowRecipes(gateway, 'sandbox-recipes')).resolves.toBe(items)
    expect(gateway.listResource).toHaveBeenCalledWith('workflowrecipes', 'sandbox-recipes')
  })

  it('maps a 403 to a 502 naming control-api access', async () => {
    const upstream = new ApiException(403, 'Forbidden', '{"message":"forbidden"}', {})
    const err = await captureError(
      listWorkflowRecipes(listerRejecting(upstream), 'sandbox-recipes')
    )
    expect(err).toBeInstanceOf(WorkflowRecipeListError)
    const e = err as WorkflowRecipeListError
    expect(e.status).toBe(502)
    expect(e.code).toBe('workflow_recipe_list_failed')
    expect(e.upstreamReason).toBe('forbidden')
    expect(e.message).toBe(
      `control-api could not list WorkflowRecipes in namespace "sandbox-recipes": ` +
        `the Kubernetes API server rejected control-api's own access (HTTP 403). ` +
        `Your session is not the cause; check the control-api RBAC for that namespace.`
    )
  })

  it('maps a 404 (no "absent" answer for a list) and a transport failure to 503', async () => {
    const notFound = await captureError(
      listWorkflowRecipes(listerRejecting(new ApiException(404, 'x', '{}', {})), 'ns')
    )
    expect((notFound as WorkflowRecipeListError).status).toBe(503)
    const refused = await captureError(
      listWorkflowRecipes(listerRejecting(connectionRefused()), 'ns')
    )
    expect((refused as WorkflowRecipeListError).status).toBe(503)
    expect((refused as WorkflowRecipeListError).upstreamReason).toBe('ECONNREFUSED')
  })

  it('rethrows a status-less non-transport error unchanged', async () => {
    const bug = new TypeError('boom')
    const gateway = listerRejecting(bug)
    await expect(listWorkflowRecipes(gateway, 'ns')).rejects.toBe(bug)
    expect(gateway.listResource).toHaveBeenCalledOnce()
  })
})

describe('clerumErrorHandler — apiserver read errors', () => {
  function appThrowing(err: unknown) {
    const app = express()
    app.get('/boom', (_req, _res, next) => next(err))
    app.use(clerumErrorHandler)
    return app
  }

  it('forwards a SecretReadError as its 502 and logs one correlated line with the reason', async () => {
    const warn = vi.spyOn(rootLogger, 'warn').mockImplementation(() => {})
    const err = new SecretReadError('k', 'mcp-host', 403, 'secrets "k" is forbidden')
    const res = await request(appThrowing(err)).get('/boom')
    expect(res.status).toBe(502)
    expect(res.body.error).toBe('secret_read_failed')
    expect(res.body.message).toBe(rejectedAccessMessage('k', 'mcp-host', 403))
    expect(typeof res.body.correlationId).toBe('string')
    expect(JSON.stringify(res.body)).not.toContain('forbidden')
    expect(warn).toHaveBeenCalledOnce()
    const [fields] = warn.mock.calls[0] as unknown as [Record<string, unknown>]
    expect(fields).toMatchObject({
      event: 'forwarded_integration_error',
      correlationId: res.body.correlationId,
      status: 502,
      code: 'secret_read_failed',
      upstreamStatus: 403,
      upstreamReason: 'secrets "k" is forbidden',
    })
  })

  it('forwards a SecretReadError as its 503', async () => {
    vi.spyOn(rootLogger, 'warn').mockImplementation(() => {})
    const err = new SecretReadError('k', 'mcp-host', null, 'ECONNREFUSED')
    const res = await request(appThrowing(err)).get('/boom')
    expect(res.status).toBe(503)
    expect(res.body).toMatchObject({
      error: 'secret_read_failed',
      message:
        'control-api could not read Secret "k" in namespace "mcp-host": the Kubernetes API server could not be reached.',
    })
  })

  it('forwards a WorkflowRecipeListError as its 502', async () => {
    vi.spyOn(rootLogger, 'warn').mockImplementation(() => {})
    const res = await request(
      appThrowing(new WorkflowRecipeListError('sandbox-recipes', 403, null))
    ).get('/boom')
    expect(res.status).toBe(502)
    expect(res.body.error).toBe('workflow_recipe_list_failed')
  })

  it('still collapses a 502 with a non-allowlisted code to 500', async () => {
    vi.spyOn(rootLogger, 'error').mockImplementation(() => {})
    const err = Object.assign(new Error('internal detail'), { status: 502, code: 'other_code' })
    const res = await request(appThrowing(err)).get('/boom')
    expect(res.status).toBe(500)
    expect(res.body.error).toBe('Internal Server Error')
  })
})
