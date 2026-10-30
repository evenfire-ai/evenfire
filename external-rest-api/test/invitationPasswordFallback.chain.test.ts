import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type Server, createServer } from 'node:http'
import { type AddressInfo } from 'node:net'
import request from 'supertest'
import contractDocument from '../../tests/contracts/invitation-password-public-errors.json'
import { createApp } from '../src/app.js'
import { config } from '../src/config.js'

// The sessionless password fallback runs the real invitations service and
// router against an HTTP Control API stand-in, so the producer status reaches
// the edge body through every mapping layer.
const invitationToken = 'synthetic-member-invitation-proof'
const invitationId = '00000000-0000-4000-8000-000000000001'
const inviteeEmail = 'member@example.invalid'
const witnessToken = 'synthetic-witness-invitation-proof'
const witnessSession = 'synthetic-witness-session-token'

type UpstreamRequest = { method?: string; url?: string; body?: Record<string, unknown> }

describe('sessionless invitation password fallback through the producer', () => {
  let previousControlApiBaseUrl: string
  let previousControlApiServiceToken: string
  let upstream: Server | undefined

  beforeEach(() => {
    previousControlApiBaseUrl = config.controlApiBaseUrl
    previousControlApiServiceToken = config.controlApiServiceToken
    config.controlApiServiceToken = 'synthetic-internal-service-token'
  })

  afterEach(async () => {
    config.controlApiBaseUrl = previousControlApiBaseUrl
    config.controlApiServiceToken = previousControlApiServiceToken
    if (upstream?.listening) {
      await new Promise<void>((resolve, reject) =>
        upstream!.close(error => (error ? reject(error) : resolve()))
      )
    }
    upstream = undefined
  })

  async function startProducer(accept: { status: number; body: unknown }) {
    const requests: UpstreamRequest[] = []
    upstream = createServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      }
      const raw = Buffer.concat(chunks).toString('utf8')
      requests.push({ method: req.method, url: req.url, body: raw ? JSON.parse(raw) : undefined })
      res.setHeader('content-type', 'application/json')
      if (
        req.method === 'GET' &&
        req.url === `/api/v1/external/invitations/token/${invitationToken}`
      ) {
        res.writeHead(200)
        res.end(
          JSON.stringify({
            id: invitationId,
            email: inviteeEmail,
            purpose: 'member_invitation',
            status: 'accepted',
          })
        )
        return
      }
      if (req.method === 'POST' && req.url === '/api/v1/external/invitations/accept') {
        if (requests.at(-1)?.body?.token === witnessToken) {
          res.writeHead(200)
          res.end(
            JSON.stringify({
              accepted: true,
              teamId: null,
              teamName: null,
              role: 'member',
              email: inviteeEmail,
              userId: '00000000-0000-4000-8000-000000000003',
              token: witnessSession,
            })
          )
          return
        }
        res.writeHead(accept.status)
        res.end(JSON.stringify(accept.body))
        return
      }
      res.writeHead(500)
      res.end(JSON.stringify({ error: `unexpected ${req.method} ${req.url}` }))
    })
    await new Promise<void>((resolve, reject) => {
      upstream!.once('error', reject)
      upstream!.listen(0, '127.0.0.1', resolve)
    })
    const address = upstream.address() as AddressInfo
    config.controlApiBaseUrl = `http://127.0.0.1:${address.port}/api/v1`
    return requests
  }

  // Positive witness in the same app and producer: a first acceptance through
  // the edge issues the product session cookie the fallback response must lack.
  async function expectWitnessSessionCookie(requests: UpstreamRequest[]) {
    const witness = await request(createApp())
      .post('/api/v1/invitations/accept')
      .send({ token: witnessToken, email: inviteeEmail })
    expect(witness.status).toBe(200)
    expect(String(witness.headers['set-cookie'] ?? '')).toContain(
      `profile_session=${witnessSession}`
    )
    expect(requests.map(entry => `${entry.method} ${entry.url}`)).toEqual([
      'POST /api/v1/external/invitations/accept',
    ])
    requests.splice(0)
  }

  async function submitFallbackPassword() {
    return request(createApp()).post('/api/v1/invitations/password').send({
      token: invitationToken,
      email: inviteeEmail,
      invitationId,
      password: 'Synthetic-First-Password-123',
    })
  }

  function expectStoppedAtAccept(requests: UpstreamRequest[]) {
    expect(requests.map(entry => `${entry.method} ${entry.url}`)).toEqual([
      `GET /api/v1/external/invitations/token/${invitationToken}`,
      'POST /api/v1/external/invitations/accept',
    ])
    expect(requests[1]?.body).toMatchObject({ email: inviteeEmail, token: invitationToken })
  }

  it('maps an owner replay to the terminal invitation_not_pending code without a session', async () => {
    const requests = await startProducer({
      status: 200,
      body: {
        accepted: true,
        teamId: null,
        teamName: null,
        role: 'member',
        email: inviteeEmail,
        userId: '00000000-0000-4000-8000-000000000002',
        replay: true,
      },
    })
    await expectWitnessSessionCookie(requests)

    const response = await submitFallbackPassword()

    // The same body profile-ui renders as terminal in its component contract test.
    const terminal = contractDocument.accept_fallback_not_pending
    expect(response.status).toBe(terminal.status)
    expect(response.body).toEqual(terminal.body)
    expect(String(response.headers['set-cookie'] ?? '')).not.toMatch(/profile_session=[^;]+/)
    expectStoppedAtAccept(requests)
  })

  it('maps a producer 400 not_pending to the non-terminal invalid invitation body', async () => {
    const requests = await startProducer({ status: 400, body: { error: 'not_pending' } })
    await expectWitnessSessionCookie(requests)

    const response = await submitFallbackPassword()

    expect(response.status).toBe(400)
    expect(response.body).toEqual({ error: 'Invalid invitation' })
    expect(String(response.headers['set-cookie'] ?? '')).not.toMatch(/profile_session=[^;]+/)
    expectStoppedAtAccept(requests)
  })
})
