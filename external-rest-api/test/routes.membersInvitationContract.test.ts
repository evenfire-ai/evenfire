import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { readFileSync } from 'node:fs'
import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import request from 'supertest'
import { config } from '../src/config.js'
import { createMembersRouter } from '../src/routes/members.js'

type InvitationErrorContract = Record<
  string,
  {
    control: { status: number; body: { error: string } }
    external: { status: number; body: { error: string } }
  }
>

const invitationErrorContract = JSON.parse(
  readFileSync(
    new URL('../../tests/contracts/external-member-invitation-errors.json', import.meta.url),
    'utf8'
  )
) as InvitationErrorContract

const authTokenMock = vi.hoisted(() => ({
  verifyToken: vi.fn(),
}))

vi.mock('../src/authToken.js', () => authTokenMock)

const claims = {
  userId: 'user-1',
  email: 'user@example.com',
  teamId: 'team-1',
  role: 'admin' as const,
  exp: 9999999999,
}

type ProducerResponse = {
  status: number
  body: Record<string, unknown>
}

type ProducerRequest = {
  method: string | undefined
  path: string | undefined
  body: unknown
}

function makeExternalApp() {
  const app = express()
  app.use(express.json())
  app.use(createMembersRouter())
  return app
}

function createControlApiWireProducer() {
  let nextResponse: ProducerResponse | undefined
  const requests: ProducerRequest[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(Buffer.from(chunk)))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      requests.push({
        method: req.method,
        path: req.url,
        body: raw ? JSON.parse(raw) : undefined,
      })

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
  })

  return {
    server,
    requests,
    respondWith(response: ProducerResponse) {
      nextResponse = response
    },
    reset() {
      nextResponse = undefined
      requests.length = 0
    },
  }
}

describe('member invitation cross-service error contract', () => {
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
    vi.clearAllMocks()
    producer.reset()
    authTokenMock.verifyToken.mockReturnValue(claims)
  })

  afterAll(async () => {
    config.controlApiBaseUrl = originalControlApiBaseUrl
    await new Promise<void>((resolve, reject) => {
      server.close(error => (error ? reject(error) : resolve()))
    })
  })

  it('preserves the authoritative invalid-email response through the real client parser', async () => {
    const contract = invitationErrorContract.invalidEmail
    producer.respondWith(contract.control)

    await request(makeExternalApp())
      .post('/members/invite')
      .set('authorization', 'Bearer good-token')
      .send({ email: 'not-an-email', teams: [] })
      .expect(contract.external.status, contract.external.body)

    expect(producer.requests).toEqual([
      {
        method: 'POST',
        path: '/external/members/invitations',
        body: {
          email: 'not-an-email',
          teams: [],
        },
      },
    ])
  })

  it.each([
    {
      label: 'empty assignments',
      contract: 'invalidPayload',
      body: { email: 'invitee@example.com', teams: [] },
    },
    {
      label: 'an overlong name',
      contract: 'invalidName',
      body: {
        email: 'invitee@example.com',
        name: 'a'.repeat(121),
        teams: [{ teamId: 'team-1', role: 'member' }],
      },
    },
    {
      label: 'too many teams',
      contract: 'tooManyTeams',
      body: {
        email: 'invitee@example.com',
        teams: Array.from({ length: 51 }, (_, index) => ({
          teamId: `team-${index}`,
          role: 'member',
        })),
      },
    },
  ])(
    'preserves the authoritative response for $label through the real client parser',
    async ({ body, contract: contractName }) => {
      const contract = invitationErrorContract[contractName]
      producer.respondWith(contract.control)

      await request(makeExternalApp())
        .post('/members/invite')
        .set('authorization', 'Bearer good-token')
        .send(body)
        .expect(contract.external.status, contract.external.body)

      expect(producer.requests).toHaveLength(1)
      expect(producer.requests[0]).toMatchObject({
        method: 'POST',
        path: '/external/members/invitations',
      })
    }
  )

  it('preserves the padded-name candidate across the Control API wire boundary', async () => {
    producer.respondWith({ status: 201, body: { id: 'inv-padded' } })

    await request(makeExternalApp())
      .post('/members/invite')
      .set('authorization', 'Bearer good-token')
      .send({
        email: 'invitee@example.com',
        name: `${' '.repeat(121)}Alice`,
        teams: [{ teamId: 'team-1', role: 'member' }],
      })
      .expect(201, { id: 'inv-padded' })

    expect(producer.requests).toEqual([
      {
        method: 'POST',
        path: '/external/members/invitations',
        body: {
          email: 'invitee@example.com',
          name: `${' '.repeat(121)}Alice`,
          teams: [{ teamId: 'team-1', role: 'member' }],
        },
      },
    ])
  })
})
