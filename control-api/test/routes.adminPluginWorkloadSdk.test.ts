import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { pool } from '../src/db.js'
import { createAdminPluginWorkloadSdkRouter } from '../src/routes/admin/pluginWorkloadSdk.js'
import { isCodexAssignmentAllowed } from '../src/services/codexSubscriptionCatalog.js'
import * as sdkDb from '../src/services/pluginWorkloadSdkDb.js'
import { checkAndIncrement } from '../src/services/rateLimiterService.js'

vi.mock('../src/services/rateLimiterService.js', () => ({
  checkAndIncrement: vi.fn(),
}))

vi.mock('../src/db.js', () => {
  // The grant upsert route now composes its enabled-ness gate + the upsert inside
  // ONE carrier transaction (R1-H3 fase 2). `withTransaction` must invoke the
  // callback with the (mocked) pool so the gate's `listEnabledModelsWithStaleFor
  // Provider(provider, db)` read still hits `pool.query`; the per-model advisory
  // lock helpers are no-op in a mocked DB.
  const pool = {
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    connect: vi.fn(),
  }
  return {
    pool,
    withTransaction: vi.fn(async (cb: (db: typeof pool) => unknown) => cb(pool)),
    advisoryLockModelNames: vi.fn().mockResolvedValue(undefined),
    boundCarrierTransactionIdleTimeout: vi.fn().mockResolvedValue(undefined),
  }
})

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
    getPluginWorkloadSdkLegacyGrantInventory: vi.fn(),
    hasUsableClientNotificationRecipients: vi.fn(),
    listInvocations: vi.fn(),
  }
})

// Codex targets are gated against the per-connection catalog, not the flat
// llm_allowed_models union. The seam is mocked so tests pin the accept/reject
// contract without a live codex_subscription_connections table.
vi.mock('../src/services/codexSubscriptionCatalog.js', () => ({
  isCodexAssignmentAllowed: vi.fn(),
}))

const DEFAULT_ADMIN_SUB = '11111111-1111-4111-8111-111111111111'

const patchResourceAnnotations = vi.fn().mockResolvedValue({})

function buildApp(sub: string | null = DEFAULT_ADMIN_SUB) {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    ;(req as unknown as { adminAuth: { sub?: string } }).adminAuth = sub === null ? {} : { sub }
    next()
  })
  app.use(createAdminPluginWorkloadSdkRouter({ gateway: { patchResourceAnnotations } }))
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
  vi.mocked(sdkDb.getPluginWorkloadSdkLegacyGrantInventory).mockReset()
  vi.mocked(sdkDb.hasUsableClientNotificationRecipients).mockReset()
  vi.mocked(sdkDb.listInvocations).mockReset()
  vi.mocked(sdkDb.hasUsableClientNotificationRecipients).mockResolvedValue(true)
  vi.mocked(checkAndIncrement).mockReset()
  vi.mocked(checkAndIncrement).mockResolvedValue({
    allowed: true,
    remaining: 119,
    resetMs: Date.now() + 60_000,
    windowStartMs: Date.now(),
    count: 1,
  })
  // R3 allowlist cross-check (listEnabledModelNamesForProvider) queries pool.
  // Default to the seed model so the valid-grant success paths pass; individual
  // tests override to simulate a disallowed model.
  vi.mocked(pool.query).mockReset()
  vi.mocked(pool.query).mockResolvedValue({ rows: [{ model: 'glm-4.7' }], rowCount: 1 } as never)
  vi.mocked(isCodexAssignmentAllowed).mockReset()
  vi.mocked(isCodexAssignmentAllowed).mockResolvedValue(false)
  patchResourceAnnotations.mockReset()
  patchResourceAnnotations.mockResolvedValue({})
})

