import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { pool } from '../src/db.js'
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
  app.use((req, _res, next) => {
    ;(req as unknown as { adminAuth: { sub: string } }).adminAuth = {
      sub: '11111111-1111-4111-8111-111111111111',
    }
    next()
  })
  app.use(createAdminPluginWorkloadSdkRouter())
  return app
}

const validGrantBody = {
  recipeNamespace: 'sandbox-recipes',
  recipeName: 'sdk-recipe',
  capabilityFamily: 'promptBridge',
  provider: 'zai',
  allowedModels: ['glm-4.7'],
  promptTargets: [
    {
      targetRef: 'primary-zai',
      provider: 'zai',
      model: 'glm-4.7',
      credentialSlot: 'zai-api-key',
    },
  ],
  defaultTargetRef: 'primary-zai',
  allowedCallers: ['api'],
}

beforeEach(() => {
  vi.mocked(sdkDb.listGrants).mockReset()
  vi.mocked(sdkDb.upsertGrant).mockReset()
  vi.mocked(sdkDb.deleteGrant).mockReset()
  vi.mocked(sdkDb.getQuotaCounters).mockReset()
  vi.mocked(sdkDb.listInvocations).mockReset()
  // R3 allowlist cross-check (listEnabledModelNamesForProvider) queries pool.
  // Default to the seed model so the valid-grant success paths pass; individual
  // tests override to simulate a disallowed model.
  vi.mocked(pool.query).mockReset()
  vi.mocked(pool.query).mockResolvedValue({ rows: [{ model: 'glm-4.7' }], rowCount: 1 } as never)
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

  it('requires an explicit ordered target policy for promptBridge grants', async () => {
    const res = await request(buildApp())
      .post('/admin/plugin-workload-sdk/grants')
      .send({ ...validGrantBody, promptTargets: [] })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('promptTargets must be a non-empty array for promptBridge grants')
    expect(sdkDb.upsertGrant).not.toHaveBeenCalled()
  })

  it('rejects a default that is not the first operator-authored target', async () => {
    const res = await request(buildApp())
      .post('/admin/plugin-workload-sdk/grants')
      .send({ ...validGrantBody, defaultTargetRef: 'another-target' })
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('defaultTargetRef')
    expect(sdkDb.upsertGrant).not.toHaveBeenCalled()
  })

  it('persists an ordered multiprovider policy without exposing a credential value', async () => {
    vi.mocked(sdkDb.upsertGrant).mockResolvedValue({ id: 'multiprovider' } as never)
    vi.mocked(pool.query).mockImplementation(((_sql: string, values?: unknown[]) => {
      const provider = values?.[0]
      return Promise.resolve({
        rows: [{ model: provider === 'openai' ? 'gpt-5.4' : 'glm-4.7' }],
        rowCount: 1,
      })
    }) as never)
    const res = await request(buildApp())
      .post('/admin/plugin-workload-sdk/grants')
      .send({
        ...validGrantBody,
        promptTargets: [
          ...validGrantBody.promptTargets,
          {
            targetRef: 'openai-fallback',
            provider: 'openai',
            model: 'gpt-5.4',
            credentialSlot: 'openai-api-key-fb1',
          },
        ],
      })
    expect(res.status).toBe(200)
    expect(sdkDb.upsertGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultTargetRef: 'primary-zai',
        promptTargets: expect.arrayContaining([
          expect.objectContaining({ targetRef: 'openai-fallback', provider: 'openai' }),
        ]),
      }),
      '11111111-1111-4111-8111-111111111111'
    )
    expect(JSON.stringify(vi.mocked(sdkDb.upsertGrant).mock.calls)).not.toContain('secret-value')
  })

  it('requires an explicit provider for promptBridge grants (R1)', async () => {
    const { provider: _omit, ...bodyWithoutProvider } = validGrantBody
    const res = await request(buildApp())
      .post('/admin/plugin-workload-sdk/grants')
      .send(bodyWithoutProvider)
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('provider is required for promptBridge grants')
    expect(sdkDb.upsertGrant).not.toHaveBeenCalled()
  })

  it('rejects a provider outside the canonical set (R4)', async () => {
    const res = await request(buildApp())
      .post('/admin/plugin-workload-sdk/grants')
      .send({ ...validGrantBody, provider: 'not-a-provider' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('Invalid provider')
    expect(sdkDb.upsertGrant).not.toHaveBeenCalled()
  })

  it('rejects a prototype-chain provider value (R4, prototype-safe guard)', async () => {
    const res = await request(buildApp())
      .post('/admin/plugin-workload-sdk/grants')
      .send({ ...validGrantBody, provider: 'constructor' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('Invalid provider')
    expect(sdkDb.upsertGrant).not.toHaveBeenCalled()
  })

  it('accepts a new R4 provider (vertex)', async () => {
    vi.mocked(sdkDb.upsertGrant).mockResolvedValue({ id: 'gv' } as never)
    // R3 allowlist cross-check must see the vertex model as enabled.
    vi.mocked(pool.query).mockResolvedValue({
      rows: [{ model: 'gemini-2.5-pro' }],
      rowCount: 1,
    } as never)
    const res = await request(buildApp())
      .post('/admin/plugin-workload-sdk/grants')
      .send({
        ...validGrantBody,
        provider: 'vertex',
        allowedModels: ['gemini-2.5-pro'],
        promptTargets: [
          {
            targetRef: 'primary-vertex',
            provider: 'vertex',
            model: 'gemini-2.5-pro',
            credentialSlot: 'vertex-service-account-json',
          },
        ],
        defaultTargetRef: 'primary-vertex',
      })
    expect(res.status).toBe(200)
    expect(sdkDb.upsertGrant).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'vertex' }),
      '11111111-1111-4111-8111-111111111111'
    )
  })

  it('rejects additive slots for multi-slot or multiline providers before persisting policy', async () => {
    vi.mocked(sdkDb.upsertGrant).mockResolvedValue({ id: 'g-bedrock' } as never)
    vi.mocked(pool.query).mockResolvedValue({
      rows: [{ model: 'claude-3-7-sonnet' }],
      rowCount: 1,
    } as never)

    const bedrock = await request(buildApp())
      .post('/admin/plugin-workload-sdk/grants')
      .send({
        ...validGrantBody,
        provider: 'bedrock',
        allowedModels: ['claude-3-7-sonnet'],
        promptTargets: [
          {
            targetRef: 'bedrock-fallback-slot',
            provider: 'bedrock',
            model: 'claude-3-7-sonnet',
            credentialSlot: 'aws-access-key-id-fallback',
          },
        ],
        defaultTargetRef: 'bedrock-fallback-slot',
      })
    expect(bedrock.status).toBe(400)
    expect(bedrock.body.error).toContain('credentialSlot')
    expect(sdkDb.upsertGrant).not.toHaveBeenCalled()

    const vertex = await request(buildApp())
      .post('/admin/plugin-workload-sdk/grants')
      .send({
        ...validGrantBody,
        provider: 'vertex',
        allowedModels: ['gemini-2.5-pro'],
        promptTargets: [
          {
            targetRef: 'vertex-fallback-slot',
            provider: 'vertex',
            model: 'gemini-2.5-pro',
            credentialSlot: 'vertex-service-account-json-fallback',
          },
        ],
        defaultTargetRef: 'vertex-fallback-slot',
      })
    expect(vertex.status).toBe(400)
    expect(vertex.body.error).toContain('credentialSlot')
    expect(sdkDb.upsertGrant).not.toHaveBeenCalled()
  })

  it('does not require a provider for clientNotifications grants', async () => {
    vi.mocked(sdkDb.upsertGrant).mockResolvedValue({ id: 'g2' } as never)
    const res = await request(buildApp())
      .post('/admin/plugin-workload-sdk/grants')
      .send({
        recipeNamespace: 'sandbox-recipes',
        recipeName: 'r1',
        capabilityFamily: 'clientNotifications',
        allowedEventTypes: ['lead.followup.due'],
        allowedCallers: ['api'],
      })
    expect(res.status).toBe(200)
    expect(sdkDb.upsertGrant).toHaveBeenCalledWith(
      expect.objectContaining({ capabilityFamily: 'clientNotifications', provider: undefined }),
      '11111111-1111-4111-8111-111111111111'
    )
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
        provider: 'zai',
        allowedCallers: ['api'],
        quotaLimits: { maxRequestsPerRun: 10 },
      }),
      '11111111-1111-4111-8111-111111111111'
    )
  })

  it('rejects promptBridge targets outside the provider allowlist', async () => {
    // Allowlist for provider `zai` enables only glm-4.7; the request asks for a
    // model that is not enabled → 400 model_not_allowed listing the offenders.
    vi.mocked(pool.query).mockResolvedValue({ rows: [{ model: 'glm-4.7' }], rowCount: 1 } as never)
    const res = await request(buildApp())
      .post('/admin/plugin-workload-sdk/grants')
      .send({
        ...validGrantBody,
        promptTargets: [
          ...validGrantBody.promptTargets,
          {
            targetRef: 'not-allowed',
            provider: 'zai',
            model: 'glm-9-not-allowed',
            credentialSlot: 'zai-api-key-fb1',
          },
        ],
      })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('model_not_allowed')
    expect(res.body.provider).toBe('zai')
    expect(res.body.models).toEqual(['glm-9-not-allowed'])
    expect(sdkDb.upsertGrant).not.toHaveBeenCalled()
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
    expect(sdkDb.deleteGrant).toHaveBeenCalledWith(
      'g1',
      'sandbox-recipes',
      'sdk-recipe',
      '11111111-1111-4111-8111-111111111111'
    )
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
