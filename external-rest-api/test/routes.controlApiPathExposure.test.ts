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
const INVITATION_ID = '7f9c2bce-1a2b-4c3d-8e4f-0123456789ab'
const RESEND_ALIAS = `${PUBLIC_API_PREFIX}/members/invitations/..%2f..%2faccess%2fresolve%3f/resend`
const RESEND_POSITIVE = `${PUBLIC_API_PREFIX}/members/invitations/${INVITATION_ID}/resend`
const SFS_PREFIX = `${PUBLIC_API_PREFIX}/me/contexts/ctx-a/shared-filesystems/team-mission/proxy`
const SFS_RESOLVE_ALIAS = `${SFS_PREFIX}/..%2f..%2f..%2f..%2f..%2faccess%2fresolve`
const SFS_CAPABILITIES_ALIAS = `${SFS_PREFIX}/..%2f..%2f..%2f..%2f..%2faccess%2fcapabilities`
const SFS_POSITIVE = `${SFS_PREFIX}/files/report.txt?download=1`

const claims = {
  userId: '10000000-0000-4000-8000-000000000001',
  email: 'user@example.test',
  teamId: '',
  role: 'member' as const,
  exp: 2_000_000_000,
}

type RawResponse = { status: number; body: unknown; headers: http.IncomingHttpHeaders }

// Supertest resolves the URL through WHATWG URL, which can normalize encoded
// dot segments before sending. The exposure is defined by the path exactly as a
// proxy or an attacker sends it on the wire, so these cases go out over a raw
// loopback socket through the real createApp() server.
async function rawRequest(options: {
  method: 'GET' | 'POST'
  path: string
  token: string
  correlationId?: string
}): Promise<RawResponse> {
  const server = createApp().listen(0)
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })
  try {
    const { port } = server.address() as AddressInfo
    return await new Promise<RawResponse>((resolve, reject) => {
      const request = http.request(
        {
          host: '127.0.0.1',
          port,
          path: options.path,
          method: options.method,
          headers: {
            authorization: `Bearer ${options.token}`,
            ...(options.correlationId ? { 'x-correlation-id': options.correlationId } : {}),
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
      request.end()
    })
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
}

function invalidRequestEnvelope(correlationId: string) {
  return {
    error: {
      code: 'invalid_request',
      message: 'The request is not valid.',
      correlationId,
      retryable: false,
    },
  }
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

describe('control-api path exposure through public aliases', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.verifyToken.mockReturnValue(claims)
    vi.stubGlobal('fetch', mocks.controlApiFetch)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('rejects the encoded invitation resend alias before fetch while a valid resend stays live', async () => {
    mocks.controlApiFetch.mockResolvedValueOnce(jsonResponse({ resent: true }))

    const alias = await rawRequest({
      method: 'POST',
      path: RESEND_ALIAS,
      token: 'session-token',
      correlationId: 'resend-alias-correlation',
    })

    expect(alias.status).toBe(400)
    expect(alias.body).toEqual(invalidRequestEnvelope('resend-alias-correlation'))
    // The alias carried a valid session: the 400 is the path guard's client
    // error, not the auth gate answering 401.
    expect(mocks.verifyToken).toHaveBeenCalledWith('session-token')
    expect(mocks.controlApiFetch).not.toHaveBeenCalled()

    // Positive witness in the same test: the same app, router, auth middleware
    // and control-api client still forward a well-formed invitation id.
    const positive = await rawRequest({
      method: 'POST',
      path: RESEND_POSITIVE,
      token: 'session-token',
    })

    expect(positive.status).toBe(200)
    expect(positive.body).toEqual({ resent: true })
    expect(mocks.controlApiFetch).toHaveBeenCalledTimes(1)
    const [url, init] = mocks.controlApiFetch.mock.calls[0] as [string, RequestInit]
    expect(new URL(url).pathname).toBe(
      `${PUBLIC_API_PREFIX}/external/members/invitations/${INVITATION_ID}/resend`
    )
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>)['x-user-session-token']).toBe('session-token')
  })

  it('rejects both encoded SFS relay aliases before fetch while an ordinary SFS file read stays live', async () => {
    mocks.controlApiFetch.mockResolvedValueOnce(
      new Response('file-data', {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
      })
    )

    for (const aliasPath of [SFS_RESOLVE_ALIAS, SFS_CAPABILITIES_ALIAS]) {
      const alias = await rawRequest({
        method: 'GET',
        path: aliasPath,
        token: 'session-token',
        correlationId: 'sfs-alias-correlation',
      })

      expect(alias.status, aliasPath).toBe(400)
      expect(alias.body, aliasPath).toEqual(invalidRequestEnvelope('sfs-alias-correlation'))
    }
    expect(mocks.verifyToken).toHaveBeenCalledWith('session-token')
    expect(mocks.controlApiFetch).not.toHaveBeenCalled()

    // Positive witness in the same test: a normal SFS file path, including the
    // relay's opaque query forwarding, reaches the stubbed upstream.
    const positive = await rawRequest({
      method: 'GET',
      path: SFS_POSITIVE,
      token: 'session-token',
    })

    expect(positive.status).toBe(200)
    expect(positive.body).toBe('file-data')
    expect(mocks.controlApiFetch).toHaveBeenCalledTimes(1)
    const [url, init] = mocks.controlApiFetch.mock.calls[0] as [string, RequestInit]
    const upstream = new URL(url)
    expect(upstream.pathname).toBe(
      `${PUBLIC_API_PREFIX}/external/contexts/ctx-a/shared-filesystems/team-mission/proxy/files/report.txt`
    )
    expect(upstream.search).toBe('?download=1')
    expect(init.method).toBe('GET')
    expect((init.headers as Record<string, string>)['x-user-session-token']).toBe('session-token')
  })
})
