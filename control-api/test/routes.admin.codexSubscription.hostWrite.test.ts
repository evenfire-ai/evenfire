import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express, { type NextFunction, type Request, type Response } from 'express'
import request from 'supertest'
import { createCodexCatalogTransportFromEnv } from '../src/services/codexSubscriptionCatalog.js'

const assignment = vi.hoisted(() => ({
  isCodexAssignmentAllowed: vi.fn(),
}))

vi.mock('../src/services/codexSubscriptionCatalog.js', async () => {
  const actual = await vi.importActual('../src/services/codexSubscriptionCatalog.js')
  return {
    ...actual,
    isCodexAssignmentAllowed: assignment.isCodexAssignmentAllowed,
  }
})

vi.mock('../src/db.js', () => ({
  pool: { query: vi.fn() },
}))

const { config } = await import('../src/config.js')
const { createAdminCodexSubscriptionRouter } =
  await import('../src/routes/admin/codexSubscription.js')

function makeGateway() {
  return {
    listResource: vi.fn().mockResolvedValue([]),
    getResource: vi.fn(),
    updateResource: vi.fn(),
    llmAllowedModelsConfigMap: () => ({ materialize: async () => {} }),
  }
}

function makeAuthedApp(gateway: ReturnType<typeof makeGateway>) {
  const app = express()
  app.use(express.json())
  app.use((req: Request & { adminAuth?: { sub: string } }, _res: Response, next: NextFunction) => {
    req.adminAuth = { sub: 'admin-1' }
    next()
  })
  app.use(
    createAdminCodexSubscriptionRouter(createCodexCatalogTransportFromEnv(), gateway as never)
  )
  return app
}

describe('admin Codex bind/unbind host write contract', () => {
  const originalFlag = process.env.CONTROL_API_CODEX_SUBSCRIPTION_ENABLED

  beforeEach(() => {
    config.codexSubscriptionEnabled = true
    process.env.CONTROL_API_CODEX_SUBSCRIPTION_ENABLED = 'true'
    assignment.isCodexAssignmentAllowed.mockReset()
    assignment.isCodexAssignmentAllowed.mockResolvedValue(true)
  })

  afterEach(() => {
    if (originalFlag === undefined) delete process.env.CONTROL_API_CODEX_SUBSCRIPTION_ENABLED
    else process.env.CONTROL_API_CODEX_SUBSCRIPTION_ENABLED = originalFlag
  })

  it('unbinds through the real Host write gate without throwing 500', async () => {
    const gateway = makeGateway()
    gateway.getResource.mockResolvedValue({
      metadata: { name: 'chatllm', resourceVersion: '11' },
      spec: {
        model: { provider: 'codex-subscription', name: 'gpt-5.6-luna', connectionRef: 'codex-aaa' },
      },
    })
    gateway.updateResource.mockResolvedValue({})
    const res = await request(makeAuthedApp(gateway)).post(
      '/admin/llm/providers/codex-subscription/connections/codex-aaa/hosts/chatllm/unbind'
    )
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ host: 'chatllm', connectionRef: 'unassigned' })
    expect(assignment.isCodexAssignmentAllowed).not.toHaveBeenCalled()
    expect(gateway.updateResource).toHaveBeenCalled()
  })

  it('binds through grant-scoped allowlist, not the global table', async () => {
    const gateway = makeGateway()
    gateway.getResource.mockResolvedValue({
      metadata: { name: 'chatllm', resourceVersion: '12' },
      spec: {
        model: {
          provider: 'codex-subscription',
          name: 'gpt-5.6-luna',
          connectionRef: 'unassigned',
        },
      },
    })
    gateway.updateResource.mockResolvedValue({})
    const res = await request(makeAuthedApp(gateway)).post(
      '/admin/llm/providers/codex-subscription/connections/codex-aaa/hosts/chatllm/bind'
    )
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ host: 'chatllm', connectionRef: 'codex-aaa' })
    expect(assignment.isCodexAssignmentAllowed).toHaveBeenCalledWith(
      expect.anything(),
      'codex-aaa',
      'gpt-5.6-luna'
    )
  })

  it('returns 422 when the destination grant does not offer the model', async () => {
    assignment.isCodexAssignmentAllowed.mockResolvedValue(false)
    const gateway = makeGateway()
    gateway.getResource.mockResolvedValue({
      metadata: { name: 'chatllm' },
      spec: {
        model: {
          provider: 'codex-subscription',
          name: 'gpt-5.6-luna',
          connectionRef: 'unassigned',
        },
      },
    })
    const res = await request(makeAuthedApp(gateway)).post(
      '/admin/llm/providers/codex-subscription/connections/codex-aaa/hosts/chatllm/bind'
    )
    expect(res.status).toBe(422)
    expect(res.body.error).toBe('invalid_host_spec')
    expect(gateway.updateResource).not.toHaveBeenCalled()
  })
})
