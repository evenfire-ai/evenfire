import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  computeGrokPolicyHash,
  hashGrokCompletionRequestV1,
} from '@clerum/grok-provider-attempt-contract'
import { config } from '../src/config.js'
import {
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

function deps(
  overrides: Partial<LlmProviderAttemptAuthorizerDeps> = {}
): LlmProviderAttemptAuthorizerDeps {
  const db = { query: vi.fn() }
  const resolveConnectionKey =
    overrides.resolveConnectionKey ?? vi.fn().mockResolvedValue('team-grok')
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
    resolveConnectionKey,
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
    expect(current.insertAttempt).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        provider: 'grok-subscription',
        model: 'grok-4.6',
      })
    )
  })
})
