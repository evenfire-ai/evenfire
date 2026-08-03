import { beforeEach, describe, expect, it, vi } from 'vitest'
import jwt from 'jsonwebtoken'
import {
  authorizeClientNotification,
  authorizeListRecipients,
  authorizePromptBridge,
  reissuePromptBridgeCredentialTicket,
} from '../src/services/pluginWorkloadSdkAuthorizer.js'
import * as sdkDb from '../src/services/pluginWorkloadSdkDb.js'
import type { McpHostAccessClaims } from '../src/utils/auth/mcpHostJwtToken.js'

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
    findGrant: vi.fn(),
    insertInvocation: vi.fn(),
    reviveFailedInvocation: vi.fn(),
    updateInvocationStatus: vi.fn(),
    consumePeriodQuota: vi.fn(),
    countRecentInvocations: vi.fn(),
    getInvocationById: vi.fn(),
    getPluginWorkloadSdkAttemptReceipt: vi.fn(),
    reservePluginWorkloadSdkProviderAttempt: vi.fn(),
    markPluginWorkloadSdkProviderAttemptStatus: vi.fn(),
    registerPluginWorkloadSdkCredentialTicketJti: vi.fn(),
  }
})

const NS = 'sandbox-recipes'
const RECIPE = 'sdk-recipe'

function claims(scopes: string[] = ['plugin-workload-sdk']): McpHostAccessClaims {
  return {
    sub: `${NS}/${RECIPE}`,
    recipeNamespace: NS,
    recipeName: RECIPE,
    hostRefs: [`${NS}/${RECIPE}`],
    scope: 'workflow:approval:request',
    workflowControlScopes: scopes as McpHostAccessClaims['workflowControlScopes'],
    iss: 'control-api',
    aud: 'workflow-approvals',
    jti: 'test-jti',
    exp: Math.floor(Date.now() / 1000) + 300,
  }
}

function grant(
  overrides: Partial<sdkDb.PluginWorkloadSdkGrant> = {}
): sdkDb.PluginWorkloadSdkGrant {
  return {
    id: 'grant-1',
    recipeNamespace: NS,
    recipeName: RECIPE,
    capabilityFamily: 'promptBridge',
    provider: 'zai',
    allowedModels: ['glm-4.7'],
    allowedEventTypes: [],
    allowedTargetRefs: [],
    allowedUserRefs: [],
    allowedCallers: ['api'],
    quotaLimits: {},
    modelPolicies: {},
    promptTargets: [
      {
        targetRef: 'primary-zai',
        provider: 'zai',
        model: 'glm-4.7',
        credentialSlot: 'zai-api-key',
      },
    ],
    defaultTargetRef: 'primary-zai',
    policyState: 'active',
    policyRevision: 1,
    createdAt: '2026-06-09T00:00:00.000Z',
    updatedAt: '2026-06-09T00:00:00.000Z',
    ...overrides,
  }
}

function invocation(
  overrides: Partial<sdkDb.PluginWorkloadSdkInvocationRecord> = {}
): sdkDb.PluginWorkloadSdkInvocationRecord {
  return {
    id: 'inv-1',
    recipeNamespace: NS,
    recipeName: RECIPE,
    callerRef: 'api',
    correlationId: null,
    method: 'promptBridge',
    detail: 'glm-4.7',
    purpose: 'summarization',
    idempotencyKeyHash: 'hash',
    payloadHash: 'payload-hash',
    status: 'in_progress',
    quotaConsumed: true,
    authorizationDecision: 'authorized',
    contractVersion: 2,
    attemptGeneration: 1,
    leaseExpiresAt: null,
    updatedAt: '2026-06-09T00:00:00.000Z',
    createdAt: '2026-06-09T00:00:00.000Z',
    completedAt: null,
    promptAuthorization: null,
    ...overrides,
  }
}

const basePromptParams = {
  callerRef: 'api',
  model: 'glm-4.7',
  purpose: 'summarization',
  idempotencyKey: 'key-1',
  payload: { messages: [{ role: 'user', content: 'hi' }] },
}

const baseNotificationParams = {
  callerRef: 'api',
  eventType: 'lead.followup.due',
  targetRef: 'team.sales',
  idempotencyKey: 'key-2',
  payload: { eventType: 'lead.followup.due' },
}

