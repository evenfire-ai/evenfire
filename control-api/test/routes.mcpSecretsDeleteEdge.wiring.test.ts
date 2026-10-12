import { describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'

vi.mock('../src/services/rateLimiterService.js', () => ({
  checkAndIncrement: vi.fn(async (_key: string, maxPerMinute: number) => ({
    allowed: true,
    remaining: maxPerMinute - 1,
    resetMs: Date.now() + 60_000,
    windowStartMs: Date.now(),
    count: 1,
    backendAvailable: true,
  })),
}))

function createGateway() {
  return {
    deleteSecret: vi.fn(async (name: string, namespace?: string) => ({
      name,
      namespace: namespace || 'mcp-server',
      deleted: true as const,
    })),
    getSecret: vi.fn(async (name: string, namespace?: string) => ({
      metadata: { name, namespace, uid: `uid-${name}`, resourceVersion: '1', labels: {} },
      data: {},
    })),
    listResource: vi.fn(async () => [] as unknown[]),
  }
}

function createRollbackPermitStore() {
  return {
    issue: vi.fn(async () => undefined),
    claim: vi.fn(async () => null),
    release: vi.fn(async () => undefined),
    finalize: vi.fn(async () => undefined),
  }
}

describe('DELETE /admin/mcp-secrets/:name edge wiring', () => {
  it('mounts the calendar-minute edge limiter in front of the delete handler', async () => {
    // The route's limiter is built when the module loads, so lower its limit
    // before importing the router.
    vi.resetModules()
    const { config } = await import('../src/config.js')
    config.adminConnectorDeleteEdgePerMin = 2
    const { checkAndIncrement } = await import('../src/services/rateLimiterService.js')
    const { createAdminSecretsRouter } = await import('../src/routes/admin/secrets.js')
    const gateway = createGateway()
    const app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      ;(req as express.Request & { adminAuth?: { sub: string; jti: string } }).adminAuth = {
        sub: 'admin-wiring',
        jti: 'admin-wiring-jti',
      }
      next()
    })
    app.use(createAdminSecretsRouter(gateway as never, createRollbackPermitStore() as never))

    const send = () =>
      request(app)
        .delete('/admin/mcp-secrets/wiring-creds')
        .send({ uid: 'uid-wiring-creds', resourceVersion: '1' })
    await send().expect(200)
    await send().expect(200)
    const denied = await send().expect(429)

    // Witness: the two admitted deletes reached the ledger and the handler; the
    // third was refused by the edge before either.
    expect(gateway.deleteSecret).toHaveBeenCalledTimes(2)
    expect(vi.mocked(checkAndIncrement)).toHaveBeenCalledTimes(2)
    expect(denied.headers['ratelimit-policy']).toBe('2;w=60')
  })
})
