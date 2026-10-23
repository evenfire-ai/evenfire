import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type Server, createServer } from 'node:http'
import { type AddressInfo } from 'node:net'
import request from 'supertest'
import { createApp } from '../src/app.js'
import { config } from '../src/config.js'
import { setupInvitationPasswordWithToken } from '../src/services/invitationPasswordService.js'

const recoveryProof = 'synthetic-one-use-recovery-proof'

describe('password reset preview authority failures', () => {
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
    vi.unstubAllGlobals()
    if (upstream?.listening) {
      await new Promise<void>((resolve, reject) =>
        upstream!.close(error => (error ? reject(error) : resolve()))
      )
    }
    upstream = undefined
  })

  async function startUpstream(handler: Parameters<typeof createServer>[0]): Promise<void> {
    upstream = createServer(handler)
    await new Promise<void>((resolve, reject) => {
      upstream!.once('error', reject)
      upstream!.listen(0, '127.0.0.1', resolve)
    })
    const address = upstream.address() as AddressInfo
    config.controlApiBaseUrl = `http://127.0.0.1:${address.port}/api/v1`
  }

  async function submitReset() {
    return request(createApp()).post('/api/v1/invitations/password').send({
      token: recoveryProof,
      email: 'member@example.invalid',
      invitationId: '00000000-0000-4000-8000-000000000001',
      password: 'Synthetic-Replacement-Password-123',
    })
  }

  async function submitDedicatedReset() {
    return request(createApp()).post('/api/v1/invitations/password-reset').send({
      token: recoveryProof,
      email: 'member@example.invalid',
      invitationId: '00000000-0000-4000-8000-000000000001',
      password: 'Synthetic-Replacement-Password-123',
    })
  }

  async function lookupInvitation() {
    return request(createApp()).get(`/api/v1/invitations/token/${recoveryProof}`)
  }

  it('sanitizes a non-JSON preview failure before any one-use reset POST', async () => {
    let previewRequests = 0
    let resetPosts = 0
    let requestedPath = ''
    await startUpstream((req, res) => {
      if (req.method === 'POST') resetPosts += 1
      previewRequests += 1
      requestedPath = req.url || ''
      res.writeHead(502, { 'content-type': 'text/html' })
      res.end('<html>gateway unavailable</html>')
    })

    const response = await submitReset()

    expect(response.text).not.toContain(recoveryProof)
    expect(JSON.stringify(response.body)).not.toContain(recoveryProof)
    expect(response.status).toBe(503)
    expect(response.body).toEqual({ error: 'authority_unavailable', retryAfterSeconds: 2 })
    expect(response.headers['retry-after']).toBe('2')
    expect(response.headers['cache-control']).toContain('no-store')
    expect(requestedPath).toContain(encodeURIComponent(recoveryProof))
    expect(previewRequests).toBe(1)
    expect(resetPosts).toBe(0)
  })

  it('sanitizes a rejected preview transport and never submits the one-use reset POST', async () => {
    let previewRequests = 0
    let resetPosts = 0
    await startUpstream((req, res) => {
      if (req.method === 'POST') resetPosts += 1
      previewRequests += 1
      req.socket.destroy()
      res.destroy()
    })

    const response = await submitReset()

    expect(response.text).not.toContain(recoveryProof)
    expect(JSON.stringify(response.body)).not.toContain(recoveryProof)
    expect(response.status).toBe(503)
    expect(response.body).toEqual({ error: 'authority_unavailable', retryAfterSeconds: 2 })
    expect(response.headers['retry-after']).toBe('2')
    expect(previewRequests).toBe(1)
    expect(resetPosts).toBe(0)
  })

  it('sanitizes failures from the public invitation-preview route too', async () => {
    let requestedPath = ''
    await startUpstream((req, res) => {
      requestedPath = req.url || ''
      res.writeHead(502, { 'content-type': 'text/html' })
      res.end('<html>gateway unavailable</html>')
    })

    const response = await lookupInvitation()

    expect(response.text).not.toContain(recoveryProof)
    expect(JSON.stringify(response.body)).not.toContain(recoveryProof)
    expect(response.status).toBe(503)
    expect(response.body).toEqual({ error: 'authority_unavailable', retryAfterSeconds: 2 })
    expect(response.headers['retry-after']).toBe('2')
    expect(requestedPath).toContain(encodeURIComponent(recoveryProof))
  })

  it('keeps a reset dispatch failure unknown and never retries the one-use proof', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValue(new TypeError('private producer URL and signed proof'))
    vi.stubGlobal('fetch', fetchMock)
    config.controlApiBaseUrl = 'http://control-api.example.invalid/api/v1'

    const response = await submitDedicatedReset()

    expect(response.status).toBe(503)
    expect(response.body).toEqual({ error: 'recovery_outcome_unknown', retryAfterSeconds: 2 })
    expect(response.headers['retry-after']).toBe('2')
    expect(response.headers['set-cookie']).toBeUndefined()
    expect(response.text).not.toContain('private producer URL')
    expect(response.text).not.toContain(recoveryProof)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('keeps an unread reset response unknown without replaying the mutation', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: vi.fn().mockRejectedValue(new Error('private response proof')),
    })
    vi.stubGlobal('fetch', fetchMock)
    config.controlApiBaseUrl = 'http://control-api.example.invalid/api/v1'

    const response = await submitDedicatedReset()

    expect(response.status).toBe(503)
    expect(response.body).toEqual({ error: 'recovery_outcome_unknown', retryAfterSeconds: 2 })
    expect(response.headers['retry-after']).toBe('2')
    expect(response.headers['set-cookie']).toBeUndefined()
    expect(response.text).not.toContain('private response proof')
    expect(response.text).not.toContain(recoveryProof)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('preserves a definite internal callback failure without retry or proof replay', async () => {
    let resetPosts = 0
    await startUpstream((req, res) => {
      if (req.method === 'POST') resetPosts += 1
      res.writeHead(500, {
        'content-type': 'application/json',
        'retry-after': '1200',
        'x-ratelimit-remaining': '0',
      })
      res.end(JSON.stringify({ error: 'internal_error', detail: 'private reset diagnostic' }))
    })

    const response = await submitDedicatedReset()

    expect(response.status).toBe(500)
    expect(response.body).toEqual({ error: 'internal_error' })
    expect(response.headers['retry-after']).toBeUndefined()
    expect(response.headers['x-ratelimit-remaining']).toBeUndefined()
    expect(response.headers['cache-control']).toContain('no-store')
    expect(response.headers['set-cookie']).toBeUndefined()
    expect(response.text).not.toContain('private reset diagnostic')
    expect(response.text).not.toContain(recoveryProof)
    expect(resetPosts).toBe(1)
  })

  it('sanitizes an unrecognized producer client response without a retry hint', async () => {
    await startUpstream((_req, res) => {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'invalid payload', detail: 'private producer data' }))
    })

    const response = await submitDedicatedReset()

    expect(response.status).toBe(502)
    expect(response.body).toEqual({
      error: 'Password recovery service returned an invalid response',
    })
    expect(response.headers['retry-after']).toBeUndefined()
    expect(response.headers['set-cookie']).toBeUndefined()
    expect(response.text).not.toContain('private producer data')
    expect(response.text).not.toContain(recoveryProof)
  })

  it('returns a sanitized nonretryable error when request construction fails before dispatch', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    config.controlApiBaseUrl = 'not a valid URL'

    const response = await submitDedicatedReset()

    expect(response.status).toBe(500)
    expect(response.body).toEqual({ error: 'Internal Server Error' })
    expect(response.headers['retry-after']).toBeUndefined()
    expect(response.headers['set-cookie']).toBeUndefined()
    expect(response.text).not.toContain('not a valid URL')
    expect(response.text).not.toContain(recoveryProof)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('never forwards producer session fields from a successful reset', async () => {
    await startUpstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          id: '00000000-0000-4000-8000-000000000001',
          email: 'member@example.invalid',
          purpose: 'password_reset',
          status: 'accepted',
          passwordUpdated: true,
          reauthenticationRequired: true,
          token: 'synthetic-producer-session-token',
          sessionContext: {
            userId: 'synthetic-user',
            email: 'member@example.invalid',
            authGeneration: 2,
          },
        })
      )
    })

    const response = await submitDedicatedReset()

    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({
      passwordUpdated: true,
      reauthenticationRequired: true,
    })
    expect(response.body).not.toHaveProperty('token')
    expect(response.body).not.toHaveProperty('sessionContext')
    expect(String(response.headers['set-cookie'])).toContain('profile_session=;')
    expect(String(response.headers['set-cookie'])).not.toMatch(/profile_session=[^;]+/)
  })

  it('maps an ordinary invitation rejection on the dedicated reset route without a session cookie', async () => {
    const requests: Array<{ method?: string; url?: string; body?: Record<string, unknown> }> = []
    await startUpstream(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      }
      requests.push({
        method: req.method,
        url: req.url,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      })
      res.writeHead(409, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'invitation_not_pending' }))
    })

    const response = await submitDedicatedReset()

    expect(response.status).toBe(409)
    expect(response.body).toMatchObject({ error: 'invitation_not_pending' })
    expect(response.headers['set-cookie']).toBeUndefined()
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      method: 'POST',
      url: '/api/v1/external/invitations/password-token',
      body: {
        token: recoveryProof,
        email: 'member@example.invalid',
        invitationId: '00000000-0000-4000-8000-000000000001',
        password: 'Synthetic-Replacement-Password-123',
      },
    })
  })
})

