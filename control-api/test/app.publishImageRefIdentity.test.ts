import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { MockGateway } from './mockGateway.js'

const ORIGINAL_ENV = { ...process.env }

// Bypass the control-ui auth gate so supertest reaches the real POST /entries route.
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
// checkEvenfireImageRefMatchesEntry is a separate module, …) and override only
// resolvePublishScope (fixed org scope) and publishEntry (assert it is / isn't hit).
const registryClient = vi.hoisted(() => ({
  resolvePublishScope: vi.fn(),
  publishEntry: vi.fn(),
}))
vi.mock('../src/services/registryClient.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/services/registryClient.js')>()),
  resolvePublishScope: registryClient.resolvePublishScope,
  publishEntry: registryClient.publishEntry,
}))

vi.mock('../src/middleware/rateLimitMiddleware.js', () => ({
  rateLimitMiddleware:
    () => (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
      next(),
}))

const baseBody = (imageRef: string) => ({
  name: 'helloo',
  version: '1.0.0',
  entryType: 'mcp-server',
  description: 'x',
  author: 'x',
  mcpServer: { serverMode: 'local', imageRef },
})

describe('POST /admin/registry/entries: evenfire imageRef ↔ name identity (publish-time)', () => {
  beforeEach(() => {
    vi.resetModules()
    process.env = { ...ORIGINAL_ENV }
    process.env.CLERUM_REGISTRY_URL = 'https://registry.evenfire.ai'
    registryClient.resolvePublishScope.mockReset()
    registryClient.publishEntry.mockReset()
    registryClient.resolvePublishScope.mockResolvedValue({
      curator: false,
      orgName: 'acme',
      scope: '@acme',
    })
    registryClient.publishEntry.mockResolvedValue({ name: '@acme/helloo', version: '1.0.0' })
  })
  afterEach(() => {
    process.env = ORIGINAL_ENV
    vi.resetModules()
  })

  it('rejects a mismatched imageRef at publish (422) without creating the entry', async () => {
    const { createApp } = await import('../src/app.js')
    const app = createApp(new MockGateway('mcp-server') as never)
    // name → @acme/helloo, but the image repo is @acme/hello — mismatch.
    const res = await request(app)
      .post('/api/v1/admin/registry/entries')
      .send(baseBody('registry.evenfire.ai/acme/hello:v1'))
    expect(res.status).toBe(422)
    expect(res.body.error).toMatch(/must equal the entry name/)
    expect(res.body.error).toContain('acme/hello')
    expect(res.body.error).toContain('acme/helloo')
    expect(registryClient.publishEntry).not.toHaveBeenCalled()
  })

  it('allows a matching imageRef (201) and forwards the scoped name', async () => {
    const { createApp } = await import('../src/app.js')
    const app = createApp(new MockGateway('mcp-server') as never)
    const res = await request(app)
      .post('/api/v1/admin/registry/entries')
      .send(baseBody('registry.evenfire.ai/acme/helloo:v1'))
    expect(res.status).toBe(201)
    expect(registryClient.publishEntry).toHaveBeenCalledTimes(1)
    expect(registryClient.publishEntry.mock.calls[0][0]).toMatchObject({ name: '@acme/helloo' })
  })

  it('does not check a non-evenfire image (201) — the constraint is host-scoped', async () => {
    const { createApp } = await import('../src/app.js')
    const app = createApp(new MockGateway('mcp-server') as never)
    const res = await request(app)
      .post('/api/v1/admin/registry/entries')
      .send(baseBody('ghcr.io/acme/hello:v1'))
    expect(res.status).toBe(201)
    expect(registryClient.publishEntry).toHaveBeenCalledTimes(1)
  })
})
