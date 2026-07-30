import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { MockGateway } from './mockGateway.js'

const ORIGINAL_ENV = { ...process.env }

// Bypass the control-ui auth gate so the supertest request reaches the real
// publish-scope route (and the real config-driven merge) without a session
// cookie.
vi.mock('../src/middleware/controlUIAuth.js', () => ({
  requireAuthForControlUI: (
    req: express.Request,
    _res: express.Response,
    next: express.NextFunction
  ) => {
    ;(req as unknown as { adminAuth: unknown }).adminAuth = {
      sub: 'admin-1',
      role: 'admin',
      typ: 'user',
    }
    next()
  },
}))

// Partial-mock the registry client: keep every real export (applyPublishScope,
// RegistryUnavailableError, …) so the admin router still loads, and override
// only resolvePublishScope so the route returns a fixed org-bound scope
// regardless of connection mode — this test is about the merged
// publisherUiEnabled field, not scope resolution itself.
const registryClient = vi.hoisted(() => ({
  resolvePublishScope: vi.fn(),
}))
vi.mock('../src/services/registryClient.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/services/registryClient.js')>()),
  resolvePublishScope: registryClient.resolvePublishScope,
}))

vi.mock('../src/middleware/rateLimitMiddleware.js', () => ({
  rateLimitMiddleware:
    () => (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
      next(),
}))

describe('GET /admin/registry/publish-scope: publisherUiEnabled (effective, through the route)', () => {
  beforeEach(() => {
    vi.resetModules()
    process.env = { ...ORIGINAL_ENV }
    delete process.env.CONTROL_API_PUBLISHER_UI_ENABLED
    delete process.env.REGISTRY_CONNECTION_MODE
    delete process.env.CLERUM_REGISTRY_URL
    registryClient.resolvePublishScope.mockReset()
    registryClient.resolvePublishScope.mockResolvedValue({
      curator: false,
      orgName: 'acme',
      scope: '@acme',
    })
  })
  afterEach(() => {
    process.env = ORIGINAL_ENV
    vi.resetModules()
  })

  it('is true by default in self-hosted mode (now production-ready)', async () => {
    process.env.REGISTRY_CONNECTION_MODE = 'self-hosted'
    const { createApp } = await import('../src/app.js')
    const app = createApp(new MockGateway('mcp-server') as never)
    const res = await request(app).get('/api/v1/admin/registry/publish-scope')
    expect(res.status).toBe(200)
    expect(res.body.publisherUiEnabled).toBe(true)
    // The registry-derived fields still pass through untouched.
    expect(res.body.scope).toBe('@acme')
  })

  it('is true by default in managed mode', async () => {
    process.env.REGISTRY_CONNECTION_MODE = 'managed'
    const { createApp } = await import('../src/app.js')
    const app = createApp(new MockGateway('mcp-server') as never)
    const res = await request(app).get('/api/v1/admin/registry/publish-scope')
    expect(res.status).toBe(200)
    expect(res.body.publisherUiEnabled).toBe(true)
  })

  it('env override CONTROL_API_PUBLISHER_UI_ENABLED=true wins on self-hosted', async () => {
    process.env.REGISTRY_CONNECTION_MODE = 'self-hosted'
    process.env.CONTROL_API_PUBLISHER_UI_ENABLED = 'true'
    const { createApp } = await import('../src/app.js')
    const app = createApp(new MockGateway('mcp-server') as never)
    const res = await request(app).get('/api/v1/admin/registry/publish-scope')
    expect(res.body.publisherUiEnabled).toBe(true)
  })

  it('env override CONTROL_API_PUBLISHER_UI_ENABLED=false wins on managed', async () => {
    process.env.REGISTRY_CONNECTION_MODE = 'managed'
    process.env.CONTROL_API_PUBLISHER_UI_ENABLED = 'false'
    const { createApp } = await import('../src/app.js')
    const app = createApp(new MockGateway('mcp-server') as never)
    const res = await request(app).get('/api/v1/admin/registry/publish-scope')
    expect(res.body.publisherUiEnabled).toBe(false)
  })
})
