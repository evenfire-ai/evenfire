import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import express from 'express'
import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import request from 'supertest'
import { externalRestPublicErrorHandler } from '../src/app.js'
import { config } from '../src/config.js'
import { controlApiRequest } from '../src/controlApiClient.js'

type ProducerResponse = {
  status: number
  body: Record<string, unknown>
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
  app.get('/relay', async (_req, res, next) => {
    try {
      await controlApiRequest('GET', '/external/test-error')
      res.status(204).end()
    } catch (error) {
      next(error)
    }
  })
  app.use(externalRestPublicErrorHandler)
  return app
}

const acceptedStatuses = [
  [408, 'request_timeout', 'The request timed out.', true],
  [409, 'conflict', 'The request conflicts with current state.', false],
  [410, 'gone', 'The resource is no longer available.', false],
  [411, 'length_required', 'A content length is required.', false],
  [412, 'precondition_failed', 'The request precondition did not match current state.', false],
  [413, 'payload_too_large', 'The request payload is too large.', false],
  [425, 'too_early', 'The request is not ready to be processed.', true],
  [502, 'upstream_unavailable', 'The upstream service is temporarily unavailable.', true],
  [504, 'upstream_timeout', 'The upstream service timed out.', true],
  [
    507,
    'insufficient_storage',
    'The requested operation cannot be completed because storage is full.',
    false,
  ],
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

  it.each(acceptedStatuses)(
    'preserves canonical public semantics for Control API status %i',
    async (status, code, message, retryable) => {
      producer.respondWith({
        status,
        body: {
          error: {
            code: 'private_upstream_code',
            message: 'private upstream detail',
            correlationId: 'unsafe/upstream-correlation',
          },
        },
        headers: {
          'retry-after': '17',
          'upload-length': '2048',
          'x-private-upstream': 'secret',
        },
      })

      const response = await request(createRelayApp())
        .get('/relay')
        .set('x-correlation-id', requestCorrelationId)

      expect(response.status).toBe(status)
      expect(response.body).toEqual({
        error: {
          code,
          message,
          correlationId: requestCorrelationId,
          retryable,
        },
      })
      expect(JSON.stringify(response.body)).not.toMatch(/private_upstream|unsafe\/upstream/)
      expect(response.headers['x-private-upstream']).toBeUndefined()
      expect(response.headers['retry-after']).toBe(retryable ? '17' : undefined)
      expect(response.headers['upload-length']).toBe(status === 413 ? '2048' : undefined)
    }
  )

  it('keeps unaccepted 426 semantics outside the PR1 canonical status vocabulary', async () => {
    producer.respondWith({
      status: 426,
      body: { error: { code: 'upgrade_required', message: 'private upgrade policy' } },
    })

    const response = await request(createRelayApp())
      .get('/relay')
      .set('x-correlation-id', requestCorrelationId)

    expect(response.status).toBe(426)
    expect(response.body).toEqual({
      error: {
        code: 'invalid_request',
        message: 'The request could not be completed.',
        correlationId: requestCorrelationId,
        retryable: false,
      },
    })
  })
})