beforeEach(() => {
  vi.mocked(sdkDb.findGrant).mockReset()
  vi.mocked(sdkDb.insertInvocation).mockReset()
  vi.mocked(sdkDb.reviveFailedInvocation).mockReset()
  vi.mocked(sdkDb.updateInvocationStatus).mockReset()
  vi.mocked(sdkDb.consumePeriodQuota).mockReset()
  vi.mocked(sdkDb.countRecentInvocations).mockReset()
  vi.mocked(sdkDb.getInvocationById).mockReset()
  vi.mocked(sdkDb.getPluginWorkloadSdkAttemptReceipt).mockReset()
  vi.mocked(sdkDb.reservePluginWorkloadSdkProviderAttempt).mockReset()
  vi.mocked(sdkDb.markPluginWorkloadSdkProviderAttemptStatus).mockReset()
  vi.mocked(sdkDb.registerPluginWorkloadSdkCredentialTicketJti).mockReset()
  vi.mocked(sdkDb.countRecentInvocations).mockResolvedValue(0)
  vi.mocked(sdkDb.consumePeriodQuota).mockResolvedValue(true)
  vi.mocked(sdkDb.registerPluginWorkloadSdkCredentialTicketJti).mockResolvedValue(true)
  vi.mocked(sdkDb.getPluginWorkloadSdkAttemptReceipt).mockResolvedValue({
    invocationId: 'inv-1',
    recipeNamespace: NS,
    recipeName: RECIPE,
    attemptGeneration: 1,
    method: 'promptBridge',
    targetRefs: ['primary-zai', 'openai-fallback'],
    policyRevision: 1,
    policyHash: 'a'.repeat(64),
    status: 'in_progress',
    startedAt: '2026-06-09T00:00:00.000Z',
    leaseExpiresAt: '2026-06-09T00:01:00.000Z',
    completedAt: null,
  })
  vi.mocked(sdkDb.reservePluginWorkloadSdkProviderAttempt).mockResolvedValue({
    id: '33333333-3333-4333-8333-333333333333',
    invocationId: 'inv-1',
    recipeNamespace: NS,
    recipeName: RECIPE,
    attemptGeneration: 1,
    attemptIndex: 1,
    targetRef: 'openai-fallback',
    provider: 'openai',
    model: 'gpt-5.4',
    credentialSlot: 'openai-api-key',
    status: 'reserved',
    credentialJti: null,
    startedAt: '2026-06-09T00:00:00.000Z',
    leaseExpiresAt: '2026-06-09T00:01:00.000Z',
    completedAt: null,
    usageRequestId: null,
  })
  vi.mocked(sdkDb.markPluginWorkloadSdkProviderAttemptStatus).mockResolvedValue(true)
  vi.mocked(sdkDb.insertInvocation).mockResolvedValue({
    kind: 'inserted',
    invocation: invocation(),
  })
  vi.mocked(sdkDb.reviveFailedInvocation).mockResolvedValue(2)
})

