import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../src/app.js'

const mocks = vi.hoisted(() => ({
  verifyToken: vi.fn(),
  controlApiFetch: vi.fn(),
}))

vi.mock('../src/authToken.js', () => ({ verifyToken: mocks.verifyToken }))

const PUBLIC_API_PREFIX = '/api/v1'
const RESOLVE_PATH = `${PUBLIC_API_PREFIX}/me/access/resolve`
const UNKNOWN_ACCESS_PATH = `${PUBLIC_API_PREFIX}/me/access/unknown-access-route`

const claims = {
  userId: '10000000-0000-4000-8000-000000000001',
  email: 'user@example.test',
  teamId: '',
  role: 'member' as const,
  exp: 2_000_000_000,
}

// Shaped like the request control-api accepts, so a route that still forwards
// the resolve contract would reach the stubbed upstream instead of failing on
// this test's own input validation.
const resolveBody = {
  requiredCapability: 'team.read',
  resource: {
    environmentId: 'environment',
    type: 'team',
    logicalId: 'team-1',
  },
}

function controlApiJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('public access resolve exposure', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.verifyToken.mockReturnValue(claims)
    mocks.controlApiFetch.mockResolvedValue(controlApiJsonResponse({ catalogServed: true }))
    vi.stubGlobal('fetch', mocks.controlApiFetch)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('answers the dormant resolve path exactly like an unknown access route while the sibling capabilities route stays live', async () => {
    const app = createApp()

    const unknown = await request(app)
      .post(UNKNOWN_ACCESS_PATH)
      .set('authorization', 'Bearer session-token')
      .send(resolveBody)
    const resolve = await request(app)
      .post(RESOLVE_PATH)
      .set('authorization', 'Bearer session-token')
      .send(resolveBody)

    // The edge's own not-found contract, read from the same app in the same
    // authenticated context as the resolve request.
    expect(unknown.status).toBe(404)
    expect(unknown.body).toEqual({ error: 'Not Found' })
    expect(resolve.status).toBe(404)
    expect(resolve.body).toEqual(unknown.body)
    // Both requests carried a valid session, so neither was stopped by the
    // /me/access auth gate; the resolve response is routing, not a 401.
    expect(mocks.verifyToken.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(mocks.verifyToken).toHaveBeenCalledWith('session-token')
    // Nothing dialed control-api: the dormant /external/access/resolve handler
    // is unreachable from this edge.
    expect(mocks.controlApiFetch).not.toHaveBeenCalled()

    // Liveness witness: the same app, router and session still expose the
    // sibling access route end to end, so the 404 above cannot come from a
    // broken edge or a dead proxy.
    mocks.controlApiFetch.mockResolvedValueOnce(
      controlApiJsonResponse({ catalogServed: false, currentSessionContract: 'v1' })
    )
    const capabilities = await request(app)
      .get(`${PUBLIC_API_PREFIX}/me/access/capabilities`)
      .set('authorization', 'Bearer session-token')

    expect(capabilities.status).toBe(200)
    expect(capabilities.body).toEqual({
      catalogServed: false,
      currentSessionContract: 'v1',
    })
    expect(mocks.controlApiFetch).toHaveBeenCalledTimes(1)
    const [upstreamUrl, upstreamInit] = mocks.controlApiFetch.mock.calls[0] as [string, RequestInit]
    expect(new URL(upstreamUrl).pathname).toBe('/api/v1/external/access/capabilities')
    expect(upstreamInit.method).toBe('GET')
    expect((upstreamInit.headers as Record<string, string>)['x-user-session-token']).toBe(
      'session-token'
    )
  })
})
