import { beforeEach, describe, expect, it, vi } from 'vitest'
import { hashCodexCompletionRequestV1 } from '@clerum/llm-provider-attempt-contract'
import {
  LlmProviderAttemptAuthorizeError,
  type LlmProviderAttemptAuthorizerDeps,
  authorizeLlmProviderAttempt,
  computeCodexPolicyHash,
} from '../src/services/llmProviderAttemptAuthorizer.js'
import type { McpHostAccessClaims } from '../src/utils/auth/mcpHostJwtToken.js'

const lockPluginWorkloadSdkRecipe = vi.hoisted(() => vi.fn())
const getPluginWorkloadSdkProviderAttemptForUpdate = vi.hoisted(() => vi.fn())
const pluginWorkloadSdkSpendOutcomeExists = vi.hoisted(() => vi.fn())
const promoteReservedOauthBrokerProviderAttempt = vi.hoisted(() => vi.fn())

vi.mock('../src/services/pluginWorkloadSdkDb.js', async () => {
  const actual = await vi.importActual<typeof import('../src/services/pluginWorkloadSdkDb.js')>(
    '../src/services/pluginWorkloadSdkDb.js'
  )
  return {
    ...actual,
    lockPluginWorkloadSdkRecipe,
    getPluginWorkloadSdkProviderAttemptForUpdate,
    pluginWorkloadSdkSpendOutcomeExists,
    promoteReservedOauthBrokerProviderAttempt,
  }
})

function reservedSdkAttempt(overrides: Record<string, unknown> = {}) {
  return {
    id: '44444444-4444-4444-8444-444444444444',
    invocationId: 'invocation-1',
    recipeNamespace: 'sandbox-recipes',
    recipeName: 'prompt-notify',
    attemptGeneration: 1,
    attemptIndex: 1,
    targetRef: 'codex-primary',
    provider: 'codex-subscription',
    model: 'gpt-5.1',
    credentialSlot: '',
    status: 'reserved',
    credentialJti: null,
    startedAt: new Date().toISOString(),
    leaseExpiresAt: null,
    completedAt: null,
    usageRequestId: null,
    ...overrides,
  }
}

const REQUEST = {
  schemaVersion: 'codex-completion-request.v1' as const,
  requestId: 'req-001',
  idempotencyKey: 'idem-001',
  provider: 'codex-subscription' as const,
  model: 'gpt-5.1',
  messages: [{ role: 'user' as const, content: 'hello' }],
}

function claims(overrides: Partial<McpHostAccessClaims> = {}): McpHostAccessClaims {
  return {
    sub: 'default/research-host',
    recipeNamespace: 'default',
    recipeName: 'research-host',
    hostRefs: ['research-host'],
    scope: 'workflow:approval:request',
    workflowControlScopes: ['llm:codex:execute'],
    iss: 'control-api',
    aud: 'workflow-approvals',
    jti: 'jti-1',
    exp: Math.floor(Date.now() / 1000) + 60,
    ...overrides,
  }
}

function connection(overrides: Record<string, unknown> = {}) {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    connectionKey: 'deployment-default',
    displayName: 'Default deployment',
    createdBy: null,
    status: 'connected',
    credentialRevision: 3,
    catalogRevision: 4,
    accountFingerprint: 'fp',
    catalogStatus: 'ready',
    catalogSyncedAt: new Date(),
    lastRefreshAt: null,
    lastAuthAt: new Date(),
    refreshLockHeld: false,
    revokedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }
}

function body(overrides: Record<string, unknown> = {}) {
  const policyHash = computeCodexPolicyHash({
    model: REQUEST.model,
    catalogRevision: 4,
    credentialRevision: 3,
  })
  return {
    request: REQUEST,
    invocationId: 'invocation-1',
    attemptGeneration: 1,
    providerAttemptIndex: 1,
    policyRevision: 4,
    policyHash,
    ...overrides,
  }
}

function deps(
  overrides: Partial<LlmProviderAttemptAuthorizerDeps> = {}
): LlmProviderAttemptAuthorizerDeps {
  const db = { query: vi.fn() }
  return {
    enabled: true,
    db,
    withTransaction: async work => work(db as never),
    getConnection: vi.fn().mockResolvedValue(connection()),
    getModelState: vi.fn().mockResolvedValue({ enabled: true, stale: false }),
    resolveConnectionKey: vi.fn().mockResolvedValue('deployment-default'),
    evaluateBudget: vi.fn().mockResolvedValue({ allowed: true, reservationIds: ['res-1'] }),
    getActiveReservation: vi.fn().mockResolvedValue({ id: 'res-1' }),
    getMaxGeneration: vi.fn().mockResolvedValue(0),
    insertAttempt: vi.fn().mockResolvedValue({
      id: '33333333-3333-4333-8333-333333333333',
      hostRef: 'research-host',
    }),
    issueTicket: vi.fn().mockResolvedValue({
      executionTicket: 'ticket.jwt',
      expiresAt: new Date('2026-08-20T12:00:00.000Z'),
      claims: { jti: 'jti-ticket' },
    }),
    ...overrides,
  }
}