describe('authorizePromptBridge', () => {
  it('returns scope_denied when the JWT lacks the plugin-workload-sdk scope', async () => {
    const result = await authorizePromptBridge({ claims: claims([]), ...basePromptParams })
    expect(result).toMatchObject({ ok: false, error: 'scope_denied' })
    expect(sdkDb.findGrant).not.toHaveBeenCalled()
  })

  it('returns capability_not_declared when no grant exists', async () => {
    vi.mocked(sdkDb.findGrant).mockResolvedValue(null)
    const result = await authorizePromptBridge({ claims: claims(), ...basePromptParams })
    expect(result).toMatchObject({ ok: false, error: 'capability_not_declared' })
  })

  it('returns caller_not_allowed when allowedCallers is empty', async () => {
    vi.mocked(sdkDb.findGrant).mockResolvedValue(grant({ allowedCallers: [] }))
    const result = await authorizePromptBridge({ claims: claims(), ...basePromptParams })
    expect(result).toMatchObject({ ok: false, error: 'caller_not_allowed' })
  })

  it('returns caller_not_allowed when allowedCallers excludes the caller', async () => {
    vi.mocked(sdkDb.findGrant).mockResolvedValue(grant({ allowedCallers: ['worker'] }))
    const result = await authorizePromptBridge({ claims: claims(), ...basePromptParams })
    expect(result).toMatchObject({ ok: false, error: 'caller_not_allowed' })
  })

  it('returns target_not_allowed for a model outside the ordered policy', async () => {
    vi.mocked(sdkDb.findGrant).mockResolvedValue(grant({ allowedModels: ['glm-4.7'] }))
    const result = await authorizePromptBridge({
      claims: claims(),
      ...basePromptParams,
      model: 'gpt-4o',
    })
    expect(result).toMatchObject({ ok: false, error: 'target_not_allowed' })
  })

  it('fails closed when a legacy promptBridge grant has no ordered policy', async () => {
    vi.mocked(sdkDb.findGrant).mockResolvedValue(
      grant({ promptTargets: [], defaultTargetRef: null, policyRevision: 0 })
    )
    const result = await authorizePromptBridge({ claims: claims(), ...basePromptParams })
    expect(result).toMatchObject({ ok: false, error: 'provider_policy_denied' })
    expect(sdkDb.insertInvocation).not.toHaveBeenCalled()
  })

  it('uses the ordered default when the request omits a selector', async () => {
    const paramsWithoutModel = {
      callerRef: basePromptParams.callerRef,
      purpose: basePromptParams.purpose,
      idempotencyKey: basePromptParams.idempotencyKey,
      payload: basePromptParams.payload,
    }
    vi.mocked(sdkDb.findGrant).mockResolvedValue(grant())
    const result = await authorizePromptBridge({ claims: claims(), ...paramsWithoutModel })
    expect(result).toMatchObject({
      ok: true,
      value: { selectedTarget: { targetRef: 'primary-zai', model: 'glm-4.7' } },
    })
  })

  it('returns an explicit approved target and only its fallback suffix', async () => {
    vi.mocked(sdkDb.findGrant).mockResolvedValue(
      grant({
        promptTargets: [
          {
            targetRef: 'zai-primary',
            provider: 'zai',
            model: 'glm-4.7',
            credentialSlot: 'zai-api-key',
          },
          {
            targetRef: 'openai-fallback',
            provider: 'openai',
            model: 'gpt-5.4',
            credentialSlot: 'openai-api-key',
          },
        ],
        defaultTargetRef: 'zai-primary',
      })
    )
    const result = await authorizePromptBridge({
      claims: claims(),
      callerRef: basePromptParams.callerRef,
      purpose: basePromptParams.purpose,
      idempotencyKey: basePromptParams.idempotencyKey,
      payload: basePromptParams.payload,
      targetRef: 'openai-fallback',
    })
    expect(result).toMatchObject({
      ok: true,
      value: {
        selectedTarget: { targetRef: 'openai-fallback', provider: 'openai' },
        authorizedTargets: [{ targetRef: 'openai-fallback' }],
        policyRevision: 1,
      },
    })
  })

  it('returns only the ordered policy and defers credential tickets to each attempt', async () => {
    vi.mocked(sdkDb.findGrant).mockResolvedValue(
      grant({
        promptTargets: [
          {
            targetRef: 'zai-primary',
            provider: 'zai',
            model: 'glm-4.7',
            credentialSlot: 'zai-api-key',
          },
          {
            targetRef: 'openai-fallback',
            provider: 'openai',
            model: 'gpt-5.4',
            credentialSlot: 'openai-api-key',
          },
        ],
        defaultTargetRef: 'zai-primary',
      })
    )

    const result = await authorizePromptBridge({ claims: claims(), ...basePromptParams })
    expect(result).toMatchObject({ ok: true })
    if (!result.ok) return
    expect(result.value.authorizedTargets).toHaveLength(2)
    expect(result.value).not.toHaveProperty('authorizedTargetTickets')
    expect(sdkDb.registerPluginWorkloadSdkCredentialTicketJti).not.toHaveBeenCalled()
  })

  it('caps the authorized provider suffix even when the grant lists many targets', async () => {
    const targets = [
      ['primary-zai', 'zai', 'glm-4.7', 'zai-api-key'],
      ['fallback-openai', 'openai', 'gpt-5.4', 'openai-api-key'],
      ['fallback-claude', 'claude', 'claude-sonnet-4-6', 'claude-api-key'],
      ['fallback-gemini', 'gemini', 'gemini-2.5-pro', 'gemini-api-key'],
      ['fallback-groq', 'groq', 'llama-3.3-70b', 'groq-api-key'],
      ['fallback-mistral', 'mistral', 'mistral-large', 'mistral-api-key'],
    ].map(([targetRef, provider, model, credentialSlot]) => ({
      targetRef,
      provider,
      model,
      credentialSlot,
    }))
    vi.mocked(sdkDb.findGrant).mockResolvedValue(
      grant({ promptTargets: targets, defaultTargetRef: 'primary-zai' })
    )
    const result = await authorizePromptBridge({ claims: claims(), ...basePromptParams })
    expect(result).toMatchObject({ ok: true })
    if (!result.ok) return
    expect(result.value.authorizedTargets.map(target => target.targetRef)).toEqual([
      'primary-zai',
      'fallback-openai',
      'fallback-claude',
      'fallback-gemini',
    ])
  })

  it('rejects a bare model shared by two authorized providers before recording an invocation', async () => {
    vi.mocked(sdkDb.findGrant).mockResolvedValue(
      grant({
        promptTargets: [
          {
            targetRef: 'zai-primary',
            provider: 'zai',
            model: 'shared',
            credentialSlot: 'zai-api-key',
          },
          {
            targetRef: 'openai-fallback',
            provider: 'openai',
            model: 'shared',
            credentialSlot: 'openai-api-key',
          },
        ],
        defaultTargetRef: 'zai-primary',
      })
    )
    const result = await authorizePromptBridge({
      claims: claims(),
      ...basePromptParams,
      model: 'shared',
    })
    expect(result).toMatchObject({ ok: false, error: 'ambiguous_model' })
    expect(sdkDb.insertInvocation).not.toHaveBeenCalled()
  })

  it('does not treat a legacy wildcard allowedModels entry as routing authority', async () => {
    vi.mocked(sdkDb.findGrant).mockResolvedValue(grant({ allowedModels: ['*'] }))
    const result = await authorizePromptBridge({
      claims: claims(),
      ...basePromptParams,
      model: 'gpt-4o',
    })
    expect(result).toMatchObject({ ok: false, error: 'target_not_allowed' })
  })

  it('returns provider_policy_denied for an unresolvable modelPolicyRef', async () => {
    vi.mocked(sdkDb.findGrant).mockResolvedValue(grant())
    const result = await authorizePromptBridge({
      claims: claims(),
      ...basePromptParams,
      modelPolicyRef: 'missing-policy',
    })
    expect(result).toMatchObject({ ok: false, error: 'provider_policy_denied' })
  })

  it('rejects bootstrap/default drift before recording an invocation', async () => {
    vi.mocked(sdkDb.findGrant).mockResolvedValue(grant())
    const result = await authorizePromptBridge({
      claims: claims(),
      ...basePromptParams,
      bootstrapProvider: 'openai',
      bootstrapModel: 'gpt-5.4-mini',
    })
    expect(result).toMatchObject({ ok: false, error: 'provider_policy_denied' })
    expect((result as { ok: false; message: string }).message).toContain('bootstrap binding')
    expect(sdkDb.insertInvocation).not.toHaveBeenCalled()
  })

  it('denies a request model that does not match the referenced model policy', async () => {
    vi.mocked(sdkDb.findGrant).mockResolvedValue(
      grant({
        allowedModels: ['glm-4.7', 'glm-5.1'],
        modelPolicies: { 'support-summary-v1': { provider: 'zai', model: 'glm-4.7' } },
      })
    )
    const result = await authorizePromptBridge({
      claims: claims(),
      ...basePromptParams,
      model: 'glm-5.1',
      modelPolicyRef: 'support-summary-v1',
    })
    expect(result).toMatchObject({ ok: false, error: 'provider_policy_denied' })
    expect(sdkDb.insertInvocation).not.toHaveBeenCalled()
  })

  it('resolves a modelPolicyRef to its concrete record', async () => {
    const paramsWithoutModel = {
      callerRef: basePromptParams.callerRef,
      purpose: basePromptParams.purpose,
      idempotencyKey: basePromptParams.idempotencyKey,
      payload: basePromptParams.payload,
    }
    vi.mocked(sdkDb.findGrant).mockResolvedValue(
      grant({
        modelPolicies: { 'support-summary-v1': { provider: 'zai', model: 'glm-4.7' } },
      })
    )
    const result = await authorizePromptBridge({
      claims: claims(),
      ...paramsWithoutModel,
      modelPolicyRef: 'support-summary-v1',
    })
    expect(result).toMatchObject({
      ok: true,
      value: { model: 'glm-4.7', modelPolicy: { provider: 'zai', model: 'glm-4.7' } },
    })
  })

  it('rejects inconsistent targetRef and modelPolicyRef before recording an invocation', async () => {
    vi.mocked(sdkDb.findGrant).mockResolvedValue(
      grant({
        modelPolicies: { 'support-summary-v1': { provider: 'zai', model: 'glm-4.7' } },
        promptTargets: [
          {
            targetRef: 'zai-primary',
            provider: 'zai',
            model: 'glm-4.7',
            credentialSlot: 'zai-api-key',
          },
          {
            targetRef: 'openai-fallback',
            provider: 'openai',
            model: 'gpt-5.4',
            credentialSlot: 'openai-api-key',
          },
        ],
        defaultTargetRef: 'zai-primary',
      })
    )
    const result = await authorizePromptBridge({
      claims: claims(),
      ...basePromptParams,
      targetRef: 'openai-fallback',
      modelPolicyRef: 'support-summary-v1',
    })
    expect(result).toMatchObject({ ok: false, error: 'provider_policy_denied' })
    expect(sdkDb.insertInvocation).not.toHaveBeenCalled()
  })

  it('accepts targetRef and modelPolicyRef only when they resolve to the same target', async () => {
    vi.mocked(sdkDb.findGrant).mockResolvedValue(
      grant({
        modelPolicies: { 'support-summary-v1': { provider: 'zai', model: 'glm-4.7' } },
      })
    )
    const result = await authorizePromptBridge({
      claims: claims(),
      ...basePromptParams,
      targetRef: 'primary-zai',
      modelPolicyRef: 'support-summary-v1',
    })
    expect(result).toMatchObject({
      ok: true,
      value: { selectedTarget: { targetRef: 'primary-zai' } },
    })
  })

  it('returns quota_exceeded when the per-minute rate limit is exceeded', async () => {
    vi.mocked(sdkDb.findGrant).mockResolvedValue(
      grant({ quotaLimits: { maxInvocationsPerMinute: 5 } })
    )
    // recent count INCLUDES the just-recorded current invocation, so the window
    // is over the limit only at 6 (5 prior succeeded + this one).
    vi.mocked(sdkDb.countRecentInvocations).mockResolvedValue(6)
    const result = await authorizePromptBridge({ claims: claims(), ...basePromptParams })
    expect(result).toMatchObject({ ok: false, error: 'quota_exceeded', retryable: false })
    expect(sdkDb.insertInvocation).toHaveBeenCalledOnce()
    expect(sdkDb.updateInvocationStatus).toHaveBeenCalledWith(
      'inv-1',
      'failed',
      expect.objectContaining({
        completed: true,
        recipeNamespace: NS,
        recipeName: RECIPE,
        expectedAttemptGeneration: 1,
      })
    )
  })

  it('allows exactly maxInvocationsPerMinute calls (the limit-th call is not self-rejected)', async () => {
    vi.mocked(sdkDb.findGrant).mockResolvedValue(
      grant({ quotaLimits: { maxInvocationsPerMinute: 5 } })
    )
    // The limit-th call: 4 prior + this one = 5, which is within the limit of 5.
    // Pre-fix (`recent >= limit`) this would have been rejected (effective N-1).
    vi.mocked(sdkDb.countRecentInvocations).mockResolvedValue(5)
    const result = await authorizePromptBridge({ claims: claims(), ...basePromptParams })
    expect(result).toMatchObject({ ok: true })
  })

  it('returns idempotent replay without re-checking the per-minute rate limit', async () => {
    vi.mocked(sdkDb.findGrant).mockResolvedValue(
      grant({ quotaLimits: { maxInvocationsPerMinute: 5 } })
    )
    vi.mocked(sdkDb.countRecentInvocations).mockResolvedValue(5)
    vi.mocked(sdkDb.insertInvocation).mockResolvedValue({
      kind: 'replay',
      invocation: invocation({ status: 'complete' }),
    })
    const result = await authorizePromptBridge({ claims: claims(), ...basePromptParams })
    expect(result).toMatchObject({
      ok: true,
      value: { invocationId: 'inv-1', replay: true, status: 'complete' },
    })
    expect(sdkDb.countRecentInvocations).not.toHaveBeenCalled()
    expect(sdkDb.consumePeriodQuota).not.toHaveBeenCalled()
  })

  it('marks the invocation failed when period quota is exceeded', async () => {
    vi.mocked(sdkDb.findGrant).mockResolvedValue(grant({ quotaLimits: { maxRequestsPerRun: 3 } }))
    vi.mocked(sdkDb.consumePeriodQuota).mockResolvedValue(false)
    const result = await authorizePromptBridge({ claims: claims(), ...basePromptParams })
    expect(result).toMatchObject({ ok: false, error: 'quota_exceeded' })
    expect(sdkDb.updateInvocationStatus).toHaveBeenCalledWith(
      'inv-1',
      'failed',
      expect.objectContaining({
        completed: true,
        recipeNamespace: NS,
        recipeName: RECIPE,
        expectedAttemptGeneration: 1,
      })
    )
  })

  it('authorizes a valid request and records the invocation', async () => {
    vi.mocked(sdkDb.findGrant).mockResolvedValue(
      grant({ quotaLimits: { maxOutputTokens: 2048, maxRequestsPerRun: 10 } })
    )
    const result = await authorizePromptBridge({
      claims: claims(),
      ...basePromptParams,
      model: 'glm-4.7',
    })
    expect(result).toMatchObject({
      ok: true,
      value: { invocationId: 'inv-1', replay: false, maxOutputTokens: 2048 },
    })
    expect(sdkDb.insertInvocation).toHaveBeenCalledOnce()
    expect(sdkDb.consumePeriodQuota).toHaveBeenCalledOnce()
  })

  it('authorizes an explicitly approved non-default model', async () => {
    vi.mocked(sdkDb.findGrant).mockResolvedValue(
      grant({
        promptTargets: [
          {
            targetRef: 'zai-glm-5-1',
            provider: 'zai',
            model: 'glm-5.1',
            credentialSlot: 'zai-api-key',
          },
        ],
        defaultTargetRef: 'zai-glm-5-1',
        quotaLimits: { maxRequestsPerRun: 10 },
      })
    )
    const result = await authorizePromptBridge({
      claims: claims(),
      ...basePromptParams,
      model: 'glm-5.1',
    })
    expect(result).toMatchObject({
      ok: true,
      value: { model: 'glm-5.1' },
    })
    expect(sdkDb.insertInvocation).toHaveBeenCalledOnce()
  })

  it('returns the existing invocation on idempotent replay without re-consuming quota', async () => {
    vi.mocked(sdkDb.findGrant).mockResolvedValue(grant({ quotaLimits: { maxRequestsPerRun: 10 } }))
    vi.mocked(sdkDb.insertInvocation).mockResolvedValue({
      kind: 'replay',
      invocation: invocation({ status: 'complete' }),
    })
    const result = await authorizePromptBridge({ claims: claims(), ...basePromptParams })
    expect(result).toMatchObject({
      ok: true,
      value: { invocationId: 'inv-1', replay: true, status: 'complete' },
    })
    expect(sdkDb.consumePeriodQuota).not.toHaveBeenCalled()
  })

  it('re-consumes quota and revives status for a failed-replay retry', async () => {
    const currentGrant = grant({ quotaLimits: { maxRequestsPerRun: 10 } })
    vi.mocked(sdkDb.findGrant).mockResolvedValue(currentGrant)
    vi.mocked(sdkDb.reviveFailedInvocation).mockResolvedValue(2)
    vi.mocked(sdkDb.insertInvocation).mockResolvedValue({
      kind: 'replay',
      invocation: invocation({
        status: 'failed',
        promptAuthorization: {
          policyRevision: currentGrant.policyRevision,
          policyHash: sdkDb.hashPromptTargetPolicy(currentGrant),
          authorizedTargetRefs: currentGrant.promptTargets.map(target => target.targetRef),
        },
      }),
    })
    const result = await authorizePromptBridge({ claims: claims(), ...basePromptParams })
    // A failed replay is a new physical attempt, but it remains the same
    // logical idempotent invocation and therefore does not consume period
    // quota a second time.
    expect(sdkDb.consumePeriodQuota).not.toHaveBeenCalled()
    // The retry transition is performed atomically by the DB revive operation.
    expect(sdkDb.reviveFailedInvocation).toHaveBeenCalledWith({
      id: 'inv-1',
      recipeNamespace: NS,
      recipeName: RECIPE,
      leaseSeconds: expect.any(Number),
    })
    expect(result).toMatchObject({
      ok: true,
      value: {
        invocationId: 'inv-1',
        replay: true,
        providerCallRequired: true,
        status: 'in_progress',
      },
    })
  })

  it('returns idempotency_conflict when the key was reused with another payload', async () => {
    vi.mocked(sdkDb.findGrant).mockResolvedValue(grant())
    vi.mocked(sdkDb.insertInvocation).mockResolvedValue({
      kind: 'conflict',
      invocation: invocation(),
    })
    const result = await authorizePromptBridge({ claims: claims(), ...basePromptParams })
    expect(result).toMatchObject({ ok: false, error: 'idempotency_conflict' })
  })
})

