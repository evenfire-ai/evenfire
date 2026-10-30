import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import request from 'supertest'
import { createApp } from '../src/app.js'
import { config } from '../src/config.js'

// The edge verifies the caller's session locally; only the session backend is
// replaced here so the full app wiring (routes, sanitizer, global handler) runs
// unchanged.
vi.mock('../src/authToken.js', () => ({
  verifyToken: (token: string) =>
    token === 'synthetic-session-token'
      ? {
          userId: 'user-1',
          email: 'user@example.invalid',
          teamId: 'team-a',
          role: 'admin',
          exp: 9_999_999_999,
          sessionContract: 'v1',
        }
      : null,
}))

type UpstreamResponse = {
  status: number
  body: unknown
  headers?: Record<string, string>
}

function createControlApiProducer() {
  let sessionTokenResponse: UpstreamResponse | undefined
  const server = createServer((req, res) => {
    req.resume()
    const url = req.url ?? ''
    const respond = (response: UpstreamResponse) => {
      res.statusCode = response.status
      res.setHeader('content-type', 'application/json')
      for (const [name, value] of Object.entries(response.headers ?? {})) {
        res.setHeader(name, value)
      }
      res.end(JSON.stringify(response.body))
    }

    if (req.method === 'GET' && url === '/external/users/user-1/memberships/team-b') {
      respond({ status: 200, body: { team_id: 'team-b', role: 'admin', team_name: 'Team B' } })
      return
    }
    if (req.method === 'POST' && url === '/external/teams') {
      respond({ status: 201, body: { id: 'team-new', name: 'Team New' } })
      return
    }
    if (req.method === 'POST' && url === '/external/auth/session-token') {
      if (!sessionTokenResponse) {
        respond({ status: 500, body: { error: 'missing_test_upstream_response' } })
        return
      }
      const response = sessionTokenResponse
      sessionTokenResponse = undefined
      respond(response)
      return
    }
    respond({ status: 500, body: { error: 'unexpected_test_upstream_request' } })
  })

  return {
    server,
    respondWithSessionToken(response: UpstreamResponse) {
      sessionTokenResponse = response
    },
  }
}

const sessionBackendUnavailableResponse: UpstreamResponse = {
  status: 503,
  body: { error: 'session_backend_unavailable', retryAfterSeconds: 2 },
  headers: { 'retry-after': '2', 'cache-control': 'no-store' },
}

describe('External REST session backend 503 cache semantics', () => {
  const originalControlApiBaseUrl = config.controlApiBaseUrl
  const producer = createControlApiProducer()
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

  beforeEach(() => producer.respondWithSessionToken(sessionBackendUnavailableResponse))

  afterAll(async () => {
    config.controlApiBaseUrl = originalControlApiBaseUrl
    await new Promise<void>((resolve, reject) => {
      server.close(error => (error ? reject(error) : resolve()))
    })
  })

  it('keeps upstream no-store on the sanitized switch-team authority 503', async () => {
    const response = await request(createApp())
      .post('/api/v1/me/switch-team')
      .set('authorization', 'Bearer synthetic-session-token')
      .send({ teamId: 'team-b' })

    expect(response.status).toBe(503)
    expect(response.body.error).toMatchObject({ code: 'authority_unavailable', retryable: true })
    expect(response.headers['retry-after']).toBe('2')
    expect(response.headers['cache-control']).toBe('no-store')
  })

  it('keeps upstream no-store on the sanitized create-team authority 503', async () => {
    const response = await request(createApp())
      .post('/api/v1/team')
      .set('authorization', 'Bearer synthetic-session-token')
      .send({ name: 'Team New' })

    expect(response.status).toBe(503)
    expect(response.body.error).toMatchObject({ code: 'authority_unavailable', retryable: true })
    expect(response.headers['retry-after']).toBe('2')
    expect(response.headers['cache-control']).toBe('no-store')
  })

  it('does not invent no-store when the upstream 503 omits it', async () => {
    producer.respondWithSessionToken({
      status: 503,
      body: { error: 'authority_unavailable', retryAfterSeconds: 2 },
      headers: { 'retry-after': '2' },
    })

    const response = await request(createApp())
      .post('/api/v1/me/switch-team')
      .set('authorization', 'Bearer synthetic-session-token')
      .send({ teamId: 'team-b' })

    expect(response.status).toBe(503)
    expect(response.body.error).toMatchObject({ code: 'authority_unavailable', retryable: true })
    expect(response.headers['retry-after']).toBe('2')
    expect(response.headers['cache-control']).toBeUndefined()
  })
})
