import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  LIMITS,
  computeGrokPolicyHash,
  hashGrokCompletionRequestV1,
} from '@clerum/grok-provider-attempt-contract'
import { config } from '../src/config.js'
import {
  AUTHORIZE_ENVELOPE_ALLOWANCE_BYTES,
  LlmProviderAttemptAuthorizeError,
  type LlmProviderAttemptAuthorizerDeps,
  authorizeLlmProviderAttempt,
} from '../src/services/llmProviderAttemptAuthorizer.js'
import type { McpHostAccessClaims } from '../src/utils/auth/mcpHostJwtToken.js'

const grokRepos = vi.hoisted(() => ({
  getConnection: vi.fn(),
  getModelState: vi.fn(),
  issueTicket: vi.fn(),
}))
const lockPluginWorkloadSdkRecipe = vi.hoisted(() => vi.fn())
const getPluginWorkloadSdkProviderAttemptForUpdate = vi.hoisted(() => vi.fn())
const pluginWorkloadSdkSpendOutcomeExists = vi.hoisted(() => vi.fn())
const promoteReservedOauthBrokerProviderAttempt = vi.hoisted(() => vi.fn())

vi.mock('../src/services/grokSubscriptionConnection.js', async () => {
  const actual = await vi.importActual<
    typeof import('../src/services/grokSubscriptionConnection.js')
  >('../src/services/grokSubscriptionConnection.js')
  return {
    ...actual,
    getSafeGrokSubscriptionConnection: grokRepos.getConnection,
  }
})

vi.mock('../src/services/grokSubscriptionCatalog.js', async () => {
  const actual = await vi.importActual<typeof import('../src/services/grokSubscriptionCatalog.js')>(
    '../src/services/grokSubscriptionCatalog.js'
  )
  return {
    ...actual,
    getGrokCatalogModelState: grokRepos.getModelState,
  }
})

vi.mock('../src/services/grokProviderAttemptTicket.js', async () => {
  const actual = await vi.importActual<
    typeof import('../src/services/grokProviderAttemptTicket.js')
  >('../src/services/grokProviderAttemptTicket.js')
  return {
    ...actual,
    issueRegisteredGrokExecutionTicket: grokRepos.issueTicket,
  }
})

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
    targetRef: 'grok-primary',
    provider: 'grok-subscription',
    model: 'grok-4.6',
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
  schemaVersion: 'grok-completion-request.v1' as const,
  requestId: 'req-001',
  idempotencyKey: 'idem-001',
  provider: 'grok-subscription' as const,
  model: 'grok-4.6',
  messages: [{ role: 'user' as const, content: 'hello' }],
}

function claims(overrides: Partial<McpHostAccessClaims> = {}): McpHostAccessClaims {
  return {
    sub: 'default/research-host',
    recipeNamespace: 'default',
    recipeName: 'research-host',
    hostRefs: ['research-host'],
    scope: 'workflow:approval:request',
    workflowControlScopes: ['llm:grok:execute'],
    iss: 'control-api',
    aud: 'workflow-approvals',
    jti: 'jti-1',
    exp: Math.floor(Date.now() / 1000) + 60,
    ...overrides,
  }
}

