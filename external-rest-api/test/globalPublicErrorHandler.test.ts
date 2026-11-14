import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import express from 'express'
import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import request from 'supertest'
import { externalRestPublicErrorHandler } from '../src/app.js'
import { config } from '../src/config.js'
import { ControlApiError, ControlApiPathError, controlApiRequest } from '../src/controlApiClient.js'

type ProducerResponse = {
  status: number
  body: unknown
  headers?: Record<string, string>
}

function createControlApiWireProducer() {
  let nextResponse: ProducerResponse | undefined
  const server = createServer((_req, res) => {
    if (!nextResponse) {
      res.statusCode = 500
      res.end(JSON.stringify({ error: 'missing_test_response' }))
      return
    }
    res.statusCode = nextResponse.status
    res.setHeader('content-type', 'application/json')
    for (const [name, value] of Object.entries(nextResponse.headers ?? {})) {
      res.setHeader(name, value)
    }
    res.end(JSON.stringify(nextResponse.body))
    nextResponse = undefined
  })
  return {
    server,
    respondWith(response: ProducerResponse) {
      nextResponse = response
    },
    reset() {
      nextResponse = undefined
    },
  }
}

function createRelayApp() {
  const app = express()
  // Every case below travels the real control-api client and the real global
  // handler; only the wire producer is a stub.
  app.get('/relay', async (_req, res, next) => {
    try {
      await controlApiRequest('GET', '/external/test-error')
      res.status(204).end()
    } catch (error) {
      next(error)
    }
  })
  app.get('/path-error', () => {
    throw new ControlApiPathError()
  })
  app.get('/control-api-400', () => {
    throw new ControlApiError('wrapper must not be public', 400, { error: 'invalid_email' })
  })
  app.get('/client-error', () => {
    throw Object.assign(new SyntaxError('Unexpected token in request body'), { status: 400 })
  })
  app.get('/plain-error', () => {
    throw new Error('internal-detail-sentinel-not-for-clients')
  })
  app.use(externalRestPublicErrorHandler)
  return app
}

const forwardedObjectBodies = [
  [400, { error: 'invalid_email' }],
  [409, { error: 'conflict', detail: 'invitation already accepted' }],
  [422, { error: { code: 'invalid_teams', message: 'one team is required' } }],
] as const

describe('global External REST public error handler', () => {
  const requestCorrelationId = 'global-handler-correlation'
  const originalControlApiBaseUrl = config.controlApiBaseUrl
  const producer = createControlApiWireProducer()
  let server: Server

  beforeAll(async () => {
    server = producer.server
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject)
        resolve()
      })
    })
    const address = server.address() as AddressInfo
    config.controlApiBaseUrl = `http://127.0.0.1:${address.port}`
  })

  beforeEach(() => producer.reset())

  afterAll(async () => {
    config.controlApiBaseUrl = originalControlApiBaseUrl
    await new Promise<void>((resolve, reject) => {
      server.close(error => (error ? reject(error) : resolve()))
    })
  })

  it.each(forwardedObjectBodies)(
    'forwards the control-api body verbatim with status %i',
    async (status, body) => {
      producer.respondWith({ status, body })

      const response = await request(createRelayApp())
        .get('/relay')
        .set('x-correlation-id', requestCorrelationId)

      // Two statuses in one table: the body follows the upstream status instead
      // of a fixed envelope.
      expect(response.status).toBe(status)
      expect(response.body).toEqual(body)
      expect(JSON.stringify(response.body)).not.toContain('Control API')
    }
  )

  it('keeps the 503 outage headers only when control-api sent them', async () => {
    producer.respondWith({
      status: 503,
      body: { error: 'session_backend_unavailable' },
      headers: { 'retry-after': '2', 'cache-control': 'no-store' },
    })

    const withHeaders = await request(createRelayApp()).get('/relay')

    expect(withHeaders.status).toBe(503)
    expect(withHeaders.body).toEqual({ error: 'session_backend_unavailable' })
    expect(withHeaders.headers['retry-after']).toBe('2')
    expect(withHeaders.headers['cache-control']).toBe('no-store')

    producer.respondWith({ status: 503, body: { error: 'authority_unavailable' } })

    const withoutHeaders = await request(createRelayApp()).get('/relay')

    expect(withoutHeaders.status).toBe(503)
    expect(withoutHeaders.body).toEqual({ error: 'authority_unavailable' })
    expect(withoutHeaders.headers['retry-after']).toBeUndefined()
    expect(withoutHeaders.headers['cache-control']).toBeUndefined()
  })

  it('never exposes the internal request wrapper for a non-object body', async () => {
    producer.respondWith({ status: 502, body: null })

    const response = await request(createRelayApp())
      .get('/relay')
      .set('x-correlation-id', requestCorrelationId)

    // The 502 status proves the ControlApiError rule ran; the body is the status
    // sentence, not `Control API GET /external/... failed (...)`.
    expect(response.status).toBe(502)
    expect(response.body).toEqual({ error: 'Bad Gateway' })
    expect(JSON.stringify(response.body)).not.toMatch(/Control API|\/external\/|GET/)
  })

  it('answers a non-control-api client error with its own message and a plain error with 500', async () => {
    const clientError = await request(createRelayApp()).get('/client-error')

    expect(clientError.status).toBe(400)
    expect(clientError.body).toEqual({ error: 'Unexpected token in request body' })

    const serverError = await request(createRelayApp())
      .get('/plain-error')
      .set('x-correlation-id', requestCorrelationId)

    expect(serverError.status).toBe(500)
    expect(serverError.body).toEqual({
      error: {
        code: 'internal_error',
        message: 'The request could not be completed.',
        correlationId: requestCorrelationId,
        retryable: false,
      },
    })
  })

  it('keeps the invalid-request envelope for a path error and not for a plain control-api 400', async () => {
    const pathError = await request(createRelayApp())
      .get('/path-error')
      .set('x-correlation-id', requestCorrelationId)

    expect(pathError.status).toBe(400)
    expect(pathError.body).toEqual({
      error: {
        code: 'invalid_request',
        message: 'The request is not valid.',
        correlationId: requestCorrelationId,
        retryable: false,
      },
    })

    const controlApi400 = await request(createRelayApp()).get('/control-api-400')

    expect(controlApi400.status).toBe(400)
    expect(controlApi400.body).toEqual({ error: 'invalid_email' })
  })

  it('does not leak an internal error message in the sanitized 500', async () => {
    const response = await request(createRelayApp())
      .get('/plain-error')
      .set('x-correlation-id', requestCorrelationId)

    expect(response.status).toBe(500)
    expect(JSON.stringify(response.body)).not.toContain('internal-detail-sentinel-not-for-clients')
    expect(response.body.error.code).toBe('internal_error')
    expect(typeof response.body.error.correlationId).toBe('string')
  })
})
