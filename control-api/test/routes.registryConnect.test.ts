// test/routes.registryConnect.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { generateKeyPairSync } from 'node:crypto'
import request from 'supertest'
import { createRegistryConnectRouter } from '../src/routes/admin/registryConnect.js'

const { cfg } = vi.hoisted(() => ({
  cfg: {
    registryConnectionMode: 'self-hosted',
    registryUrl: 'https://example.com',
    registryAuthEnabled: true,
  } as Record<string, unknown>,
}))
vi.mock('../src/config.js', () => ({ config: cfg }))

const uiAuth = vi.hoisted(() => ({
  requireAuthForControlUI: vi.fn(
    (req: express.Request, _res: express.Response, next: express.NextFunction) => {
      ;(req as unknown as { adminAuth: unknown }).adminAuth = {
        sub: 'admin-uuid-123',
        role: 'admin',
        typ: 'user',
      }
      next()
    }
  ),
}))
vi.mock('../src/middleware/controlUIAuth.js', () => uiAuth)

const adminSvc = vi.hoisted(() => ({ findAdminById: vi.fn() }))
vi.mock('../src/services/adminAuthService.js', () => adminSvc)

const connDb = vi.hoisted(() => ({
  getRegistryConnection: vi.fn(),
  upsertPendingConnection: vi.fn(),
  markConnected: vi.fn(),
  deleteConnection: vi.fn(),
}))
vi.mock('../src/services/registryConnectionDb.js', () => connDb)

function app(): express.Express {
  const a = express()
  a.use(express.json())
  a.use(createRegistryConnectRouter())
  return a
}

function pkForTest(): string {
  return generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  }).privateKey
}

beforeEach(() => {
  vi.clearAllMocks()
  adminSvc.findAdminById.mockResolvedValue({
    id: 'admin-uuid-123',
    username: 'alice',
    status: 'active',
  })
  cfg.registryConnectionMode = 'self-hosted'
})
afterEach(() => vi.restoreAllMocks())