function grokConnection(overrides: Record<string, unknown> = {}) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    connectionKey: 'team-grok',
    displayName: 'Team Grok',
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
  const policyHash = computeGrokPolicyHash({
    model: REQUEST.model,
    catalogRevision: 4,
    credentialRevision: 3,
    connectionKey: 'team-grok',
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

// `resolveConnectionKey` is a test-only convenience that feeds the default
// `resolveAssignment`; the authorizer itself only consumes `resolveAssignment`.
function deps({
  resolveConnectionKey: resolveConnectionKeyOverride,
  ...overrides
}: Partial<LlmProviderAttemptAuthorizerDeps> & {
  resolveConnectionKey?: (hostRef: string) => Promise<string>
} = {}): LlmProviderAttemptAuthorizerDeps {
  const db = { query: vi.fn() }
  const resolveConnectionKey =
    resolveConnectionKeyOverride ?? vi.fn().mockResolvedValue('team-grok')
  const resolveAssignment =
    overrides.resolveAssignment ??
    (async (hostRef: string) => ({
      liveBrokerProviders: ['grok-subscription'],
      liveConnectionRef: await resolveConnectionKey(hostRef),
    }))
  return {
    enabled: true,
    db,
    withTransaction: async work => work(db as never),
    getConnection: vi.fn(),
    getModelState: vi.fn(),
    evaluateBudget: vi.fn().mockResolvedValue({ allowed: true, reservationIds: ['res-1'] }),
    getActiveReservation: vi.fn().mockResolvedValue({ id: 'res-1' }),
    getMaxGeneration: vi.fn().mockResolvedValue(0),
    insertAttempt: vi.fn().mockResolvedValue({
      id: '33333333-3333-4333-8333-333333333333',
      hostRef: 'research-host',
    }),
    issueTicket: vi.fn(),
    ...overrides,
    resolveAssignment,
  }
}

describe('authorizeLlmProviderAttempt grok-subscription', () => {
  const previousFlag = config.grokSubscriptionEnabled

  beforeEach(() => {
    config.grokSubscriptionEnabled = true
    grokRepos.getConnection.mockReset().mockResolvedValue(grokConnection())
    grokRepos.getModelState.mockReset().mockResolvedValue({ enabled: true, stale: false })
    grokRepos.issueTicket.mockReset().mockResolvedValue({
      executionTicket: 'grok-ticket.jwt',
      expiresAt: new Date('2026-08-20T12:00:00.000Z'),
      claims: { jti: 'jti-ticket' },
    })
    lockPluginWorkloadSdkRecipe.mockReset().mockResolvedValue(undefined)
    getPluginWorkloadSdkProviderAttemptForUpdate.mockReset()
    pluginWorkloadSdkSpendOutcomeExists.mockReset().mockResolvedValue(false)
    promoteReservedOauthBrokerProviderAttempt.mockReset().mockResolvedValue(true)
  })

  afterEach(() => {
    config.grokSubscriptionEnabled = previousFlag
  })

  it('returns disabled when the Grok flag is off and never looks up a grant', async () => {
    config.grokSubscriptionEnabled = false
    const current = deps()
    await expect(authorizeLlmProviderAttempt(claims(), body(), current)).rejects.toMatchObject({
      code: 'disabled',
    } satisfies Partial<LlmProviderAttemptAuthorizeError>)
    expect(grokRepos.getConnection).not.toHaveBeenCalled()
    expect(current.insertAttempt).not.toHaveBeenCalled()
  })

  it('rejects an unassigned Grok Host as unassigned_connection', async () => {
    const current = deps({
      resolveConnectionKey: async () => 'unassigned',
    })
    await expect(authorizeLlmProviderAttempt(claims(), body(), current)).rejects.toMatchObject({
      code: 'unassigned_connection',
    })
    expect(grokRepos.getConnection).not.toHaveBeenCalled()
    expect(current.insertAttempt).not.toHaveBeenCalled()
  })

  it('rejects an empty Grok connectionRef as unassigned, never deployment-default', async () => {
    const current = deps({
      resolveConnectionKey: async () => '',
    })
    await expect(authorizeLlmProviderAttempt(claims(), body(), current)).rejects.toMatchObject({
      code: 'unassigned_connection',
    })
    expect(grokRepos.getConnection).not.toHaveBeenCalled()
  })

  it('rejects the reserved deployment-default key on a Grok Host', async () => {
    const current = deps({
      resolveConnectionKey: async () => 'deployment-default',
    })
    await expect(authorizeLlmProviderAttempt(claims(), body(), current)).rejects.toMatchObject({
      code: 'unassigned_connection',
    })
    expect(grokRepos.getConnection).not.toHaveBeenCalled()
    expect(current.insertAttempt).not.toHaveBeenCalled()
  })

  it('authorizes a named Grok grant without treating Codex deployment-default as a fallback', async () => {
    const current = deps()
    const result = await authorizeLlmProviderAttempt(claims(), body(), current)
    expect(result).toMatchObject({
      providerAttemptId: '33333333-3333-4333-8333-333333333333',
      executionTicket: 'grok-ticket.jwt',
      requestHash: hashGrokCompletionRequestV1(REQUEST),
    })
    expect(grokRepos.getConnection).toHaveBeenCalledWith(expect.anything(), 'team-grok')
    expect(current.evaluateBudget).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'grok-subscription' }),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ requiredUnit: 'tokens', reservationTtlSeconds: 2160 })
    )
    expect(current.insertAttempt).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        provider: 'grok-subscription',
        model: 'grok-4.6',
      })
    )
  })

  it('denies Grok spend when the live Host has no oauth-broker target', async () => {
    const current = deps({
      resolveAssignment: async () => ({
        liveBrokerProviders: [],
        liveConnectionRef: 'team-grok',
      }),
    })
    await expect(authorizeLlmProviderAttempt(claims(), body(), current)).rejects.toMatchObject({
      code: 'host_binding_mismatch',
    })
    expect(grokRepos.getConnection).not.toHaveBeenCalled()
    expect(current.insertAttempt).not.toHaveBeenCalled()
  })

  it('binds a reserved Plugin Workload SDK attempt onto the Grok ledger row', async () => {
    const sdkAttemptId = reservedSdkAttempt().id
    getPluginWorkloadSdkProviderAttemptForUpdate.mockResolvedValue(reservedSdkAttempt())
    const current = deps()
    await authorizeLlmProviderAttempt(
      claims({
        recipeNamespace: 'sandbox-recipes',
        recipeName: 'prompt-notify',
        hostRefs: ['sandbox-recipes/prompt-notify'],
      }),
      body({ pluginWorkloadSdkProviderAttemptId: sdkAttemptId, targetRef: 'grok-primary' }),
      current
    )
    expect(lockPluginWorkloadSdkRecipe).toHaveBeenCalledWith(
      expect.anything(),
      'sandbox-recipes',
      'prompt-notify'
    )
    expect(current.insertAttempt).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        pluginWorkloadSdkProviderAttemptId: sdkAttemptId,
        callerKind: 'recipe',
        provider: 'grok-subscription',
      })
    )
    expect(promoteReservedOauthBrokerProviderAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        id: sdkAttemptId,
        provider: 'grok-subscription',
        model: 'grok-4.6',
        targetRef: 'grok-primary',
      }),
      expect.anything()
    )
  })

  it('rejects a reserved SDK attempt whose provider is Codex', async () => {
    getPluginWorkloadSdkProviderAttemptForUpdate.mockResolvedValue(
      reservedSdkAttempt({ provider: 'codex-subscription' })
    )
    const current = deps()
    await expect(
      authorizeLlmProviderAttempt(
        claims({
          recipeNamespace: 'sandbox-recipes',
          recipeName: 'prompt-notify',
          hostRefs: ['sandbox-recipes/prompt-notify'],
        }),
        body({
          pluginWorkloadSdkProviderAttemptId: reservedSdkAttempt().id,
          targetRef: 'grok-primary',
        }),
        current
      )
    ).rejects.toMatchObject({ code: 'no_grant' })
    expect(current.insertAttempt).not.toHaveBeenCalled()
    expect(promoteReservedOauthBrokerProviderAttempt).not.toHaveBeenCalled()
  })

  it('rejects a host caller that presents a Plugin Workload SDK attempt id', async () => {
    const current = deps()
    await expect(
      authorizeLlmProviderAttempt(
        claims(),
        body({ pluginWorkloadSdkProviderAttemptId: reservedSdkAttempt().id }),
        current
      )
    ).rejects.toMatchObject({
      code: 'no_grant',
      // A host caller has no recipe namespace, so a later SDK-link check would
      // also reject with no_grant. Only the host guard produces this message.
      message: 'host Grok chat cannot bind a Plugin Workload SDK provider attempt',
    })
    expect(lockPluginWorkloadSdkRecipe).not.toHaveBeenCalled()
    expect(getPluginWorkloadSdkProviderAttemptForUpdate).not.toHaveBeenCalled()
    expect(current.insertAttempt).not.toHaveBeenCalled()
  })

  // #731 R3-3: the byte cap belongs to `request`; the authorize envelope around
  // it gets its own allowance, as the proxies' body limit does (R2-6).
  describe('request cap and envelope allowance (#731 R3-3)', () => {
    /** REQUEST padded so that JSON.stringify(request) is exactly `bytes` long. */
    function requestOfBytes(bytes: number) {
      const base = Buffer.byteLength(JSON.stringify(REQUEST), 'utf8')
      const content = 'x'.repeat(REQUEST.messages[0]!.content.length + bytes - base)
      const request = { ...REQUEST, messages: [{ role: 'user' as const, content }] }
      expect(Buffer.byteLength(JSON.stringify(request), 'utf8')).toBe(bytes)
      return request
    }

    it('T-R3-3a-grok authorizes a request just under the cap although the whole body is over it', async () => {
      const current = deps()
      const request = requestOfBytes(LIMITS.maxRequestBodyBytes - 64)
      const payload = body({ request })
      // Fixture check: the envelope takes the whole body past the request cap.
      expect(Buffer.byteLength(JSON.stringify(payload), 'utf8')).toBeGreaterThan(
        LIMITS.maxRequestBodyBytes
      )
      const result = await authorizeLlmProviderAttempt(claims(), payload, current)
      expect(result).toMatchObject({
        executionTicket: 'grok-ticket.jwt',
        requestHash: hashGrokCompletionRequestV1(request),
      })
      expect(current.insertAttempt).toHaveBeenCalledTimes(1)
    })

    it('T-R3-3b-grok refuses a request one byte over the cap with the contract message', async () => {
      const current = deps()
      const request = requestOfBytes(LIMITS.maxRequestBodyBytes + 1)
      await expect(
        authorizeLlmProviderAttempt(claims(), body({ request }), current)
      ).rejects.toMatchObject({
        code: 'invalid_request',
        message: 'request exceeds maxRequestBodyBytes',
      })
      expect(current.insertAttempt).not.toHaveBeenCalled()
      // Witness: the same authorizer admits the request once it fits.
      await authorizeLlmProviderAttempt(
        claims(),
        body({ request: requestOfBytes(LIMITS.maxRequestBodyBytes) }),
        current
      )
      expect(current.insertAttempt).toHaveBeenCalledTimes(1)
    })

    it('T-R3-3c-grok refuses a body one byte past the cap plus the envelope allowance', async () => {
      const current = deps()
      const request = requestOfBytes(LIMITS.maxRequestBodyBytes)
      const withoutFiller = Buffer.byteLength(
        JSON.stringify(body({ request, recipeName: '' })),
        'utf8'
      )
      const limit = LIMITS.maxRequestBodyBytes + AUTHORIZE_ENVELOPE_ALLOWANCE_BYTES
      const payload = body({ request, recipeName: 'r'.repeat(limit + 1 - withoutFiller) })
      expect(Buffer.byteLength(JSON.stringify(payload), 'utf8')).toBe(limit + 1)
      await expect(authorizeLlmProviderAttempt(claims(), payload, current)).rejects.toMatchObject({
        code: 'invalid_request',
        message: 'request body exceeds the limit',
      })
      expect(current.insertAttempt).not.toHaveBeenCalled()
    })
  })
})
