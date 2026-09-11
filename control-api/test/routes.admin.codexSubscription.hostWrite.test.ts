import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express, { type NextFunction, type Request, type Response } from 'express'
import request from 'supertest'
import { createCodexCatalogTransportFromEnv } from '../src/services/codexSubscriptionCatalog.js'

const assignment = vi.hoisted(() => ({
  isCodexAssignmentAllowed: vi.fn(),
  listOfferedCodexModelsForAssignment: vi.fn(),
}))

vi.mock('../src/services/codexSubscriptionCatalog.js', async () => {
  const actual = await vi.importActual('../src/services/codexSubscriptionCatalog.js')
  return {
    ...actual,
    isCodexAssignmentAllowed: assignment.isCodexAssignmentAllowed,
    listOfferedCodexModelsForAssignment: assignment.listOfferedCodexModelsForAssignment,
  }
})

vi.mock('../src/db.js', () => ({
  pool: { query: vi.fn() },
}))

const { pool } = await import('../src/db.js')
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
    assignment.listOfferedCodexModelsForAssignment.mockReset()
    assignment.listOfferedCodexModelsForAssignment.mockResolvedValue(['gpt-5.6-luna'])
    vi.mocked(pool.query).mockReset()
    vi.mocked(pool.query).mockResolvedValue({
      rows: [
        {
          id: 'id-codex-aaa',
          connection_key: 'codex-aaa',
          display_name: 'Team A',
          default_model: null,
          created_by: null,
          status: 'connected',
          credential_revision: 1,
          catalog_revision: 1,
          account_fingerprint: 'fp',
          catalog_status: 'ready',
          catalog_synced_at: new Date(),
          last_refresh_at: new Date(),
          last_auth_at: new Date(),
          refresh_lock_token: null,
          refresh_lock_expires_at: null,
          revoked_at: null,
          created_at: new Date(),
          updated_at: new Date(),
        },
      ],
      rowCount: 1,
    })
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
    expect(res.body).toEqual({
      host: 'chatllm',
      connectionRef: 'unassigned',
      model: 'gpt-5.6-luna',
    })
    expect(assignment.isCodexAssignmentAllowed).not.toHaveBeenCalled()
    expect(assignment.listOfferedCodexModelsForAssignment).not.toHaveBeenCalled()
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
    expect(res.body).toEqual({
      host: 'chatllm',
      connectionRef: 'codex-aaa',
      model: 'gpt-5.6-luna',
    })
    expect(assignment.isCodexAssignmentAllowed).toHaveBeenCalledWith(
      expect.anything(),
      'codex-aaa',
      'gpt-5.6-luna'
    )
  })

  it('seeds the first offered model when the Host has no name', async () => {
    assignment.listOfferedCodexModelsForAssignment.mockResolvedValue(['gpt-5.1', 'gpt-5.6-luna'])
    const gateway = makeGateway()
    gateway.getResource.mockResolvedValue({
      metadata: { name: 'chatllm', resourceVersion: '12' },
      spec: {
        model: { provider: 'codex-subscription', connectionRef: 'unassigned' },
      },
    })
    gateway.updateResource.mockResolvedValue({})
    const res = await request(makeAuthedApp(gateway)).post(
      '/admin/llm/providers/codex-subscription/connections/codex-aaa/hosts/chatllm/bind'
    )
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      host: 'chatllm',
      connectionRef: 'codex-aaa',
      model: 'gpt-5.1',
    })
    expect(gateway.updateResource).toHaveBeenCalledWith(
      'hosts',
      'chatllm',
      expect.objectContaining({
        spec: expect.objectContaining({
          model: expect.objectContaining({
            provider: 'codex-subscription',
            connectionRef: 'codex-aaa',
            name: 'gpt-5.1',
          }),
        }),
      }),
      expect.any(String)
    )
    expect(assignment.isCodexAssignmentAllowed).toHaveBeenCalledWith(
      expect.anything(),
      'codex-aaa',
      'gpt-5.1'
    )
  })

  it('rematches to an offered model instead of 422 when the current name is not on the grant', async () => {
    assignment.listOfferedCodexModelsForAssignment.mockResolvedValue(['gpt-5.1'])
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
    gateway.updateResource.mockResolvedValue({})
    const res = await request(makeAuthedApp(gateway)).post(
      '/admin/llm/providers/codex-subscription/connections/codex-aaa/hosts/chatllm/bind'
    )
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      host: 'chatllm',
      connectionRef: 'codex-aaa',
      model: 'gpt-5.1',
    })
    expect(assignment.isCodexAssignmentAllowed).toHaveBeenCalledWith(
      expect.anything(),
      'codex-aaa',
      'gpt-5.1'
    )
  })

  it('returns 422 when the destination grant has no offered models', async () => {
    assignment.listOfferedCodexModelsForAssignment.mockResolvedValue([])
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
    expect(res.body.error).toBe('catalog_not_ready')
    expect(gateway.updateResource).not.toHaveBeenCalled()
    expect(assignment.isCodexAssignmentAllowed).not.toHaveBeenCalled()
  })

  it('converts a non-Codex host and seeds the grant default model', async () => {
    assignment.listOfferedCodexModelsForAssignment.mockResolvedValue(['gpt-5.1', 'gpt-5.6-luna'])
    vi.mocked(pool.query).mockResolvedValue({
      rows: [
        {
          id: 'id-codex-aaa',
          connection_key: 'codex-aaa',
          display_name: 'Team A',
          default_model: 'gpt-5.1',
          created_by: null,
          status: 'connected',
          credential_revision: 1,
          catalog_revision: 1,
          account_fingerprint: 'fp',
          catalog_status: 'ready',
          catalog_synced_at: new Date(),
          last_refresh_at: new Date(),
          last_auth_at: new Date(),
          refresh_lock_token: null,
          refresh_lock_expires_at: null,
          revoked_at: null,
          created_at: new Date(),
          updated_at: new Date(),
        },
      ],
      rowCount: 1,
    })
    const gateway = makeGateway()
    gateway.getResource.mockResolvedValue({
      metadata: { name: 'api-agent', resourceVersion: '4' },
      spec: { model: { provider: 'openai', name: 'gpt-5.4' }, secretRef: 'openai-secret' },
    })
    gateway.updateResource.mockResolvedValue({})
    const res = await request(makeAuthedApp(gateway)).post(
      '/admin/llm/providers/codex-subscription/connections/codex-aaa/hosts/api-agent/bind'
    )
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      host: 'api-agent',
      connectionRef: 'codex-aaa',
      model: 'gpt-5.1',
    })
    expect(gateway.updateResource).toHaveBeenCalledWith(
      'hosts',
      'api-agent',
      expect.objectContaining({
        spec: expect.objectContaining({
          model: expect.objectContaining({
            provider: 'codex-subscription',
            connectionRef: 'codex-aaa',
            name: 'gpt-5.1',
          }),
        }),
      }),
      expect.any(String)
    )
  })

  it('completes an already-bound Host that is missing spec.model.name', async () => {
    assignment.listOfferedCodexModelsForAssignment.mockResolvedValue(['gpt-5.1'])
    const gateway = makeGateway()
    gateway.getResource.mockResolvedValue({
      metadata: { name: 'chatllm' },
      spec: {
        model: {
          provider: 'codex-subscription',
          connectionRef: 'codex-aaa',
        },
      },
    })
    gateway.updateResource.mockResolvedValue({})
    const res = await request(makeAuthedApp(gateway)).post(
      '/admin/llm/providers/codex-subscription/connections/codex-aaa/hosts/chatllm/bind'
    )
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      host: 'chatllm',
      connectionRef: 'codex-aaa',
      model: 'gpt-5.1',
    })
    expect(gateway.updateResource).toHaveBeenCalled()
  })
})
