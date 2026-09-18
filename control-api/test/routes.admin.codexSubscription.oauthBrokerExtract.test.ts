import { beforeEach, describe, expect, it, vi } from 'vitest'
import express, { type NextFunction, type Request, type Response } from 'express'
import request from 'supertest'

vi.mock('@clerum/llm-providers', async () => {
  const actual =
    await vi.importActual<typeof import('@clerum/llm-providers')>('@clerum/llm-providers')
  return {
    ...actual,
    isLlmProviderId: (id: unknown): boolean =>
      actual.isLlmProviderId(id) || id === 'fixture-broker',
    PROVIDER_AUTH_MODE: {
      ...actual.PROVIDER_AUTH_MODE,
      'fixture-broker': 'oauth-broker',
    },
  }
})

vi.mock('../src/db.js', () => ({
  pool: { query: vi.fn() },
}))

const { config } = await import('../src/config.js')
const { createCodexCatalogTransportFromEnv } =
  await import('../src/services/codexSubscriptionCatalog.js')
const { createAdminCodexSubscriptionRouter } =
  await import('../src/routes/admin/codexSubscription.js')

describe('subscription admin extract guard', () => {
  beforeEach(() => {
    config.codexSubscriptionEnabled = true
  })

  it('404s a fixture oauth-broker that this router does not host', async () => {
    const app = express()
    app.use(express.json())
    app.use(
      (req: Request & { adminAuth?: { sub: string } }, _res: Response, next: NextFunction) => {
        req.adminAuth = { sub: 'admin-1' }
        next()
      }
    )
    app.use(createAdminCodexSubscriptionRouter(createCodexCatalogTransportFromEnv()))
    const res = await request(app).get('/admin/llm/providers/fixture-broker/connections')
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'not_found' })
  })
})