describe('registry connect flow', () => {
  it('GET → disconnected when no row', async () => {
    connDb.getRegistryConnection.mockResolvedValue(null)
    const res = await request(app()).get('/admin/registry/connect').expect(200)
    expect(res.body.state).toBe('disconnected')
  })

  it('409 not_self_hosted in managed mode', async () => {
    cfg.registryConnectionMode = 'managed'
    const res = await request(app()).get('/admin/registry/connect').expect(409)
    expect(res.body.error).toBe('not_self_hosted')
  })

  it('GET pending → polls the registry status endpoint and surfaces approval', async () => {
    connDb.getRegistryConnection.mockResolvedValue({
      status: 'pending',
      deploymentId: 'dep-9',
      keyId: 'kid-9',
      privateKeyPem: pkForTest(),
      requestedOrgName: 'acme',
    })
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ status: 'approved', suspended: false, claimed: false }), {
        status: 200,
      })
    )
    const res = await request(app()).get('/admin/registry/connect').expect(200)
    expect(res.body).toMatchObject({ state: 'approved', deploymentId: 'dep-9' })
    // it actually polled the registry status endpoint with a DPoP header
    const [url, init] = fetchSpy.mock.calls[0]
    expect(String(url)).toContain('/api/v1/deployments/dep-9/status')
    expect((init as RequestInit).headers).toHaveProperty('DPoP')
  })

  it('GET pending → degrades to local pending when the status poll fails', async () => {
    connDb.getRegistryConnection.mockResolvedValue({
      status: 'pending',
      deploymentId: 'dep-9',
      keyId: 'kid-9',
      privateKeyPem: pkForTest(),
      requestedOrgName: 'acme',
    })
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('registry unreachable'))
    const res = await request(app()).get('/admin/registry/connect').expect(200)
    expect(res.body).toMatchObject({
      state: 'pending',
      deploymentId: 'dep-9',
      requestedOrgName: 'acme',
    })
  })

  it('POST request → registers, persists pending, returns 202', async () => {
    connDb.getRegistryConnection.mockResolvedValue(null)
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(
          JSON.stringify({ deployment_id: 'dep-9', key_id: 'kid-9', status: 'pending' }),
          { status: 202 }
        )
      )
    const res = await request(app())
      .post('/admin/registry/connect/request')
      .send({ requested_org_name: 'acme', contact_email: 'a@x.io' })
      .expect(202)
    expect(res.body).toMatchObject({
      state: 'pending',
      deploymentId: 'dep-9',
      requestedOrgName: 'acme',
    })
    // registered against the registry register endpoint with a pop in the body
    const [url, init] = fetchSpy.mock.calls[0]
    expect(String(url)).toContain('/api/v1/deployments/register')
    const body = JSON.parse((init as RequestInit).body as string)
    expect(body.requested_org_name).toBe('acme')
    expect(typeof body.pop).toBe('string')
    expect(typeof body.public_key_pem).toBe('string')
    // persisted pending with the registry-assigned ids + the generated keypair
    expect(connDb.upsertPendingConnection).toHaveBeenCalledWith(
      expect.objectContaining({ deploymentId: 'dep-9', keyId: 'kid-9', requestedOrgName: 'acme' })
    )
  })

  it('POST request → 409 already_connected when a connected row exists', async () => {
    connDb.getRegistryConnection.mockResolvedValue({
      status: 'connected',
      clientId: 'c',
      orgName: 'acme',
    })
    const res = await request(app())
      .post('/admin/registry/connect/request')
      .send({ requested_org_name: 'acme', contact_email: 'a@x.io' })
      .expect(409)
    expect(res.body.error).toBe('already_connected')
  })

  it('POST request → 400 org_blocklisted surfaces the registry rejection (not opaque 502)', async () => {
    connDb.getRegistryConnection.mockResolvedValue(null)
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'org_blocklisted' }), { status: 400 })
    )
    const res = await request(app())
      .post('/admin/registry/connect/request')
      .send({ requested_org_name: 'clerum', contact_email: 'a@x.io' })
      .expect(400)
    expect(res.body.error).toBe('org_blocklisted')
    expect(connDb.upsertPendingConnection).not.toHaveBeenCalled()
  })

  it('POST request → 502 registry_integration_error on an unexpected registry failure', async () => {
    connDb.getRegistryConnection.mockResolvedValue(null)
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'boom' }), { status: 500 })
    )
    const res = await request(app())
      .post('/admin/registry/connect/request')
      .send({ requested_org_name: 'acme', contact_email: 'a@x.io' })
      .expect(502)
    expect(res.body.error).toBe('registry_integration_error')
  })

  it('POST claim → exchanges the token, persists creds, returns connected', async () => {
    connDb.getRegistryConnection.mockResolvedValue({
      status: 'pending',
      deploymentId: 'dep-9',
      keyId: 'kid-9',
      privateKeyPem: pkForTest(),
      requestedOrgName: 'acme',
    })
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ client_id: 'cid', client_secret: 'csecret', org: 'acme' }), {
        status: 200,
      })
    )
    const res = await request(app())
      .post('/admin/registry/connect/claim')
      .send({ claim_token: 'tok-abc' })
      .expect(200)
    expect(res.body).toMatchObject({ state: 'connected', org: 'acme' })
    const [url, init] = fetchSpy.mock.calls[0]
    expect(String(url)).toContain('/api/v1/deployments/claim')
    expect((init as RequestInit).headers).toHaveProperty('DPoP')
    expect(connDb.markConnected).toHaveBeenCalledWith({
      clientId: 'cid',
      clientSecret: 'csecret',
      orgName: 'acme',
    })
  })

  it('POST claim → 410 claim_expired maps the registry 410', async () => {
    connDb.getRegistryConnection.mockResolvedValue({
      status: 'pending',
      deploymentId: 'dep-9',
      keyId: 'kid-9',
      privateKeyPem: pkForTest(),
    })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'expired' }), { status: 410 })
    )
    const res = await request(app())
      .post('/admin/registry/connect/claim')
      .send({ claim_token: 't' })
      .expect(410)
    expect(res.body.error).toBe('claim_expired')
  })

  it('POST claim → 401 claim_rejected maps a registry 401 (bad PoP / bad token)', async () => {
    connDb.getRegistryConnection.mockResolvedValue({
      status: 'pending',
      deploymentId: 'dep-9',
      keyId: 'kid-9',
      privateKeyPem: pkForTest(),
    })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'invalid_pop' }), { status: 401 })
    )
    const res = await request(app())
      .post('/admin/registry/connect/claim')
      .send({ claim_token: 't' })
      .expect(401)
    expect(res.body.error).toBe('claim_rejected')
  })

  it('POST claim → 409 already_claimed maps the registry 409 (not opaque 502)', async () => {
    connDb.getRegistryConnection.mockResolvedValue({
      status: 'pending',
      deploymentId: 'dep-9',
      keyId: 'kid-9',
      privateKeyPem: pkForTest(),
    })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'already_claimed' }), { status: 409 })
    )
    const res = await request(app())
      .post('/admin/registry/connect/claim')
      .send({ claim_token: 't' })
      .expect(409)
    expect(res.body.error).toBe('already_claimed')
    expect(connDb.markConnected).not.toHaveBeenCalled()
  })

  it('POST claim → 409 client_unavailable is surfaced distinctly', async () => {
    connDb.getRegistryConnection.mockResolvedValue({
      status: 'pending',
      deploymentId: 'dep-9',
      keyId: 'kid-9',
      privateKeyPem: pkForTest(),
    })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'client_unavailable' }), { status: 409 })
    )
    const res = await request(app())
      .post('/admin/registry/connect/claim')
      .send({ claim_token: 't' })
      .expect(409)
    expect(res.body.error).toBe('client_unavailable')
  })

  it('POST claim → 409 not_pending when no pending row exists', async () => {
    connDb.getRegistryConnection.mockResolvedValue(null)
    const res = await request(app())
      .post('/admin/registry/connect/claim')
      .send({ claim_token: 't' })
      .expect(409)
    expect(res.body.error).toBe('not_pending')
  })

  it('DELETE → 204 drops the row', async () => {
    connDb.getRegistryConnection.mockResolvedValue({ status: 'pending', deploymentId: 'dep-9' })
    await request(app()).delete('/admin/registry/connect').expect(204)
    expect(connDb.deleteConnection).toHaveBeenCalled()
  })
})
