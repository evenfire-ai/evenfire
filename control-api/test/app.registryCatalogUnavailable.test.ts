import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createApp } from '../src/app.js'
import { RegistryUnavailableError } from '../src/services/registryClient.js'
import { MockGateway } from './mockGateway.js'

// Bypass the control-ui auth gate so the supertest request reaches the real
// catalog route (and the real global error handler) without a session cookie.
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

// Partial-mock the registry client: keep every real export (RegistryProxyError,
// applyPublishScope, RegistryUnavailableError, …) so the admin router still
// loads, and override only the two hot catalog reads so we can make them throw.
const registryClient = vi.hoisted(() => ({
  searchEntries: vi.fn(),
  getCategories: vi.fn(),
}))
vi.mock('../src/services/registryClient.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/services/registryClient.js')>()),
  searchEntries: registryClient.searchEntries,
  getCategories: registryClient.getCategories,
}))

vi.mock('../src/middleware/rateLimitMiddleware.js', () => ({
  rateLimitMiddleware:
    () => (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
      next(),
}))

describe('app: registry-unavailable forwarding at the global error handler (real middleware)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('forwards a RegistryUnavailableError as 503 { error: registry_unavailable, message }', async () => {
    registryClient.searchEntries.mockRejectedValue(new RegistryUnavailableError())
    registryClient.getCategories.mockRejectedValue(new RegistryUnavailableError())
    const app = createApp(new MockGateway('mcp-server') as never)
    const res = await request(app).get('/api/v1/admin/registry/catalog')
    expect(res.status).toBe(503)
    expect(res.body.error).toBe('registry_unavailable')
    expect(res.body.message).toBe(
      'The registry is currently unavailable. Check the connection and try again.'
    )
  })

  it('collapses a plain status-less Error to 500 Internal Server Error', async () => {
    registryClient.searchEntries.mockRejectedValue(new Error('boom'))
    registryClient.getCategories.mockRejectedValue(new Error('boom'))
    const app = createApp(new MockGateway('mcp-server') as never)
    const res = await request(app).get('/api/v1/admin/registry/catalog')
    expect(res.status).toBe(500)
    expect(res.body.error).toBe('Internal Server Error')
  })

  it('does NOT forward a 502 with a non-allowlisted code (allowlist enforced) → 500', async () => {
    registryClient.searchEntries.mockRejectedValue(
      Object.assign(new Error('nope'), { status: 502, code: 'other' })
    )
    registryClient.getCategories.mockRejectedValue(
      Object.assign(new Error('nope'), { status: 502, code: 'other' })
    )
    const app = createApp(new MockGateway('mcp-server') as never)
    const res = await request(app).get('/api/v1/admin/registry/catalog')
    expect(res.status).toBe(500)
    expect(res.body.error).toBe('Internal Server Error')
  })
})