describe('routes/admin/pluginWorkloadSdk — grants', () => {
  it('applies a principal-scoped admin rate limit before grant reads', async () => {
    vi.mocked(sdkDb.listGrants).mockResolvedValue([])

    const res = await request(buildApp()).get('/admin/plugin-workload-sdk/grants')

    expect(res.status).toBe(200)
    expect(checkAndIncrement).toHaveBeenCalledWith(
      'plugin_workload_sdk_admin:11111111-1111-4111-8111-111111111111',
      120
    )
  })

  it('keeps separate admin principals in separate rate-limit buckets', async () => {
    vi.mocked(sdkDb.listGrants).mockResolvedValue([])

    await request(buildApp('admin-a')).get('/admin/plugin-workload-sdk/grants')
    await request(buildApp('admin-b')).get('/admin/plugin-workload-sdk/grants')
    await request(buildApp(null)).get('/admin/plugin-workload-sdk/grants')

    expect(checkAndIncrement).toHaveBeenNthCalledWith(1, 'plugin_workload_sdk_admin:admin-a', 120)
    expect(checkAndIncrement).toHaveBeenNthCalledWith(2, 'plugin_workload_sdk_admin:admin-b', 120)
    expect(checkAndIncrement).toHaveBeenNthCalledWith(
      3,
      'plugin_workload_sdk_admin:unauthenticated',
      120
    )
  })

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

  it('exposes the read-only legacy migration gate with optional recipe filters', async () => {
    vi.mocked(sdkDb.getPluginWorkloadSdkLegacyGrantInventory).mockResolvedValue({
      totalPromptBridgeGrants: 1,
      legacyPromptBridgeGrants: 0,
      activationReady: true,
      items: [],
    })
    const res = await request(buildApp()).get(
      '/admin/plugin-workload-sdk/legacy-inventory?recipeNamespace=sandbox-recipes&recipeName=r1'
    )
    expect(res.status).toBe(200)
    expect(res.body.activationReady).toBe(true)
    expect(sdkDb.getPluginWorkloadSdkLegacyGrantInventory).toHaveBeenCalledWith({
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

  it('rejects model ids outside the shared runnable grammar', async () => {
    const oversized = 'm'.repeat(129)
    const res = await request(buildApp())
      .post('/admin/plugin-workload-sdk/grants')
      .send({
        ...validGrantBody,
        allowedModels: [oversized],
        promptTargets: [{ ...validGrantBody.promptTargets[0], model: oversized }],
      })
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('allowedModels entries')
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
      '11111111-1111-4111-8111-111111111111',
      expect.anything() // carrier transaction client (R1-H3 fase 2)
    )
    expect(JSON.stringify(vi.mocked(sdkDb.upsertGrant).mock.calls)).not.toContain('secret-value')
  })

  it('accepts a policy catalogue larger than the bounded execution suffix', async () => {
    const targets = Array.from({ length: 5 }, (_, index) => ({
      targetRef: `target-${index}`,
      provider: 'zai',
      model: `glm-4.${index + 7}`,
      credentialSlot: 'zai-api-key',
    }))
    vi.mocked(sdkDb.upsertGrant).mockResolvedValue({ id: 'catalogue' } as never)
    vi.mocked(pool.query).mockResolvedValue({
      rows: targets.map(target => ({ model: target.model })),
      rowCount: targets.length,
    } as never)
    const res = await request(buildApp())
      .post('/admin/plugin-workload-sdk/grants')
      .send({
        ...validGrantBody,
        allowedModels: targets.map(target => target.model),
        promptTargets: targets,
        defaultTargetRef: targets[0]!.targetRef,
      })
    expect(res.status).toBe(200)
    expect(sdkDb.upsertGrant).toHaveBeenCalledWith(
      expect.objectContaining({ promptTargets: targets }),
      '11111111-1111-4111-8111-111111111111',
      expect.anything() // carrier transaction client (R1-H3 fase 2)
    )
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
      '11111111-1111-4111-8111-111111111111',
      expect.anything() // carrier transaction client (R1-H3 fase 2)
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
        allowedUserRefs: ['11111111-1111-4111-8111-111111111111'],
      })
    expect(res.status).toBe(200)
    expect(sdkDb.upsertGrant).toHaveBeenCalledWith(
      expect.objectContaining({ capabilityFamily: 'clientNotifications', provider: undefined }),
      '11111111-1111-4111-8111-111111111111',
      expect.anything() // carrier transaction client (R1-H3 fase 2)
    )
  })

  it('rejects clientNotifications grants without an authorized destination', async () => {
    const res = await request(buildApp())
      .post('/admin/plugin-workload-sdk/grants')
      .send({
        recipeNamespace: 'sandbox-recipes',
        recipeName: 'r1',
        capabilityFamily: 'clientNotifications',
        allowedEventTypes: ['lead.followup.due'],
        allowedCallers: ['api'],
      })
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('allowedTargetRefs or allowedUserRefs')
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
        provider: 'zai',
        allowedCallers: ['api'],
        // Issue #348 (plan 2.6, strip has LANDED): the deprecated per-run key
        // is tolerated on write but STRIPPED before persistence — the persisted
        // quotaLimits must be empty, not { maxRequestsPerRun: 10 }.
        quotaLimits: {},
      }),
      '11111111-1111-4111-8111-111111111111',
      expect.anything() // carrier transaction client (R1-H3 fase 2)
    )
  })

  it('accepts deprecated per-run keys, strips them, keeps active keys', async () => {
    // Issue #348 (plan 2.6/2.7): deprecated per-run keys stay shape-validated
    // (malformed still 400s, pinned above) but are dropped on write, while the
    // active per-minute/token keys persist untouched.
    vi.mocked(sdkDb.upsertGrant).mockResolvedValue({ id: 'g1' } as never)
    const res = await request(buildApp())
      .post('/admin/plugin-workload-sdk/grants')
      .send({
        ...validGrantBody,
        quotaLimits: {
          maxRequestsPerRun: 5,
          maxNotificationsPerRun: 7,
          maxInvocationsPerMinute: 30,
        },
      })
    expect(res.status).toBe(200)
    expect(sdkDb.upsertGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        quotaLimits: { maxInvocationsPerMinute: 30 },
      }),
      '11111111-1111-4111-8111-111111111111',
      expect.anything() // carrier transaction client (R1-H3 fase 2)
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

  // ── Claim 1b: Codex (oauth-broker) promptBridge targets ─────────────────────
  describe('codex-subscription promptTargets', () => {
    const codexGrantBody = {
      ...validGrantBody,
      provider: 'codex-subscription',
      allowedModels: ['gpt-5.3-codex'],
      promptTargets: [
        {
          targetRef: 'codex-primary',
          provider: 'codex-subscription',
          model: 'gpt-5.3-codex',
          credentialSlot: '',
          connectionRef: 'team-plus',
        },
      ],
      defaultTargetRef: 'codex-primary',
    }

    it('accepts a Codex target bound to a permitted connection offering the model', async () => {
      vi.mocked(sdkDb.upsertGrant).mockResolvedValue({ id: 'g-codex' } as never)
      vi.mocked(isCodexAssignmentAllowed).mockResolvedValue(true)
      const res = await request(buildApp())
        .post('/admin/plugin-workload-sdk/grants')
        .send(codexGrantBody)
      expect(res.status).toBe(200)
      expect(isCodexAssignmentAllowed).toHaveBeenCalledWith(
        expect.anything(),
        'team-plus',
        'gpt-5.3-codex'
      )
      expect(sdkDb.upsertGrant).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'codex-subscription',
          promptTargets: [
            {
              targetRef: 'codex-primary',
              provider: 'codex-subscription',
              model: 'gpt-5.3-codex',
              credentialSlot: '',
              connectionRef: 'team-plus',
            },
          ],
        }),
        '11111111-1111-4111-8111-111111111111',
        expect.anything() // carrier transaction client (R1-H3 fase 2)
      )
      expect(patchResourceAnnotations).toHaveBeenCalledWith(
        'workflowrecipes',
        'sdk-recipe',
        { 'clerum.io/codex-connection-ref': 'team-plus' },
        'sandbox-recipes'
      )
    })

    it('returns 503 when the recipe annotation cannot be stamped after a Codex upsert', async () => {
      vi.mocked(sdkDb.upsertGrant).mockResolvedValue({ id: 'g-codex' } as never)
      vi.mocked(isCodexAssignmentAllowed).mockResolvedValue(true)
      patchResourceAnnotations.mockRejectedValueOnce(new Error('apiserver down'))
      const res = await request(buildApp())
        .post('/admin/plugin-workload-sdk/grants')
        .send(codexGrantBody)
      expect(res.status).toBe(503)
      expect(res.body.error).toBe('recipe_annotation_stamp_failed')
    })

    it('rejects two Codex targets that name different grants', async () => {
      vi.mocked(isCodexAssignmentAllowed).mockResolvedValue(true)
      const res = await request(buildApp())
        .post('/admin/plugin-workload-sdk/grants')
        .send({
          ...codexGrantBody,
          promptTargets: [
            codexGrantBody.promptTargets[0],
            {
              targetRef: 'codex-fallback',
              provider: 'codex-subscription',
              model: 'gpt-5.4',
              credentialSlot: '',
              connectionRef: 'team-other',
            },
          ],
        })
      expect(res.status).toBe(400)
      expect(res.body.error).toBe('codex_connection_ref_conflict')
      expect(sdkDb.upsertGrant).not.toHaveBeenCalled()
    })

    it('fails closed when the connection is unknown, revoked, or does not offer the model', async () => {
      vi.mocked(isCodexAssignmentAllowed).mockResolvedValue(false)
      const res = await request(buildApp())
        .post('/admin/plugin-workload-sdk/grants')
        .send(codexGrantBody)
      expect(res.status).toBe(400)
      expect(res.body).toEqual({
        error: 'codex_connection_not_allowed',
        connectionRef: 'team-plus',
        model: 'gpt-5.3-codex',
      })
      expect(sdkDb.upsertGrant).not.toHaveBeenCalled()
    })

    it('accepts a stored Codex target without connectionRef as unassigned', async () => {
      vi.mocked(sdkDb.upsertGrant).mockResolvedValue({ id: 'g-legacy' } as never)
      const { connectionRef: _omitted, ...targetWithoutConnection } =
        codexGrantBody.promptTargets[0]!
      const res = await request(buildApp())
        .post('/admin/plugin-workload-sdk/grants')
        .send({ ...codexGrantBody, promptTargets: [targetWithoutConnection] })
      expect(res.status).toBe(200)
      expect(isCodexAssignmentAllowed).not.toHaveBeenCalled()
      expect(patchResourceAnnotations).not.toHaveBeenCalled()
      expect(sdkDb.upsertGrant).toHaveBeenCalled()
    })

    it('accepts the unassigned sentinel as a stored Codex target', async () => {
      vi.mocked(sdkDb.upsertGrant).mockResolvedValue({ id: 'g-legacy' } as never)
      const res = await request(buildApp())
        .post('/admin/plugin-workload-sdk/grants')
        .send({
          ...codexGrantBody,
          promptTargets: [{ ...codexGrantBody.promptTargets[0]!, connectionRef: 'unassigned' }],
        })
      expect(res.status).toBe(200)
      expect(isCodexAssignmentAllowed).not.toHaveBeenCalled()
      expect(patchResourceAnnotations).not.toHaveBeenCalled()
      expect(sdkDb.upsertGrant).toHaveBeenCalled()
    })

    it('rejects a static credentialSlot on a Codex (oauth-broker) target', async () => {
      const res = await request(buildApp())
        .post('/admin/plugin-workload-sdk/grants')
        .send({
          ...codexGrantBody,
          promptTargets: [
            { ...codexGrantBody.promptTargets[0]!, credentialSlot: 'openai-api-key' },
          ],
        })
      expect(res.status).toBe(400)
      expect(res.body.error).toContain('credentialSlot must be empty')
      expect(sdkDb.upsertGrant).not.toHaveBeenCalled()
    })

    it('rejects a connectionRef on an API-key (static-credentials) target', async () => {
      const res = await request(buildApp())
        .post('/admin/plugin-workload-sdk/grants')
        .send({
          ...validGrantBody,
          promptTargets: [{ ...validGrantBody.promptTargets[0]!, connectionRef: 'team-plus' }],
        })
      expect(res.status).toBe(400)
      expect(res.body.error).toContain('only valid for oauth-broker')
      expect(sdkDb.upsertGrant).not.toHaveBeenCalled()
    })

    it('keeps API-key promptTargets unchanged (no Codex gate, no connectionRef)', async () => {
      vi.mocked(sdkDb.upsertGrant).mockResolvedValue({ id: 'g1' } as never)
      const res = await request(buildApp())
        .post('/admin/plugin-workload-sdk/grants')
        .send(validGrantBody)
      expect(res.status).toBe(200)
      expect(isCodexAssignmentAllowed).not.toHaveBeenCalled()
      expect(sdkDb.upsertGrant).toHaveBeenCalledWith(
        expect.objectContaining({
          promptTargets: [
            {
              targetRef: 'primary-zai',
              provider: 'zai',
              model: 'glm-4.7',
              credentialSlot: 'zai-api-key',
            },
          ],
        }),
        '11111111-1111-4111-8111-111111111111',
        expect.anything() // carrier transaction client (R1-H3 fase 2)
      )
    })
  })

  // ── Pieza D: no-worsening tolerance for grant `allowed_models` (G3) ─────────
  describe('no-worsening tolerance', () => {
    const buildAppWithEmit = (emit: (event: unknown) => void) => {
      const app = express()
      app.use(express.json())
      app.use((req, _res, next) => {
        ;(req as unknown as { adminAuth: { sub?: string } }).adminAuth = { sub: DEFAULT_ADMIN_SUB }
        next()
      })
      app.use(createAdminPluginWorkloadSdkRouter({ emitIncoherenceTolerated: emit as never }))
      return app
    }
    // T1: derive the stored grant through the real row producer (`mapGrantRow`, the
    // same mapper `listGrants` uses) rather than hand-shaping a grant object, so
    // the fixture cannot drift from what the DB layer actually emits.
    const makeStoredGrant = (
      over: { promptTargets?: unknown; allowedModels?: string[] } = {}
    ): sdkDb.PluginWorkloadSdkGrant =>
      sdkDb.mapGrantRow({
        id: 'g-stored',
        recipe_namespace: validGrantBody.recipeNamespace,
        recipe_name: validGrantBody.recipeName,
        capability_family: 'promptBridge',
        provider: 'zai',
        allowed_models: over.allowedModels ?? validGrantBody.allowedModels,
        prompt_targets: over.promptTargets ?? validGrantBody.promptTargets,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      })
    const storedGrant = makeStoredGrant()

    it('tolerates a disabled promptTarget unchanged when coverage is not reduced (200 + emits)', async () => {
      // glm-4.7 is now disabled (enabled set omits it); the stored grant already
      // referenced it and the write does not shrink allowed_models.
      vi.mocked(pool.query).mockResolvedValue({
        rows: [{ model: 'other-enabled' }],
        rowCount: 1,
      } as never)
      vi.mocked(sdkDb.listGrants).mockResolvedValue([storedGrant] as never)
      vi.mocked(sdkDb.upsertGrant).mockResolvedValue({ id: 'g1' } as never)
      const emit = vi.fn()
      const res = await request(buildAppWithEmit(emit))
        .post('/admin/plugin-workload-sdk/grants')
        .send(validGrantBody)
      expect(res.status).toBe(200)
      expect(emit).toHaveBeenCalledWith(
        expect.objectContaining({
          resourceKind: 'grant',
          namespace: 'sandbox-recipes',
          name: 'sdk-recipe',
          provider: 'zai',
          model: 'glm-4.7',
          gate: 'grant',
        })
      )
      expect(sdkDb.upsertGrant).toHaveBeenCalled()
    })

    it('does NOT tolerate a coverage reduction around a disabled model → 400 (condition b)', async () => {
      // Stored offered {glm-4.7, glm-extra}; the write drops glm-extra while
      // keeping disabled glm-4.7 — a strict allowed_models reduction. Must 400.
      vi.mocked(pool.query).mockResolvedValue({
        rows: [{ model: 'other-enabled' }],
        rowCount: 1,
      } as never)
      vi.mocked(sdkDb.listGrants).mockResolvedValue([
        makeStoredGrant({ allowedModels: ['glm-4.7', 'glm-extra'] }),
      ] as never)
      const emit = vi.fn()
      const res = await request(buildAppWithEmit(emit))
        .post('/admin/plugin-workload-sdk/grants')
        .send(validGrantBody) // allowedModels: ['glm-4.7'] → glm-extra dropped
      expect(res.status).toBe(400)
      expect(res.body.error).toBe('model_not_allowed')
      expect(res.body.models).toEqual(['glm-4.7'])
      expect(emit).not.toHaveBeenCalled()
      expect(sdkDb.upsertGrant).not.toHaveBeenCalled()
    })

    it('does NOT tolerate a newly introduced disabled model → 400 (condition c)', async () => {
      // glm-4.7 stays enabled; the write introduces a NEW disabled target glm-new
      // absent from the stored grant. Even though coverage grows, (a)/(c) fail.
      vi.mocked(pool.query).mockResolvedValue({
        rows: [{ model: 'glm-4.7' }],
        rowCount: 1,
      } as never)
      vi.mocked(sdkDb.listGrants).mockResolvedValue([storedGrant] as never)
      const emit = vi.fn()
      const res = await request(buildAppWithEmit(emit))
        .post('/admin/plugin-workload-sdk/grants')
        .send({
          ...validGrantBody,
          allowedModels: ['glm-4.7', 'glm-new'],
          promptTargets: [
            ...validGrantBody.promptTargets,
            {
              targetRef: 'new-target',
              provider: 'zai',
              model: 'glm-new',
              credentialSlot: 'zai-api-key',
            },
          ],
        })
      expect(res.status).toBe(400)
      expect(res.body.error).toBe('model_not_allowed')
      expect(res.body.models).toEqual(['glm-new'])
      expect(emit).not.toHaveBeenCalled()
      expect(sdkDb.upsertGrant).not.toHaveBeenCalled()
    })

    it('does NOT tolerate promoting a disabled NON-default target to the default slot → 400 (mini-spec repro #3)', async () => {
      // Stored default = glm-4.7 (enabled); glm-old is a disabled NON-default
      // target. The write moves glm-old to promptTargets[0] (the default). Coverage
      // is not reduced, but role-scoping rejects the promotion to default.
      vi.mocked(pool.query).mockResolvedValue({
        rows: [{ model: 'glm-4.7' }],
        rowCount: 1,
      } as never) // glm-old disabled
      vi.mocked(sdkDb.listGrants).mockResolvedValue([
        makeStoredGrant({
          allowedModels: ['glm-4.7', 'glm-old'],
          promptTargets: [
            {
              targetRef: 'primary-zai',
              provider: 'zai',
              model: 'glm-4.7',
              credentialSlot: 'zai-api-key',
            },
            {
              targetRef: 'secondary',
              provider: 'zai',
              model: 'glm-old',
              credentialSlot: 'zai-api-key',
            },
          ],
        }),
      ] as never)
      const emit = vi.fn()
      const res = await request(buildAppWithEmit(emit))
        .post('/admin/plugin-workload-sdk/grants')
        .send({
          ...validGrantBody,
          allowedModels: ['glm-4.7', 'glm-old'],
          defaultTargetRef: 'secondary',
          promptTargets: [
            {
              targetRef: 'secondary',
              provider: 'zai',
              model: 'glm-old',
              credentialSlot: 'zai-api-key',
            },
            {
              targetRef: 'primary-zai',
              provider: 'zai',
              model: 'glm-4.7',
              credentialSlot: 'zai-api-key',
            },
          ],
        })
      expect(res.status).toBe(400)
      expect(res.body.error).toBe('model_not_allowed')
      expect(res.body.models).toEqual(['glm-old'])
      expect(emit).not.toHaveBeenCalled()
      expect(sdkDb.upsertGrant).not.toHaveBeenCalled()
    })

    it('tolerates DEMOTING a disabled default target to a non-default slot → 200 (not worsening)', async () => {
      // Stored default = glm-old (disabled). The write demotes it to a non-default
      // slot (glm-4.7 becomes the new, enabled default). Losing activity is not
      // worsening, so the disabled glm-old is tolerated at its non-default slot.
      vi.mocked(pool.query).mockResolvedValue({
        rows: [{ model: 'glm-4.7' }],
        rowCount: 1,
      } as never) // glm-old disabled, glm-4.7 enabled
      vi.mocked(sdkDb.listGrants).mockResolvedValue([
        makeStoredGrant({
          allowedModels: ['glm-old', 'glm-4.7'],
          promptTargets: [
            {
              targetRef: 'legacy',
              provider: 'zai',
              model: 'glm-old',
              credentialSlot: 'zai-api-key',
            },
            {
              targetRef: 'primary-zai',
              provider: 'zai',
              model: 'glm-4.7',
              credentialSlot: 'zai-api-key',
            },
          ],
        }),
      ] as never)
      vi.mocked(sdkDb.upsertGrant).mockResolvedValue({ id: 'g1' } as never)
      const emit = vi.fn()
      const res = await request(buildAppWithEmit(emit))
        .post('/admin/plugin-workload-sdk/grants')
        .send({
          ...validGrantBody,
          allowedModels: ['glm-4.7', 'glm-old'],
          defaultTargetRef: 'primary-zai',
          promptTargets: [
            {
              targetRef: 'primary-zai',
              provider: 'zai',
              model: 'glm-4.7',
              credentialSlot: 'zai-api-key',
            },
            {
              targetRef: 'legacy',
              provider: 'zai',
              model: 'glm-old',
              credentialSlot: 'zai-api-key',
            },
          ],
        })
      expect(res.status).toBe(200)
      expect(emit).toHaveBeenCalledWith(
        expect.objectContaining({
          resourceKind: 'grant',
          provider: 'zai',
          model: 'glm-old',
          gate: 'grant',
        })
      )
      expect(sdkDb.upsertGrant).toHaveBeenCalled()
    })

    it('does NOT emit the audit event when the upsert fails to persist (persist-safe)', async () => {
      // A tolerable disabled default target, but upsertGrant throws → the write did
      // not persist → no audit record must be emitted.
      vi.mocked(pool.query).mockResolvedValue({
        rows: [{ model: 'other-enabled' }],
        rowCount: 1,
      } as never)
      vi.mocked(sdkDb.listGrants).mockResolvedValue([storedGrant] as never)
      vi.mocked(sdkDb.upsertGrant).mockRejectedValue(new Error('db down'))
      const emit = vi.fn()
      const res = await request(buildAppWithEmit(emit))
        .post('/admin/plugin-workload-sdk/grants')
        .send(validGrantBody)
      expect(res.status).toBeGreaterThanOrEqual(500)
      expect(emit).not.toHaveBeenCalled()
    })
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

  // Fase 6 — soft quarantine of `stale` models on the grant write path. An ENABLED
  // but `stale` model assigned to a NEW target answers 200 with an additive
  // `warnings` array — NEVER a 400 — and a live reference already in the stored
  // grant is not revalidated. Assert the HTTP body (T4).
  describe('stale soft-quarantine warnings (Fase 6)', () => {
    // Stored grant derived through the real row producer (`mapGrantRow`) so the
    // fixture cannot drift from what the DB layer emits (T1).
    const makeStoredGrant = (
      over: { promptTargets?: unknown; allowedModels?: string[] } = {}
    ): sdkDb.PluginWorkloadSdkGrant =>
      sdkDb.mapGrantRow({
        id: 'g-stored',
        recipe_namespace: validGrantBody.recipeNamespace,
        recipe_name: validGrantBody.recipeName,
        capability_family: 'promptBridge',
        provider: 'zai',
        allowed_models: over.allowedModels ?? validGrantBody.allowedModels,
        prompt_targets: over.promptTargets ?? validGrantBody.promptTargets,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      })

    it('NEW target assigning an enabled+stale model → 200 + warnings, never 400', async () => {
      // glm-4.7 is enabled AND stale; there is no stored grant → the assignment is
      // new.
      vi.mocked(pool.query).mockResolvedValue({
        rows: [{ model: 'glm-4.7', stale: true }],
        rowCount: 1,
      } as never)
      vi.mocked(sdkDb.listGrants).mockResolvedValue([])
      vi.mocked(sdkDb.upsertGrant).mockResolvedValue({ id: 'g1' } as never)

      const res = await request(buildApp())
        .post('/admin/plugin-workload-sdk/grants')
        .send(validGrantBody)

      expect(res.status).toBe(200)
      expect(res.body.warnings).toEqual([
        {
          code: 'stale_model_assigned',
          provider: 'zai',
          model: 'glm-4.7',
          field: 'promptTargets[0].model',
        },
      ])
      expect(sdkDb.upsertGrant).toHaveBeenCalled()
    })

    it('EXISTING stale target (already in the stored grant) → 200 + NO warnings (not revalidated)', async () => {
      vi.mocked(pool.query).mockResolvedValue({
        rows: [{ model: 'glm-4.7', stale: true }],
        rowCount: 1,
      } as never)
      // The stored grant already references glm-4.7 as its target.
      vi.mocked(sdkDb.listGrants).mockResolvedValue([makeStoredGrant()] as never)
      vi.mocked(sdkDb.upsertGrant).mockResolvedValue({ id: 'g1' } as never)

      const res = await request(buildApp())
        .post('/admin/plugin-workload-sdk/grants')
        .send(validGrantBody)

      expect(res.status).toBe(200)
      expect(res.body.warnings).toBeUndefined()
      expect(sdkDb.upsertGrant).toHaveBeenCalled()
    })

    it('enabled non-stale target → 200 + NO warnings', async () => {
      vi.mocked(pool.query).mockResolvedValue({
        rows: [{ model: 'glm-4.7', stale: false }],
        rowCount: 1,
      } as never)
      vi.mocked(sdkDb.listGrants).mockResolvedValue([])
      vi.mocked(sdkDb.upsertGrant).mockResolvedValue({ id: 'g1' } as never)

      const res = await request(buildApp())
        .post('/admin/plugin-workload-sdk/grants')
        .send(validGrantBody)

      expect(res.status).toBe(200)
      expect(res.body.warnings).toBeUndefined()
    })
  })
})