describe('reissuePromptBridgeCredentialTicket', () => {
  const authorizedSuffix = {
    policyRevision: 1,
    policyHash: 'a'.repeat(64),
    authorizedTargetRefs: ['primary-zai', 'openai-fallback'],
  }

  const twoTargetGrant = () =>
    grant({
      promptTargets: [
        {
          targetRef: 'primary-zai',
          provider: 'zai',
          model: 'glm-4.7',
          credentialSlot: 'zai-api-key',
        },
        {
          targetRef: 'openai-fallback',
          provider: 'openai',
          model: 'gpt-5.4',
          credentialSlot: 'openai-api-key',
        },
      ],
      defaultTargetRef: 'primary-zai',
    })

  it('issues a fresh short-lived ticket only for the persisted fallback suffix', async () => {
    const policy = twoTargetGrant()
    authorizedSuffix.policyHash = sdkDb.hashPromptTargetPolicy(policy)
    vi.mocked(sdkDb.findGrant).mockResolvedValue(policy)
    vi.mocked(sdkDb.getInvocationById).mockResolvedValue(
      invocation({ promptAuthorization: { ...authorizedSuffix } })
    )

    const result = await reissuePromptBridgeCredentialTicket({
      claims: claims(),
      invocationId: 'inv-1',
      targetRef: 'openai-fallback',
      attemptGeneration: 1,
    })

    expect(result).toMatchObject({
      ok: true,
      value: {
        invocationId: 'inv-1',
        targetRef: 'openai-fallback',
        policyRevision: 1,
        policyHash: authorizedSuffix.policyHash,
        expiresInSeconds: 60,
      },
    })
    if (!result.ok) return
    const claimsFromTicket = jwt.decode(result.value.credentialTicket) as jwt.JwtPayload
    expect(claimsFromTicket).toMatchObject({
      invocationId: 'inv-1',
      targetRef: 'openai-fallback',
      policyHash: authorizedSuffix.policyHash,
      policyRevision: 1,
    })
    expect(typeof claimsFromTicket.jti).toBe('string')
    expect(sdkDb.registerPluginWorkloadSdkCredentialTicketJti).toHaveBeenCalledWith(
      expect.objectContaining({ invocationId: 'inv-1', targetRef: 'openai-fallback' })
    )
    expect(JSON.stringify(result.value)).not.toContain('secret-value')
  })

  it('fails closed for a body target outside the original authorization suffix', async () => {
    vi.mocked(sdkDb.getInvocationById).mockResolvedValue(
      invocation({
        promptAuthorization: { ...authorizedSuffix, authorizedTargetRefs: ['primary-zai'] },
      })
    )
    const result = await reissuePromptBridgeCredentialTicket({
      claims: claims(),
      invocationId: 'inv-1',
      targetRef: 'openai-fallback',
      attemptGeneration: 1,
    })
    expect(result).toMatchObject({ ok: false, error: 'target_not_allowed' })
    expect(sdkDb.findGrant).not.toHaveBeenCalled()
    expect(sdkDb.registerPluginWorkloadSdkCredentialTicketJti).not.toHaveBeenCalled()
  })

  it('fails closed when policy changes or the invocation is terminal', async () => {
    const policy = twoTargetGrant()
    authorizedSuffix.policyHash = sdkDb.hashPromptTargetPolicy(policy)
    vi.mocked(sdkDb.findGrant).mockResolvedValue(
      grant({
        ...twoTargetGrant(),
        policyRevision: 2,
      })
    )
    vi.mocked(sdkDb.getInvocationById).mockResolvedValue(
      invocation({ promptAuthorization: { ...authorizedSuffix } })
    )
    await expect(
      reissuePromptBridgeCredentialTicket({
        claims: claims(),
        invocationId: 'inv-1',
        targetRef: 'openai-fallback',
        attemptGeneration: 1,
      })
    ).resolves.toMatchObject({ ok: false, error: 'provider_policy_denied' })

    vi.mocked(sdkDb.getInvocationById).mockResolvedValue(
      invocation({ status: 'failed', promptAuthorization: { ...authorizedSuffix } })
    )
    await expect(
      reissuePromptBridgeCredentialTicket({
        claims: claims(),
        invocationId: 'inv-1',
        targetRef: 'openai-fallback',
        attemptGeneration: 1,
      })
    ).resolves.toMatchObject({ ok: false, error: 'provider_policy_denied' })
  })
})

