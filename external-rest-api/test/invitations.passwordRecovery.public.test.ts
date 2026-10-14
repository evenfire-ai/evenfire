import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type Server, createServer } from 'node:http'
import { type AddressInfo } from 'node:net'
import request from 'supertest'
import { createApp } from '../src/app.js'
import { config } from '../src/config.js'
import { setupInvitationPasswordWithToken } from '../src/services/invitationsService.js'

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

  it('keeps invalid-payload outside the allowlist when a password was supplied', async () => {
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
    ).rejects.toMatchObject({
      status: 503,
      body: { error: 'authority_unavailable' },
    })
  })
})