const fetchMock = vi.fn()

describe('setupInvitationPasswordWithToken', () => {
  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => vi.unstubAllGlobals())

  it('preserves invalid recovery proof as a safe link error', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: 'invalid_invitation' }), { status: 400 })
    )

    await expect(
      setupInvitationPasswordWithToken(
        'synthetic-proof',
        'member@example.invalid',
        'synthetic-row-id',
        'synthetic-password'
      )
    ).resolves.toEqual({ error: 'invalid_invitation' })
  })

  it('continues to identify password-policy rejections as invalid passwords', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: 'invalid_password' }), { status: 400 })
    )

    await expect(
      setupInvitationPasswordWithToken(
        'synthetic-proof',
        'member@example.invalid',
        'synthetic-row-id',
        'short'
      )
    ).resolves.toEqual({ error: 'invalid_password' })
  })

  it('strips producer session fields from the reset response', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'synthetic-reset-row',
          email: 'member@example.invalid',
          status: 'accepted',
          passwordUpdated: true,
          reauthenticationRequired: true,
          token: 'synthetic-producer-session-token',
          sessionContext: { userId: 'synthetic-user', authGeneration: 2 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    )

    const result = await setupInvitationPasswordWithToken(
      'synthetic-proof',
      'member@example.invalid',
      'synthetic-row-id',
      'Synthetic-Valid-Password-123'
    )

    expect(result.data).toMatchObject({ passwordUpdated: true, reauthenticationRequired: true })
    expect(result.data).not.toHaveProperty('token')
    expect(result.data).not.toHaveProperty('sessionContext')
  })

  it('rejects an unrecognized producer error instead of treating it as a password error', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: 'invalid payload' }), { status: 400 })
    )

    await expect(
      setupInvitationPasswordWithToken(
        'synthetic-proof',
        'member@example.invalid',
        'synthetic-row-id',
        'Synthetic-Valid-Password-123'
      )
    ).rejects.toMatchObject({ name: 'ControlApiUnexpectedResponseError' })
  })
})
