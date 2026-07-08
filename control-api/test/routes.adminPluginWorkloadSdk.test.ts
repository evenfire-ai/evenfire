import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createAdminPluginWorkloadSdkRouter } from '../src/routes/admin/pluginWorkloadSdk.js'
import * as sdkDb from '../src/services/pluginWorkloadSdkDb.js'

vi.mock('../src/db.js', () => ({
  pool: {
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    connect: vi.fn(),
  },
  withTransaction: vi.fn(),
}))

vi.mock('../src/services/pluginWorkloadSdkDb.js', async () => {
  const actual = await vi.importActual<typeof import('../src/services/pluginWorkloadSdkDb.js')>(
    '../src/services/pluginWorkloadSdkDb.js'
  )
  return {
    ...actual,
    listGrants: vi.fn(),
    upsertGrant: vi.fn(),
    deleteGrant: vi.fn(),
    getQuotaCounters: vi.fn(),
    listInvocations: vi.fn(),
  }
})

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use(createAdminPluginWorkloadSdkRouter())
  return app
}

const validGrantBody = {
  recipeNamespace: 'sandbox-recipes',
  recipeName: 'sdk-recipe',
  capabilityFamily: 'promptBridge',
  allowedModels: ['glm-4.7'],
  allowedCallers: ['api'],
}

beforeEach(() => {
  vi.mocked(sdkDb.listGrants).mockReset()
  vi.mocked(sdkDb.upsertGrant).mockReset()
  vi.mocked(sdkDb.deleteGrant).mockReset()
  vi.mocked(sdkDb.getQuotaCounters).mockReset()
  vi.mocked(sdkDb.listInvocations).mockReset()
})

