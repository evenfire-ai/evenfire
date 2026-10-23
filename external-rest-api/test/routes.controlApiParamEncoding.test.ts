import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { createApp } from '../src/app.js'

const mocks = vi.hoisted(() => ({
  verifyToken: vi.fn(),
  controlApiFetch: vi.fn(),
}))

vi.mock('../src/authToken.js', () => ({ verifyToken: mocks.verifyToken }))

const PUBLIC_API_PREFIX = '/api/v1'
const USER_ID = '11111111-1111-4111-8111-111111111111'
const TEAM_ID = '22222222-2222-4222-8222-222222222222'
const INVITATION_ID = '7f9c2bce-1a2b-4c3d-8e4f-0123456789ab'
const TARGET_USER_ID = '33333333-3333-4333-8333-333333333333'
const ENCODED_PROBE = 'U%2FV%3FW'
const ENCODED_PROBE_VALUE = 'U/V?W'

const claims = {
  userId: USER_ID,
  email: 'user@example.test',
  teamId: TEAM_ID,
  role: 'admin' as const,
  exp: 2_000_000_000,
}

type RawResponse = { status: number; body: unknown; headers: http.IncomingHttpHeaders }

// Express matches the encoded request target before it decodes the captured
// param. Supertest re-encodes a URL, so every case goes out over a raw loopback
// socket through the real createApp() server, exactly as a proxy would send it.
async function rawRequest(options: {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  path: string
  token?: string
  body?: unknown
}): Promise<RawResponse> {
  const server = createApp().listen(0)
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })
  try {
    const { port } = server.address() as AddressInfo
    const payload = options.body === undefined ? undefined : JSON.stringify(options.body)
    return await new Promise<RawResponse>((resolve, reject) => {
      const request = http.request(
        {
          host: '127.0.0.1',
          port,
          path: options.path,
          method: options.method,
          headers: {
            authorization: `Bearer ${options.token ?? 'synthetic-session-token'}`,
            ...(payload === undefined
              ? {}
              : {
                  'content-type': 'application/json',
                  'content-length': Buffer.byteLength(payload),
                }),
          },
        },
        response => {
          const chunks: Buffer[] = []
          response.on('data', chunk => chunks.push(chunk as Buffer))
          response.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8')
            let body: unknown = raw
            try {
              body = JSON.parse(raw) as unknown
            } catch {
              // Non-JSON bodies stay as the raw text witness.
            }
            resolve({ status: response.statusCode ?? 0, body, headers: response.headers })
          })
        }
      )
      request.on('error', reject)
      if (payload !== undefined) request.write(payload)
      request.end()
    })
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function callAt(callIndex: number): { url: URL; init: RequestInit } {
  const [url, init] = mocks.controlApiFetch.mock.calls[callIndex] as [string, RequestInit]
  return { url: new URL(url), init }
}