describe('authorizeClientNotification', () => {
  const notificationGrant = (overrides: Partial<sdkDb.PluginWorkloadSdkGrant> = {}) =>
    grant({
      capabilityFamily: 'clientNotifications',
      allowedEventTypes: ['lead.followup.due'],
      allowedTargetRefs: ['team.sales'],
      ...overrides,
    })

  beforeEach(() => {
    vi.mocked(sdkDb.insertInvocation).mockResolvedValue({
      kind: 'inserted',
      invocation: invocation({ method: 'clientNotifications', status: 'accepted' }),
    })
  })

  it('returns scope_denied when the JWT lacks the plugin-workload-sdk scope', async () => {
    const result = await authorizeClientNotification({
      claims: claims([]),
      ...baseNotificationParams,
    })
    expect(result).toMatchObject({ ok: false, error: 'scope_denied' })
  })

  it('returns event_type_not_allowed for an undeclared event type', async () => {
    vi.mocked(sdkDb.findGrant).mockResolvedValue(notificationGrant())
    const result = await authorizeClientNotification({
      claims: claims(),
      ...baseNotificationParams,
      eventType: 'unknown.event',
    })
    expect(result).toMatchObject({ ok: false, error: 'event_type_not_allowed' })
  })

  it('returns target_not_allowed for a target outside allowedTargetRefs', async () => {
    vi.mocked(sdkDb.findGrant).mockResolvedValue(notificationGrant())
    const result = await authorizeClientNotification({
      claims: claims(),
      ...baseNotificationParams,
      targetRef: 'team.engineering',
    })
    expect(result).toMatchObject({ ok: false, error: 'target_not_allowed' })
  })

  it('returns target_not_allowed for a userRef when the grant does not allow them', async () => {
    vi.mocked(sdkDb.findGrant).mockResolvedValue(notificationGrant())
    const result = await authorizeClientNotification({
      claims: claims(),
      ...baseNotificationParams,
      targetRef: undefined,
      userRef: 'user-123',
    })
    expect(result).toMatchObject({ ok: false, error: 'target_not_allowed' })
  })

  it('accepts a valid notification intent', async () => {
    vi.mocked(sdkDb.findGrant).mockResolvedValue(notificationGrant())
    const result = await authorizeClientNotification({
      claims: claims(),
      ...baseNotificationParams,
    })
    expect(result).toMatchObject({
      ok: true,
      value: { notificationId: 'inv-1', replay: false, status: 'accepted' },
    })
  })

  it('rate-limits per recipe + eventType', async () => {
    vi.mocked(sdkDb.findGrant).mockResolvedValue(
      notificationGrant({ quotaLimits: { maxNotificationsPerMinute: 2 } })
    )
    // The current in-progress invocation is already audited before the rate
    // check, so countRecentInvocations returns limit+1 (3) when the window
    // genuinely exceeds the 2/minute ceiling (recent > limit).
    vi.mocked(sdkDb.countRecentInvocations).mockResolvedValue(3)
    const result = await authorizeClientNotification({
      claims: claims(),
      ...baseNotificationParams,
    })
    expect(result).toMatchObject({ ok: false, error: 'quota_exceeded' })
    expect(sdkDb.insertInvocation).toHaveBeenCalledOnce()
    expect(sdkDb.updateInvocationStatus).toHaveBeenCalledWith('inv-1', 'failed', {
      completed: true,
      recipeNamespace: NS,
      recipeName: RECIPE,
    })
    expect(sdkDb.countRecentInvocations).toHaveBeenCalledWith(NS, RECIPE, 'clientNotifications', {
      detail: 'lead.followup.due',
    })
  })
})

