import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { type IncomingMessage, type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import request from 'supertest'
import { createApp } from '../src/app.js'
import { config } from '../src/config.js'

/**
 * The head External REST edge against the base control-api producer.
 *
 * The fixture bodies below are a snapshot of the base control-api at
 * `56c5e49cd` (identical to `562d2e480` for these files). The seam is a loopback
 * `node:http` stub with the real `createApp()`, `controlApiClient` and `fetch`;
 * only the edge's local session verifier is mocked, so a red comes from the base
 * producer contract rather than from a mocked client.
 *
 * The stub enforces the two base preconditions the edge depends on:
 *   - 401 `{"error":"Unauthorized"}` without `x-user-session-token` on
 *     `/external/users/*` and `/external/teams`;
 *   - 400 `{"error":"invalid payload"}` when a `/external/auth/session-token`
 *     body is missing one of `userId`, `email`, `teamId`, `role`.
 */

const BASE_SESSION_TOKEN = 'synthetic-base-session-token'
const MEMBER_ID = 'synthetic-member-id'
const MEMBER_EMAIL = 'member@example.invalid'
const CURRENT_TEAM_ID = 'synthetic-team-id'
const NEXT_TEAM_ID = 'synthetic-next-team-id'
const CREATED_TEAM_ID = 'synthetic-created-team-id'
const INVITATION_PROOF = 'synthetic-invitation-proof'
const INVITATION_ROW_ID = '00000000-0000-4000-8000-000000000001'

vi.mock('../src/authToken.js', () => ({
  verifyToken: (token: string) =>
    token === 'synthetic-base-session-token'
      ? {
          userId: 'synthetic-member-id',
          email: 'member@example.invalid',
          teamId: 'synthetic-team-id',
          role: 'member',
          exp: 9_999_999_999,
          sessionContract: 'v1',
        }
      : null,
}))

type RecordedCall = {
  method: string
  path: string
  sessionToken: string | undefined
  body: Record<string, unknown> | undefined
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : undefined
}

function createBaseControlApiProducer() {
  const calls: RecordedCall[] = []
  const server = createServer(async (req, res) => {
    const body = await readJsonBody(req)
    const path = req.url ?? ''
    const sessionTokenHeader = req.headers['x-user-session-token']
    const sessionToken = typeof sessionTokenHeader === 'string' ? sessionTokenHeader : undefined
    calls.push({ method: req.method ?? '', path, sessionToken, body })

    const respond = (status: number, payload: unknown) => {
      res.statusCode = status
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(payload))
    }

    // Base preconditions: the session-plane routes require the forwarded
    // session token, and the session-token mint requires its four body fields.
    if (
      (path.startsWith('/api/v1/external/users/') || path === '/api/v1/external/teams') &&
      !sessionToken
    ) {
      respond(401, { error: 'Unauthorized' })
      return
    }
    if (path === '/api/v1/external/auth/session-token') {
      const missing = ['userId', 'email', 'teamId', 'role'].some(
        field => !String(body?.[field] ?? '').trim()
      )
      if (missing) {
        respond(400, { error: 'invalid payload' })
        return
      }
      respond(200, { token: 'synthetic-issued-session-token' })
      return
    }
    if (req.method === 'GET' && path.startsWith('/api/v1/external/users/')) {
      respond(200, { team_id: NEXT_TEAM_ID, role: 'member', team_name: 'Synthetic Next Team' })
      return
    }
    if (req.method === 'POST' && path === '/api/v1/external/teams') {
      respond(201, { id: CREATED_TEAM_ID, name: 'Synthetic Created Team' })
      return
    }
    if (req.method === 'POST' && path === '/api/v1/external/invitations/password-token') {
      respond(200, {
        id: INVITATION_ROW_ID,
        email: MEMBER_EMAIL,
        purpose: 'password_reset',
        status: 'accepted',
        passwordUpdated: true,
        token: 'synthetic-producer-session-token',
        sessionContext: { userId: MEMBER_ID, email: MEMBER_EMAIL, authGeneration: 2 },
      })
      return
    }
    if (req.method === 'POST' && path === '/api/v1/external/invitations/accept') {
      respond(200, {
        accepted: true,
        userId: MEMBER_ID,
        email: MEMBER_EMAIL,
        teamId: CURRENT_TEAM_ID,
        teamName: 'Synthetic Team',
        role: 'member',
        token: 'synthetic-accepted-session-token',
      })
      return
    }
    // Base has no session/logout route: its app answers this 404.
    if (req.method === 'POST' && path === '/api/v1/external/auth/session/logout') {
      respond(404, { error: 'Not Found' })
      return
    }
    respond(500, { error: 'unexpected_test_upstream_request' })
  })
  return { server, calls }
}