describe('caller-controlled control-api path components stay in one segment', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.verifyToken.mockReturnValue(claims)
    vi.stubGlobal('fetch', mocks.controlApiFetch)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('encodes the member id on GET /members/:userId and forwards a normal id too', async () => {
    mocks.controlApiFetch.mockResolvedValue(jsonResponse({ id: ENCODED_PROBE_VALUE }))

    const alias = await rawRequest({
      method: 'GET',
      path: `${PUBLIC_API_PREFIX}/members/${ENCODED_PROBE}`,
    })
    expect(alias.status).toBe(200)

    await rawRequest({ method: 'GET', path: `${PUBLIC_API_PREFIX}/members/${USER_ID}` })

    expect(mocks.controlApiFetch).toHaveBeenCalledTimes(2)
    const first = callAt(0)
    expect(first.url.pathname).toBe(
      `${PUBLIC_API_PREFIX}/external/members/${encodeURIComponent(ENCODED_PROBE_VALUE)}`
    )
    expect(first.url.pathname.split('/')).toHaveLength(6)
    expect(callAt(1).url.pathname).toBe(`${PUBLIC_API_PREFIX}/external/members/${USER_ID}`)
  })

  it('encodes both member and team ids on PATCH /members/:userId/teams/:teamId/role', async () => {
    mocks.controlApiFetch.mockResolvedValue(jsonResponse({ updated: true }))

    await rawRequest({
      method: 'PATCH',
      path: `${PUBLIC_API_PREFIX}/members/${ENCODED_PROBE}/teams/T%2FX%3FY/role`,
      body: { role: 'member' },
    })
    await rawRequest({
      method: 'PATCH',
      path: `${PUBLIC_API_PREFIX}/members/${USER_ID}/teams/${TEAM_ID}/role`,
      body: { role: 'member' },
    })

    expect(mocks.controlApiFetch).toHaveBeenCalledTimes(2)
    const first = callAt(0)
    expect(first.url.pathname).toBe(
      `${PUBLIC_API_PREFIX}/external/members/${encodeURIComponent(ENCODED_PROBE_VALUE)}` +
        `/teams/${encodeURIComponent('T/X?Y')}/role`
    )
    expect(first.url.pathname.split('/')).toHaveLength(9)
    expect(first.init.method).toBe('PATCH')
    expect(callAt(1).url.pathname).toBe(
      `${PUBLIC_API_PREFIX}/external/members/${USER_ID}/teams/${TEAM_ID}/role`
    )
  })

  it('keeps the detach alias on DELETE /members/:userId/teams/:teamId and never selects the revoke route', async () => {
    mocks.controlApiFetch.mockResolvedValue(jsonResponse({ detached: true }))

    await rawRequest({
      method: 'DELETE',
      path: `${PUBLIC_API_PREFIX}/members/invitations%2fINV%3f/teams/T`,
    })
    await rawRequest({
      method: 'DELETE',
      path: `${PUBLIC_API_PREFIX}/members/U%3f/teams/T`,
    })
    await rawRequest({
      method: 'DELETE',
      path: `${PUBLIC_API_PREFIX}/members/${USER_ID}/teams/${TEAM_ID}`,
    })

    expect(mocks.controlApiFetch).toHaveBeenCalledTimes(3)
    const first = callAt(0)
    expect(first.url.pathname).toBe(
      `${PUBLIC_API_PREFIX}/external/members/invitations%2FINV%3F/teams/T`
    )
    expect(first.url.pathname).not.toBe(`${PUBLIC_API_PREFIX}/external/members/invitations/INV`)
    expect(first.url.search).toBe('')
    expect(first.init.method).toBe('DELETE')
    expect(callAt(1).url.pathname).toBe(`${PUBLIC_API_PREFIX}/external/members/U%3F/teams/T`)
    expect(callAt(1).url.search).toBe('')
    expect(callAt(2).url.pathname).toBe(
      `${PUBLIC_API_PREFIX}/external/members/${USER_ID}/teams/${TEAM_ID}`
    )
  })

  it('keeps the resend alias on POST /members/invitations/:invitationId/resend and never selects creation', async () => {
    mocks.controlApiFetch.mockResolvedValue(jsonResponse({ resent: true }))

    await rawRequest({
      method: 'POST',
      path: `${PUBLIC_API_PREFIX}/members/invitations/%3f/resend`,
    })
    await rawRequest({
      method: 'POST',
      path: `${PUBLIC_API_PREFIX}/members/invitations/${INVITATION_ID}/resend`,
    })

    expect(mocks.controlApiFetch).toHaveBeenCalledTimes(2)
    const first = callAt(0)
    expect(first.url.pathname).toBe(`${PUBLIC_API_PREFIX}/external/members/invitations/%3F/resend`)
    expect(first.url.pathname).not.toBe(`${PUBLIC_API_PREFIX}/external/members/invitations`)
    expect(first.url.search).toBe('')
    expect(first.init.method).toBe('POST')
    expect(callAt(1).url.pathname).toBe(
      `${PUBLIC_API_PREFIX}/external/members/invitations/${INVITATION_ID}/resend`
    )
  })

  it('encodes the invitation id on DELETE /members/invitations/:invitationId', async () => {
    mocks.controlApiFetch.mockResolvedValue(jsonResponse({ cancelled: true }))

    await rawRequest({
      method: 'DELETE',
      path: `${PUBLIC_API_PREFIX}/members/invitations/INV%2F%3F`,
    })
    await rawRequest({
      method: 'DELETE',
      path: `${PUBLIC_API_PREFIX}/members/invitations/${INVITATION_ID}`,
    })

    expect(mocks.controlApiFetch).toHaveBeenCalledTimes(2)
    const first = callAt(0)
    expect(first.url.pathname).toBe(`${PUBLIC_API_PREFIX}/external/members/invitations/INV%2F%3F`)
    expect(first.url.pathname.split('/')).toHaveLength(7)
    expect(callAt(1).url.pathname).toBe(
      `${PUBLIC_API_PREFIX}/external/members/invitations/${INVITATION_ID}`
    )
  })

  it('encodes the requested team id from POST /me/switch-team', async () => {
    mocks.controlApiFetch.mockImplementation((url: string) => {
      if (String(url).includes('/memberships/')) {
        return Promise.resolve(
          jsonResponse({ team_id: 'B/C?D', role: 'member', team_name: 'Team B' })
        )
      }
      return Promise.resolve(jsonResponse({ token: 'synthetic-next-token' }))
    })

    const alias = await rawRequest({
      method: 'POST',
      path: `${PUBLIC_API_PREFIX}/me/switch-team`,
      body: { teamId: 'B/C?D' },
    })
    expect(alias.status).toBe(200)

    await rawRequest({
      method: 'POST',
      path: `${PUBLIC_API_PREFIX}/me/switch-team`,
      body: { teamId: 'B' },
    })

    expect(mocks.controlApiFetch).toHaveBeenCalledTimes(4)
    expect(callAt(0).url.pathname).toBe(
      `${PUBLIC_API_PREFIX}/external/users/${USER_ID}/memberships/${encodeURIComponent('B/C?D')}`
    )
    expect(callAt(0).url.pathname.split('/')).toHaveLength(8)
    expect(callAt(1).url.pathname).toBe(`${PUBLIC_API_PREFIX}/external/auth/session-token`)
    expect(callAt(2).url.pathname).toBe(
      `${PUBLIC_API_PREFIX}/external/users/${USER_ID}/memberships/B`
    )
  })

  it('encodes the target user on the GET /team/members/:userId/role preflight', async () => {
    mocks.controlApiFetch.mockImplementation((_url: string, init: RequestInit) =>
      Promise.resolve(init.method === 'GET' ? jsonResponse({ role: 'member' }) : jsonResponse({}))
    )

    await rawRequest({
      method: 'PATCH',
      path: `${PUBLIC_API_PREFIX}/team/members/${ENCODED_PROBE}/role`,
      body: { role: 'member' },
    })
    await rawRequest({
      method: 'PATCH',
      path: `${PUBLIC_API_PREFIX}/team/members/${TARGET_USER_ID}/role`,
      body: { role: 'member' },
    })

    expect(mocks.controlApiFetch).toHaveBeenCalledTimes(4)
    const first = callAt(0)
    expect(first.url.pathname).toBe(
      `${PUBLIC_API_PREFIX}/external/teams/${TEAM_ID}/members/${encodeURIComponent(
        ENCODED_PROBE_VALUE
      )}/role`
    )
    expect(first.url.pathname.split('/')).toHaveLength(9)
    expect(first.init.method).toBe('GET')
    expect(callAt(2).url.pathname).toBe(
      `${PUBLIC_API_PREFIX}/external/teams/${TEAM_ID}/members/${TARGET_USER_ID}/role`
    )
  })

  it('encodes the target user on the PATCH /team/members/:userId/role update', async () => {
    mocks.controlApiFetch.mockImplementation((_url: string, init: RequestInit) =>
      Promise.resolve(init.method === 'GET' ? jsonResponse({ role: 'member' }) : jsonResponse({}))
    )

    await rawRequest({
      method: 'PATCH',
      path: `${PUBLIC_API_PREFIX}/team/members/${ENCODED_PROBE}/role`,
      body: { role: 'member' },
    })
    await rawRequest({
      method: 'PATCH',
      path: `${PUBLIC_API_PREFIX}/team/members/${TARGET_USER_ID}/role`,
      body: { role: 'member' },
    })

    expect(mocks.controlApiFetch).toHaveBeenCalledTimes(4)
    const first = callAt(1)
    expect(first.url.pathname).toBe(
      `${PUBLIC_API_PREFIX}/external/teams/${TEAM_ID}/members/${encodeURIComponent(
        ENCODED_PROBE_VALUE
      )}/role`
    )
    expect(first.init.method).toBe('PATCH')
    expect(callAt(3).url.pathname).toBe(
      `${PUBLIC_API_PREFIX}/external/teams/${TEAM_ID}/members/${TARGET_USER_ID}/role`
    )
  })

  it('encodes the target user on DELETE /team/members/:userId', async () => {
    mocks.controlApiFetch.mockResolvedValue(jsonResponse({ deleted: true }))

    await rawRequest({
      method: 'DELETE',
      path: `${PUBLIC_API_PREFIX}/team/members/${ENCODED_PROBE}`,
    })
    await rawRequest({
      method: 'DELETE',
      path: `${PUBLIC_API_PREFIX}/team/members/${TARGET_USER_ID}`,
    })

    expect(mocks.controlApiFetch).toHaveBeenCalledTimes(2)
    const first = callAt(0)
    expect(first.url.pathname).toBe(
      `${PUBLIC_API_PREFIX}/external/teams/${TEAM_ID}/members/${encodeURIComponent(
        ENCODED_PROBE_VALUE
      )}`
    )
    expect(first.url.pathname.split('/')).toHaveLength(8)
    expect(first.init.method).toBe('DELETE')
    expect(callAt(1).url.pathname).toBe(
      `${PUBLIC_API_PREFIX}/external/teams/${TEAM_ID}/members/${TARGET_USER_ID}`
    )
  })
})