describe('authorizeListRecipients', () => {
  const notificationGrant = (overrides: Partial<sdkDb.PluginWorkloadSdkGrant> = {}) =>
    grant({
      capabilityFamily: 'clientNotifications',
      allowedEventTypes: ['lead.followup.due'],
      ...overrides,
    })

  it('returns scope_denied when the JWT lacks the plugin-workload-sdk scope', async () => {
    const result = await authorizeListRecipients({ claims: claims([]), callerRef: 'api' })
    expect(result).toMatchObject({ ok: false, error: 'scope_denied' })
    expect(sdkDb.findGrant).not.toHaveBeenCalled()
  })

  it('returns capability_not_declared when no clientNotifications grant exists', async () => {
    vi.mocked(sdkDb.findGrant).mockResolvedValue(null)
    const result = await authorizeListRecipients({ claims: claims(), callerRef: 'api' })
    expect(result).toMatchObject({ ok: false, error: 'capability_not_declared' })
    expect(sdkDb.findGrant).toHaveBeenCalledWith(NS, RECIPE, 'clientNotifications')
  })

  it('returns caller_not_allowed when the caller is not in allowedCallers', async () => {
    vi.mocked(sdkDb.findGrant).mockResolvedValue(notificationGrant({ allowedCallers: ['worker'] }))
    const result = await authorizeListRecipients({ claims: claims(), callerRef: 'api' })
    expect(result).toMatchObject({ ok: false, error: 'caller_not_allowed' })
  })

  it('returns the grant allowedUserRefs for an authorized caller without auditing', async () => {
    const refs = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222']
    vi.mocked(sdkDb.findGrant).mockResolvedValue(notificationGrant({ allowedUserRefs: refs }))
    const result = await authorizeListRecipients({ claims: claims(), callerRef: 'api' })
    expect(result).toMatchObject({ ok: true, value: { allowedUserRefs: refs } })
    // Read-only: no invocation row, no quota consumption.
    expect(sdkDb.insertInvocation).not.toHaveBeenCalled()
    expect(sdkDb.consumePeriodQuota).not.toHaveBeenCalled()
  })
})