describe('authorizeLlmProviderAttempt', () => {
  let current: LlmProviderAttemptAuthorizerDeps

  beforeEach(() => {
    current = deps()
    lockPluginWorkloadSdkRecipe.mockReset().mockResolvedValue(undefined)
    getPluginWorkloadSdkProviderAttemptForUpdate.mockReset()
    pluginWorkloadSdkSpendOutcomeExists.mockReset().mockResolvedValue(false)
    promoteReservedOauthBrokerProviderAttempt.mockReset().mockResolvedValue(true)
  })

  it('authorizes a bound attempt and returns a ticket without persisting messages', async () => {
    const result = await authorizeLlmProviderAttempt(claims(), body(), current)
    expect(result).toMatchObject({
      providerAttemptId: '33333333-3333-4333-8333-333333333333',
      executionTicket: 'ticket.jwt',
      requestHash: hashCodexCompletionRequestV1(REQUEST),
    })
    expect(current.evaluateBudget).toHaveBeenCalledWith(
      expect.objectContaining({
        task_ref: 'invocation-1:1:1',
        context_ref: null,
        team_id: null,
        user_id: null,
        source_kind: 'channel',
      }),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ requiredUnit: 'tokens' })
    )
    expect(current.insertAttempt).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        hostRef: 'research-host',
        model: 'gpt-5.1',
        requestHash: result.requestHash,
        budgetReservationId: 'res-1',
      })
    )
    const persisted = vi.mocked(current.insertAttempt).mock.calls[0]?.[1]
    expect(persisted).not.toHaveProperty('pluginWorkloadSdkProviderAttemptId')
    expect(JSON.stringify(persisted)).not.toContain('hello')
    expect(JSON.stringify(result)).not.toMatch(/sk-|refresh|Authorization/i)
  })

  it('uses claims.hostRefs[0] even when the body carries a different hostRef', async () => {
    await expect(
      authorizeLlmProviderAttempt(claims(), body({ hostRef: 'forged-host' }), current)
    ).rejects.toMatchObject({ code: 'host_binding_mismatch' })
    expect(current.insertAttempt).not.toHaveBeenCalled()
  })

  it('rejects a token without llm:codex:execute as insufficient_scope', async () => {
    await expect(
      authorizeLlmProviderAttempt(claims({ workflowControlScopes: [] }), body(), current)
    ).rejects.toMatchObject({ code: 'insufficient_scope' })
  })

  it('rejects a missing hostRefs[0] binding', async () => {
    await expect(
      authorizeLlmProviderAttempt(claims({ hostRefs: [] }), body(), {
        ...current,
        enabled: true,
      })
    ).rejects.toBeInstanceOf(LlmProviderAttemptAuthorizeError)
  })

  it('rejects unknown fields', async () => {
    await expect(
      authorizeLlmProviderAttempt(claims(), body({ extra: true }), current)
    ).rejects.toMatchObject({ code: 'unknown_field' })
  })

  it('rejects a non-UUID Plugin Workload SDK attempt id', async () => {
    await expect(
      authorizeLlmProviderAttempt(
        claims(),
        body({ pluginWorkloadSdkProviderAttemptId: 'not-a-uuid' }),
        current
      )
    ).rejects.toMatchObject({ code: 'invalid_request' })
    expect(current.insertAttempt).not.toHaveBeenCalled()
  })

  it('does not take the recipe advisory lock for a recipe caller without an SDK attempt link', async () => {
    // R4-M3. Only an SDK-linked authorize goes on to take plugin_workload_sdk_*
    // rows FOR UPDATE, which is the order finalize follows after this advisory.
    // Taking it for every recipe caller serialized the workflow lane per recipe
    // for no ordering benefit.
    await authorizeLlmProviderAttempt(
      claims({
        recipeNamespace: 'sandbox-recipes',
        recipeName: 'prompt-notify',
        hostRefs: ['sandbox-recipes/prompt-notify'],
      }),
      body(),
      current
    )
    expect(lockPluginWorkloadSdkRecipe).not.toHaveBeenCalled()
  })

  it('binds a reserved Plugin Workload SDK attempt onto the Codex ledger row', async () => {
    const sdkAttemptId = '44444444-4444-4444-8444-444444444444'
    getPluginWorkloadSdkProviderAttemptForUpdate.mockResolvedValue(
      reservedSdkAttempt({ id: sdkAttemptId })
    )
    await authorizeLlmProviderAttempt(
      claims({
        recipeNamespace: 'sandbox-recipes',
        recipeName: 'prompt-notify',
        hostRefs: ['sandbox-recipes/prompt-notify'],
      }),
      body({ pluginWorkloadSdkProviderAttemptId: sdkAttemptId, targetRef: 'codex-primary' }),
      current
    )
    expect(lockPluginWorkloadSdkRecipe).toHaveBeenCalledWith(
      expect.anything(),
      'sandbox-recipes',
      'prompt-notify'
    )
    expect(getPluginWorkloadSdkProviderAttemptForUpdate).toHaveBeenCalledWith(
      sdkAttemptId,
      expect.anything()
    )
    expect(current.insertAttempt).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        pluginWorkloadSdkProviderAttemptId: sdkAttemptId,
        callerKind: 'recipe',
        hostRef: 'sandbox-recipes/prompt-notify',
      })
    )
    expect(promoteReservedOauthBrokerProviderAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        id: sdkAttemptId,
        model: 'gpt-5.1',
        targetRef: 'codex-primary',
      }),
      expect.anything()
    )
    expect(promoteReservedOauthBrokerProviderAttempt.mock.invocationCallOrder[0]).toBeGreaterThan(
      current.insertAttempt.mock.invocationCallOrder[0]!
    )
    expect(lockPluginWorkloadSdkRecipe.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(current.evaluateBudget).mock.invocationCallOrder[0]!
    )
  })

  it('rejects a Plugin Workload SDK attempt that does not match the reserved receipt', async () => {
    getPluginWorkloadSdkProviderAttemptForUpdate.mockResolvedValue(null)
    await expect(
      authorizeLlmProviderAttempt(
        claims({
          recipeNamespace: 'sandbox-recipes',
          recipeName: 'prompt-notify',
          hostRefs: ['sandbox-recipes/prompt-notify'],
        }),
        body({ pluginWorkloadSdkProviderAttemptId: '44444444-4444-4444-8444-444444444444' }),
        current
      )
    ).rejects.toMatchObject({ code: 'no_grant' })
    expect(current.insertAttempt).not.toHaveBeenCalled()
    expect(promoteReservedOauthBrokerProviderAttempt).not.toHaveBeenCalled()
  })

  it('rejects a reserved SDK attempt whose model does not match the Codex request', async () => {
    getPluginWorkloadSdkProviderAttemptForUpdate.mockResolvedValue(
      reservedSdkAttempt({ model: 'gpt-5.4-mini' })
    )
    await expect(
      authorizeLlmProviderAttempt(
        claims({
          recipeNamespace: 'sandbox-recipes',
          recipeName: 'prompt-notify',
          hostRefs: ['sandbox-recipes/prompt-notify'],
        }),
        body({ pluginWorkloadSdkProviderAttemptId: reservedSdkAttempt().id }),
        current
      )
    ).rejects.toMatchObject({ code: 'no_grant' })
    expect(current.insertAttempt).not.toHaveBeenCalled()
  })

  it('rejects a reserved SDK attempt whose targetRef does not match the authorize body', async () => {
    getPluginWorkloadSdkProviderAttemptForUpdate.mockResolvedValue(reservedSdkAttempt())
    await expect(
      authorizeLlmProviderAttempt(
        claims({
          recipeNamespace: 'sandbox-recipes',
          recipeName: 'prompt-notify',
          hostRefs: ['sandbox-recipes/prompt-notify'],
        }),
        body({
          pluginWorkloadSdkProviderAttemptId: reservedSdkAttempt().id,
          targetRef: 'other-target',
        }),
        current
      )
    ).rejects.toMatchObject({ code: 'no_grant' })
    expect(current.insertAttempt).not.toHaveBeenCalled()
  })

  it('rejects a host caller that presents a Plugin Workload SDK attempt id', async () => {
    await expect(
      authorizeLlmProviderAttempt(
        claims(),
        body({ pluginWorkloadSdkProviderAttemptId: reservedSdkAttempt().id }),
        current
      )
    ).rejects.toMatchObject({ code: 'no_grant' })
    expect(getPluginWorkloadSdkProviderAttemptForUpdate).not.toHaveBeenCalled()
    expect(current.insertAttempt).not.toHaveBeenCalled()
  })

  it('rejects linking after a spend outcome already exists', async () => {
    getPluginWorkloadSdkProviderAttemptForUpdate.mockResolvedValue(reservedSdkAttempt())
    pluginWorkloadSdkSpendOutcomeExists.mockResolvedValue(true)
    await expect(
      authorizeLlmProviderAttempt(
        claims({
          recipeNamespace: 'sandbox-recipes',
          recipeName: 'prompt-notify',
          hostRefs: ['sandbox-recipes/prompt-notify'],
        }),
        body({ pluginWorkloadSdkProviderAttemptId: reservedSdkAttempt().id }),
        current
      )
    ).rejects.toMatchObject({ code: 'no_grant' })
    expect(current.insertAttempt).not.toHaveBeenCalled()
  })

  it('rejects a stale requestHash', async () => {
    await expect(
      authorizeLlmProviderAttempt(claims(), body({ requestHash: 'a'.repeat(64) }), current)
    ).rejects.toMatchObject({ code: 'invalid_request' })
  })

  it('rejects disconnected catalogs as connection_unavailable', async () => {
    vi.mocked(current.getConnection).mockResolvedValueOnce(
      connection({ status: 'disconnected' }) as never
    )
    await expect(authorizeLlmProviderAttempt(claims(), body(), current)).rejects.toMatchObject({
      code: 'connection_unavailable',
    })
  })

  it('rejects reauth and revoked grants as no_grant', async () => {
    vi.mocked(current.getConnection).mockResolvedValueOnce(
      connection({ status: 'reauth_required' }) as never
    )
    await expect(authorizeLlmProviderAttempt(claims(), body(), current)).rejects.toMatchObject({
      code: 'no_grant',
    })
    vi.mocked(current.getConnection).mockResolvedValueOnce(
      connection({ status: 'revoked', revokedAt: new Date() }) as never
    )
    await expect(authorizeLlmProviderAttempt(claims(), body(), current)).rejects.toMatchObject({
      code: 'no_grant',
    })
    vi.mocked(current.getConnection).mockResolvedValueOnce(null)
    await expect(authorizeLlmProviderAttempt(claims(), body(), current)).rejects.toMatchObject({
      code: 'no_grant',
    })
  })

  it('rejects a disabled or stale Codex model as model_not_allowed', async () => {
    vi.mocked(current.getModelState).mockResolvedValueOnce({ enabled: false, stale: false })
    await expect(authorizeLlmProviderAttempt(claims(), body(), current)).rejects.toMatchObject({
      code: 'model_not_allowed',
    })
    vi.mocked(current.getModelState).mockResolvedValueOnce({ enabled: true, stale: true })
    await expect(authorizeLlmProviderAttempt(claims(), body(), current)).rejects.toMatchObject({
      code: 'model_not_allowed',
    })
  })

  it('rejects an old policy revision/hash as no_grant', async () => {
    await expect(
      authorizeLlmProviderAttempt(claims(), body({ policyRevision: 1 }), current)
    ).rejects.toMatchObject({ code: 'no_grant' })
  })

  it('rejects a cost-unit budget as budget_denied', async () => {
    vi.mocked(current.evaluateBudget).mockResolvedValueOnce({
      allowed: false,
      reason: 'cost_unit_rejected',
    })
    await expect(authorizeLlmProviderAttempt(claims(), body(), current)).rejects.toMatchObject({
      code: 'budget_denied',
    })
  })

  it('reuses an active presented reservation instead of reserving again', async () => {
    await authorizeLlmProviderAttempt(
      claims(),
      body({ budgetReservationId: 'res-already-held' }),
      current
    )
    expect(current.evaluateBudget).not.toHaveBeenCalled()
    expect(current.getActiveReservation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ reservationId: 'res-already-held', hostRef: 'research-host' })
    )
    expect(current.insertAttempt).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ budgetReservationId: 'res-already-held' })
    )
  })

  it('rejects an expired presented reservation as budget_denied', async () => {
    vi.mocked(current.getActiveReservation).mockResolvedValueOnce(null)
    await expect(
      authorizeLlmProviderAttempt(claims(), body({ budgetReservationId: 'stale-res' }), current)
    ).rejects.toMatchObject({ code: 'budget_denied' })
  })

  it('rejects an older invocation generation', async () => {
    vi.mocked(current.getMaxGeneration).mockResolvedValueOnce(3)
    await expect(authorizeLlmProviderAttempt(claims(), body(), current)).rejects.toMatchObject({
      code: 'stale_generation',
    })
  })

  it('rejects a non-Codex provider as model_not_allowed', async () => {
    await expect(
      authorizeLlmProviderAttempt(
        claims(),
        body({
          request: { ...REQUEST, provider: 'openai' },
        }),
        current
      )
    ).rejects.toMatchObject({ code: 'invalid_request' })
  })

  it('rejects an unassigned Host connectionRef as unassigned_connection', async () => {
    await expect(
      authorizeLlmProviderAttempt(claims(), body(), {
        ...current,
        resolveConnectionKey: async () => 'unassigned',
      })
    ).rejects.toMatchObject({ code: 'unassigned_connection' })
    expect(current.getConnection).not.toHaveBeenCalled()
    expect(current.insertAttempt).not.toHaveBeenCalled()
  })

  it('fails closed for every Host on a revoked grant and leaves another grant usable', async () => {
    const teamPlus = connection({
      id: '22222222-2222-4222-8222-222222222222',
      connectionKey: 'team-plus',
      status: 'revoked',
      revokedAt: new Date(),
      credentialRevision: 8,
    })
    const personal = connection({
      id: '33333333-3333-4333-8333-333333333333',
      connectionKey: 'personal-pro',
    })
    const getConnection = vi.fn(async (_db: unknown, key: string) => {
      if (key === 'team-plus') return teamPlus
      if (key === 'personal-pro') return personal
      return null
    })
    const resolveConnectionKey = vi.fn(async (hostRef: string) =>
      hostRef === 'agent-c' ? 'personal-pro' : 'team-plus'
    )
    const shared = deps({
      getConnection: getConnection as never,
      resolveConnectionKey,
    })

    await expect(
      authorizeLlmProviderAttempt(claims({ hostRefs: ['agent-a'] }), body(), shared)
    ).rejects.toMatchObject({ code: 'no_grant' })
    await expect(
      authorizeLlmProviderAttempt(claims({ hostRefs: ['agent-b'] }), body(), shared)
    ).rejects.toMatchObject({ code: 'no_grant' })

    const live = await authorizeLlmProviderAttempt(
      claims({ hostRefs: ['agent-c'] }),
      body({
        policyHash: computeCodexPolicyHash({
          model: REQUEST.model,
          catalogRevision: 4,
          credentialRevision: 3,
          connectionKey: 'personal-pro',
        }),
      }),
      shared
    )
    expect(live.executionTicket).toBe('ticket.jwt')
    expect(resolveConnectionKey).toHaveBeenCalledWith('agent-a')
    expect(resolveConnectionKey).toHaveBeenCalledWith('agent-b')
    expect(resolveConnectionKey).toHaveBeenCalledWith('agent-c')
  })

  it('evaluates budget with a null user_id even when claims.sub is present', async () => {
    const result = await authorizeLlmProviderAttempt(
      claims({ sub: 'default/research-host' }),
      body({ userId: 'default/research-host' }),
      current
    )
    expect(result.executionTicket).toBe('ticket.jwt')
    expect(current.evaluateBudget).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: null,
        source_kind: 'channel',
        host_ref: 'research-host',
      }),
      expect.anything(),
      expect.anything(),
      expect.anything()
    )
    const budgetInput = vi.mocked(current.evaluateBudget).mock.calls[0]?.[0] as {
      user_id: unknown
    }
    expect(budgetInput.user_id).not.toBe('default/research-host')
  })

  it('uses source_kind=channel for recipe callers and never feeds claims.sub to the budget', async () => {
    await authorizeLlmProviderAttempt(
      claims({
        sub: 'sandbox-recipes/research-host',
        recipeNamespace: 'sandbox-recipes',
        recipeName: 'research-host',
        hostRefs: ['sandbox-recipes/research-host'],
      }),
      body(),
      current
    )
    expect(current.evaluateBudget).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: null,
        source_kind: 'channel',
        host_ref: 'sandbox-recipes/research-host',
        recipe_name: 'research-host',
      }),
      expect.anything(),
      expect.anything(),
      expect.anything()
    )
  })

  it('is disabled when the feature flag is off', async () => {
    await expect(
      authorizeLlmProviderAttempt(claims(), body(), { ...current, enabled: false })
    ).rejects.toMatchObject({ code: 'disabled' })
    expect(current.insertAttempt).not.toHaveBeenCalled()
  })
})
