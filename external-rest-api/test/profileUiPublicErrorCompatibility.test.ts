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
    'forwards the safe %s producer reason through External REST to Profile UI',
    async (_name, expected) => {
      producer.respondWith(expected.control)
      const relayed = await request(createRelayApp())
        .post('/relay')
        .set('x-correlation-id', requestCorrelationId)

      // The edge forwards control-api's body verbatim; Profile UI is what maps
      // the code to the operator-facing copy.
      expect(relayed.status).toBe(expected.control.status)
      expect(relayed.body).toEqual(expected.control.body)

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
    }
  )

  it('forwards a 503 body it does not recognise instead of inventing an envelope', async () => {
    producer.respondWith({
      status: 503,
      body: { error: 'private_database_failure', detail: 'private topology' },
    })
    const relayed = await request(createRelayApp())
      .post('/relay')
      .set('x-correlation-id', requestCorrelationId)

    // Witness: the 503 status and the producer's own body both cross the edge.
    expect(relayed.status).toBe(503)
    expect(relayed.body).toEqual({
      error: 'private_database_failure',
      detail: 'private topology',
    })
  })
})
