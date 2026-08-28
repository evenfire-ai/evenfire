import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { readFileSync } from 'node:fs'
import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import request from 'supertest'
import { apiSend } from '../../profile-ui/lib/api.js'
import { externalRestPublicErrorHandler } from '../src/app.js'
import { config } from '../src/config.js'
import { controlApiRequest } from '../src/controlApiClient.js'

type MemberRegistrationErrorContract = Record<
  string,
  {
    control: { status: number; body: { error: string } }
    public: { code: string; message: string }
    profileMessage: string
  }
>

const contract = JSON.parse(
  readFileSync(
    new URL('../../tests/contracts/member-registration-public-errors.json', import.meta.url),
    'utf8'
  )
) as MemberRegistrationErrorContract

type ProducerResponse = { status: number; body: Record<string, unknown> }

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
  app.post('/relay', async (_req, res, next) => {
    try {
      await controlApiRequest('POST', '/external/members/invitations')
      res.status(204).end()
    } catch (error) {
      next(error)
    }
  })
  app.use(externalRestPublicErrorHandler)
  return app
}

describe('Profile UI public error compatibility', () => {
  const requestCorrelationId = 'caller-correlation-123'
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

  beforeEach(() => {
    producer.reset()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  afterAll(async () => {
    config.controlApiBaseUrl = originalControlApiBaseUrl
    await new Promise<void>((resolve, reject) => {
      server.close(error => (error ? reject(error) : resolve()))
    })
  })

  it.each(Object.entries(contract))(
    'preserves the safe %s producer reason through External REST and Profile UI',
    async (_name, expected) => {
      producer.respondWith(expected.control)
      const relayed = await request(createRelayApp())
        .post('/relay')
        .set('x-correlation-id', requestCorrelationId)

      expect(relayed.status).toBe(expected.control.status)
      expect(relayed.body.error).toMatchObject({
        code: expected.public.code,
        message: expected.public.message,
        correlationId: requestCorrelationId,
        retryable: true,
      })

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          new Response(JSON.stringify(relayed.body), {
            status: relayed.status,
            statusText: 'Service Unavailable',
            headers: { 'content-type': 'application/json' },
          })
        )
      )

      await expect(apiSend('POST', '/api/v1/members/invite', {})).rejects.toThrow(
        expected.profileMessage
      )
      expect(JSON.stringify(relayed.body)).not.toContain('private')
    }
  )

  it('keeps an unapproved upstream 503 generic across both public boundaries', async () => {
    producer.respondWith({
      status: 503,
      body: { error: 'private_database_failure', detail: 'private topology' },
    })
    const relayed = await request(createRelayApp())
      .post('/relay')
      .set('x-correlation-id', requestCorrelationId)
    expect(relayed.status).toBe(503)
    expect(relayed.body.error).toMatchObject({
      code: 'authority_unavailable',
      message: 'Authorization is temporarily unavailable.',
      correlationId: requestCorrelationId,
      retryable: true,
    })
    expect(JSON.stringify(relayed.body)).not.toMatch(/private_database_failure|private topology/)
  })
})