describe('routes/admin/pluginWorkloadSdk — grants', () => {
  it('lists grants with optional recipe filters', async () => {
    vi.mocked(sdkDb.listGrants).mockResolvedValue([])
    const res = await request(buildApp()).get(
      '/admin/plugin-workload-sdk/grants?recipeNamespace=sandbox-recipes&recipeName=r1'
    )
    expect(res.status).toBe(200)
    expect(res.body.items).toEqual([])
    expect(sdkDb.listGrants).toHaveBeenCalledWith({
      recipeNamespace: 'sandbox-recipes',
      recipeName: 'r1',
    })
  })

  it('rejects an invalid capabilityFamily', async () => {
    const res = await request(buildApp())
      .post('/admin/plugin-workload-sdk/grants')
      .send({ ...validGrantBody, capabilityFamily: 'shellExec' })
    expect(res.status).toBe(400)
    expect(sdkDb.upsertGrant).not.toHaveBeenCalled()
  })

  it('rejects wildcard entries in allowlists', async () => {
    const res = await request(buildApp())
      .post('/admin/plugin-workload-sdk/grants')
      .send({ ...validGrantBody, allowedModels: ['*'] })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('wildcard_not_allowed')
    expect(sdkDb.upsertGrant).not.toHaveBeenCalled()
  })

  it('rejects allowedUserRefs that are not control-plane UUIDs', async () => {
    const res = await request(buildApp())
      .post('/admin/plugin-workload-sdk/grants')
      .send({
        recipeNamespace: 'sandbox-recipes',
        recipeName: 'r1',
        capabilityFamily: 'clientNotifications',
        allowedEventTypes: ['lead.followup.due'],
        allowedUserRefs: ['user@example.com'],
        allowedCallers: ['api'],
      })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('allowedUserRefs entries must be control-plane user UUIDs')
    expect(sdkDb.upsertGrant).not.toHaveBeenCalled()
  })

  it('requires non-empty allowedEventTypes for clientNotifications grants', async () => {
    const res = await request(buildApp())
      .post('/admin/plugin-workload-sdk/grants')
      .send({
        recipeNamespace: 'sandbox-recipes',
        recipeName: 'r1',
        capabilityFamily: 'clientNotifications',
        allowedCallers: ['api'],
      })
    expect(res.status).toBe(400)
  })

  it('requires non-empty allowedModels for promptBridge grants', async () => {
    const res = await request(buildApp())
      .post('/admin/plugin-workload-sdk/grants')
      .send({ ...validGrantBody, allowedModels: [] })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('allowedModels must be non-empty for promptBridge grants')
    expect(sdkDb.upsertGrant).not.toHaveBeenCalled()
  })

  it('rejects empty allowedCallers', async () => {
    const res = await request(buildApp())
      .post('/admin/plugin-workload-sdk/grants')
      .send({ ...validGrantBody, allowedCallers: [] })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('allowedCallers must be non-empty')
    expect(sdkDb.upsertGrant).not.toHaveBeenCalled()
  })

  it('rejects non-positive quota limits', async () => {
    const res = await request(buildApp())
      .post('/admin/plugin-workload-sdk/grants')
      .send({ ...validGrantBody, quotaLimits: { maxRequestsPerRun: 0 } })
    expect(res.status).toBe(400)
  })

  it('rejects model policies without provider/model', async () => {
    const res = await request(buildApp())
      .post('/admin/plugin-workload-sdk/grants')
      .send({ ...validGrantBody, modelPolicies: { 'policy-1': { provider: 'zai' } } })
    expect(res.status).toBe(400)
  })

  it('creates a grant with the normalized payload', async () => {
    vi.mocked(sdkDb.upsertGrant).mockResolvedValue({ id: 'g1' } as never)
    const res = await request(buildApp())
      .post('/admin/plugin-workload-sdk/grants')
      .send({
        ...validGrantBody,
        allowedCallers: ['api'],
        quotaLimits: { maxRequestsPerRun: 10 },
        modelPolicies: { 'support-v1': { provider: 'zai', model: 'glm-4.7' } },
      })
    expect(res.status).toBe(200)
    expect(sdkDb.upsertGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        recipeNamespace: 'sandbox-recipes',
        recipeName: 'sdk-recipe',
        capabilityFamily: 'promptBridge',
        allowedCallers: ['api'],
        quotaLimits: { maxRequestsPerRun: 10 },
      })
    )
  })

  it('returns 400 when deleting without recipe scope', async () => {
    const res = await request(buildApp()).delete('/admin/plugin-workload-sdk/grants/g1')
    expect(res.status).toBe(400)
    expect(sdkDb.deleteGrant).not.toHaveBeenCalled()
  })

  it('returns 404 when deleting a missing grant', async () => {
    vi.mocked(sdkDb.deleteGrant).mockResolvedValue(false)
    const res = await request(buildApp())
      .delete('/admin/plugin-workload-sdk/grants/missing')
      .query({ recipeNamespace: 'sandbox-recipes', recipeName: 'sdk-recipe' })
    expect(res.status).toBe(404)
  })

  it('deletes an existing grant scoped to its recipe binding', async () => {
    vi.mocked(sdkDb.deleteGrant).mockResolvedValue(true)
    const res = await request(buildApp())
      .delete('/admin/plugin-workload-sdk/grants/g1')
      .query({ recipeNamespace: 'sandbox-recipes', recipeName: 'sdk-recipe' })
    expect(res.status).toBe(200)
    expect(res.body.deleted).toBe(true)
    expect(sdkDb.deleteGrant).toHaveBeenCalledWith('g1', 'sandbox-recipes', 'sdk-recipe')
  })
})

describe('routes/admin/pluginWorkloadSdk — quota & audit', () => {
  it('returns quota counters for a recipe', async () => {
    vi.mocked(sdkDb.getQuotaCounters).mockResolvedValue([])
    const res = await request(buildApp()).get('/admin/plugin-workload-sdk/quota/sandbox-recipes/r1')
    expect(res.status).toBe(200)
    expect(sdkDb.getQuotaCounters).toHaveBeenCalledWith('sandbox-recipes', 'r1')
  })

  it('searches invocations with validated filters', async () => {
    vi.mocked(sdkDb.listInvocations).mockResolvedValue([])
    const res = await request(buildApp()).get(
      '/admin/plugin-workload-sdk/invocations?recipeName=r1&method=promptBridge&status=complete&limit=10'
    )
    expect(res.status).toBe(200)
    expect(sdkDb.listInvocations).toHaveBeenCalledWith(
      expect.objectContaining({
        recipeName: 'r1',
        method: 'promptBridge',
        status: 'complete',
        limit: 10,
      })
    )
  })

  it('drops invalid method/status filters instead of passing them through', async () => {
    vi.mocked(sdkDb.listInvocations).mockResolvedValue([])
    await request(buildApp()).get('/admin/plugin-workload-sdk/invocations?method=bogus&status=nope')
    expect(sdkDb.listInvocations).toHaveBeenCalledWith(
      expect.objectContaining({ method: undefined, status: undefined })
    )
  })
})