describe('head External REST against the base control-api', () => {
  const originalControlApiBaseUrl = config.controlApiBaseUrl
  const producer = createBaseControlApiProducer()
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
    config.controlApiBaseUrl = `http://127.0.0.1:${address.port}/api/v1`
  })

  beforeEach(() => {
    producer.calls.length = 0
  })

  afterAll(async () => {
    config.controlApiBaseUrl = originalControlApiBaseUrl
    await new Promise<void>((resolve, reject) => {
      server.close(error => (error ? reject(error) : resolve()))
    })
  })

  it('switches team against the base membership and session-token routes', async () => {
    const response = await request(createApp())
      .post('/api/v1/me/switch-team')
      .set('authorization', `Bearer ${BASE_SESSION_TOKEN}`)
      .send({ teamId: NEXT_TEAM_ID })

    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      token: 'synthetic-issued-session-token',
      team: { id: NEXT_TEAM_ID, name: 'Synthetic Next Team', role: 'member' },
    })
    expect(response.headers['set-cookie']).toBeUndefined()
    expect(producer.calls.map(call => `${call.method} ${call.path}`)).toEqual([
      `GET /api/v1/external/users/${MEMBER_ID}/memberships/${NEXT_TEAM_ID}`,
      'POST /api/v1/external/auth/session-token',
    ])
    // The session token is a head behaviour, not a base incompatibility: both
    // upstream calls carry it.
    expect(producer.calls.map(call => call.sessionToken)).toEqual([
      BASE_SESSION_TOKEN,
      BASE_SESSION_TOKEN,
    ])
  })

  it('creates a team against the base teams and session-token routes', async () => {
    const response = await request(createApp())
      .post('/api/v1/team')
      .set('authorization', `Bearer ${BASE_SESSION_TOKEN}`)
      .send({ name: 'Synthetic Created Team' })

    expect(response.status).toBe(201)
    expect(response.body).toEqual({
      token: 'synthetic-issued-session-token',
      team: { id: CREATED_TEAM_ID, name: 'Synthetic Created Team', role: 'admin' },
    })
    expect(producer.calls.map(call => `${call.method} ${call.path}`)).toEqual([
      'POST /api/v1/external/teams',
      'POST /api/v1/external/auth/session-token',
    ])
    expect(producer.calls[1].body).toEqual({
      userId: MEMBER_ID,
      email: MEMBER_EMAIL,
      teamId: CREATED_TEAM_ID,
      role: 'admin',
    })
  })

  it('never publishes the base session token from a password reset', async () => {
    const response = await request(createApp()).post('/api/v1/invitations/password-reset').send({
      token: INVITATION_PROOF,
      email: MEMBER_EMAIL,
      invitationId: INVITATION_ROW_ID,
      password: 'Synthetic-Replacement-Password-123',
    })

    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      id: INVITATION_ROW_ID,
      email: MEMBER_EMAIL,
      purpose: 'password_reset',
      status: 'accepted',
      passwordUpdated: true,
      reauthenticationRequired: true,
    })
    expect(response.body).not.toHaveProperty('token')
    expect(String(response.headers['set-cookie'])).toContain('profile_session=;')
    expect(producer.calls.map(call => `${call.method} ${call.path}`)).toEqual([
      'POST /api/v1/external/invitations/password-token',
    ])
  })

  it('accepts an invitation through the base producer and sets the session cookie', async () => {
    const response = await request(createApp())
      .post('/api/v1/invitations/accept')
      .send({ token: INVITATION_PROOF, email: MEMBER_EMAIL })

    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      accepted: true,
      userId: MEMBER_ID,
      email: MEMBER_EMAIL,
      teamId: CURRENT_TEAM_ID,
      teamName: 'Synthetic Team',
      role: 'member',
    })
    expect(response.body).not.toHaveProperty('token')
    expect(String(response.headers['set-cookie'])).toContain(
      'profile_session=synthetic-accepted-session-token'
    )
    expect(producer.calls.map(call => `${call.method} ${call.path}`)).toEqual([
      'POST /api/v1/external/invitations/accept',
    ])
  })

  it('answers a logout against the base 404 with the forwarded body and clears the cookie', async () => {
    const response = await request(createApp())
      .post('/api/v1/auth/logout')
      .set('authorization', `Bearer ${BASE_SESSION_TOKEN}`)

    expect(response.status).toBe(404)
    expect(response.body).toStrictEqual({ error: 'Not Found' })
    expect(response.body).not.toHaveProperty('ok')
    expect(String(response.headers['set-cookie'])).toContain('profile_session=;')
    expect(producer.calls.map(call => `${call.method} ${call.path}`)).toEqual([
      'POST /api/v1/external/auth/session/logout',
    ])
    expect(producer.calls[0].sessionToken).toBe(BASE_SESSION_TOKEN)
  })
})
