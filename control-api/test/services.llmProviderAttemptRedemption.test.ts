import { beforeEach, describe, expect, it, vi } from 'vitest'
import { config } from '../src/config.js'
import * as connection from '../src/services/codexSubscriptionConnection.js'
import {
  LlmProviderAttemptRedeemError,
  redeemLlmProviderAttempt,
} from '../src/services/llmProviderAttemptRedemption.js'
import * as store from '../src/services/llmProviderAttemptStore.js'
import * as ticket from '../src/services/llmProviderAttemptTicket.js'

vi.mock('../src/db.js', () => ({
  pool: { query: vi.fn() },
  withTransaction: async (work: (tx: { query: typeof vi.fn }) => unknown) =>
    work({ query: vi.fn() }),
}))

const CLAIMS = {
  jti: '11111111-1111-4111-8111-111111111111',
  typ: 'codex-execution-ticket' as const,
  sub: 'host/research-host',
  hostRef: 'research-host',
  invocationId: 'invocation-1',
  attemptGeneration: 1,
  providerAttemptId: '33333333-3333-4333-8333-333333333333',
  providerAttemptIndex: 1,
  provider: 'codex-subscription' as const,
  model: 'gpt-5.1',
  requestHash: 'a'.repeat(64),
  policyRevision: 4,
  policyHash: 'b'.repeat(64),
  budgetReservationId: 'unbudgeted',
  connectionRevision: 3,
}

describe('redeemLlmProviderAttempt', () => {
  beforeEach(() => {
    config.codexSubscriptionEnabled = true
    vi.spyOn(ticket, 'verifyCodexExecutionTicket').mockReturnValue(CLAIMS)
    vi.spyOn(store, 'lockLlmProviderAttemptTicket').mockResolvedValue({
      jti: CLAIMS.jti,
      providerAttemptId: CLAIMS.providerAttemptId,
      status: 'issued',
      expiresAt: new Date(Date.now() + 30_000),
      receiptHash: null,
    })
    vi.spyOn(store, 'loadLlmProviderAttempt').mockResolvedValue({
      id: CLAIMS.providerAttemptId,
      callerKind: 'host',
      hostRef: CLAIMS.hostRef,
      recipeNamespace: null,
      recipeName: null,
      invocationId: CLAIMS.invocationId,
      attemptGeneration: CLAIMS.attemptGeneration,
      providerAttemptIndex: 1,
      provider: 'codex-subscription',
      model: CLAIMS.model,
      requestHash: CLAIMS.requestHash,
      policyRevision: CLAIMS.policyRevision,
      policyHash: CLAIMS.policyHash,
      budgetReservationId: CLAIMS.budgetReservationId,
      connectionRevision: CLAIMS.connectionRevision,
      connectionId: null,
      status: 'authorized',
      outcome: null,
      createdAt: new Date(),
    })
    vi.spyOn(store, 'markLlmProviderAttemptTicketRedeemed').mockResolvedValue(true)
    vi.spyOn(connection, 'getSafeCodexSubscriptionConnection').mockResolvedValue({
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
    })
  })

  it('returns only the usable access token and frozen transport metadata', async () => {
    const result = await redeemLlmProviderAttempt(
      { executionTicket: 'ticket', requestHash: CLAIMS.requestHash },
      {
        enabled: true,
        db: { query: vi.fn() },
        getConnectionById: vi.fn(),
        withTransaction: async work => work({ query: vi.fn() } as never),
        loadSecrets: async () => ({
          refreshToken: 'refresh-secret',
          accessToken: 'access-usable',
          accessTokenExpiresAt: new Date(Date.now() + 120_000),
          chatgptAccountId: 'acct_live_1',
          credentialRevision: 3,
        }),
        encryptionKey: Buffer.alloc(32),
      }
    )
    expect(result.accessToken).toBe('access-usable')
    expect(result.chatgptAccountId).toBe('acct_live_1')
    expect(result.transport.completionsOrigin).toBe(
      'https://chatgpt.com/backend-api/codex/responses'
    )
    expect(JSON.stringify(result)).not.toContain('refresh-secret')
    expect(JSON.stringify(result)).not.toMatch(/encrypted|Authorization/i)
  })

  it('rejects a replayed ticket before returning any token', async () => {
    vi.mocked(store.lockLlmProviderAttemptTicket).mockResolvedValueOnce({
      jti: CLAIMS.jti,
      providerAttemptId: CLAIMS.providerAttemptId,
      status: 'redeemed',
      expiresAt: new Date(Date.now() + 30_000),
      receiptHash: null,
    })
    await expect(
      redeemLlmProviderAttempt(
        { executionTicket: 'ticket', requestHash: CLAIMS.requestHash },
        {
          enabled: true,
          db: { query: vi.fn() },
          getConnectionById: vi.fn(),
          withTransaction: async work => work({ query: vi.fn() } as never),
          loadSecrets: async () => {
            throw new Error('should not load secrets')
          },
          encryptionKey: Buffer.alloc(32),
        }
      )
    ).rejects.toMatchObject({ code: 'ticket_replayed' })
  })

  it('rejects a requestHash mismatch', async () => {
    await expect(
      redeemLlmProviderAttempt({ executionTicket: 'ticket', requestHash: 'c'.repeat(64) })
    ).rejects.toBeInstanceOf(LlmProviderAttemptRedeemError)
  })

  it('refuses to redeem a pre-revoke ticket after the grant is revoked', async () => {
    vi.mocked(connection.getSafeCodexSubscriptionConnection).mockResolvedValueOnce({
      id: '11111111-1111-1111-1111-111111111111',
      connectionKey: 'team-plus',
      displayName: 'Team Plus',
      createdBy: null,
      status: 'revoked',
      credentialRevision: 4,
      catalogRevision: 4,
      accountFingerprint: null,
      catalogStatus: 'ready',
      catalogSyncedAt: new Date(),
      lastRefreshAt: null,
      lastAuthAt: new Date(),
      refreshLockHeld: false,
      revokedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    await expect(
      redeemLlmProviderAttempt(
        { executionTicket: 'ticket', requestHash: CLAIMS.requestHash },
        {
          enabled: true,
          db: { query: vi.fn() },
          getConnectionById: vi.fn(),
          withTransaction: async work => work({ query: vi.fn() } as never),
          loadSecrets: async () => {
            throw new Error('should not load secrets after revoke')
          },
          encryptionKey: Buffer.alloc(32),
        }
      )
    ).rejects.toMatchObject({ code: 'connection_unavailable' })
  })

  it('is disabled when the flag is off', async () => {
    await expect(
      redeemLlmProviderAttempt(
        { executionTicket: 'ticket', requestHash: CLAIMS.requestHash },
        {
          enabled: false,
          db: { query: vi.fn() },
          getConnectionById: vi.fn(),
          withTransaction: async () => {
            throw new Error('should not run')
          },
          loadSecrets: async () => null,
          encryptionKey: Buffer.alloc(32),
        }
      )
    ).rejects.toMatchObject({ code: 'disabled' })
  })

  it('refuses to redeem when the ChatGPT account id is missing', async () => {
    await expect(
      redeemLlmProviderAttempt(
        { executionTicket: 'ticket', requestHash: CLAIMS.requestHash },
        {
          enabled: true,
          db: { query: vi.fn() },
          getConnectionById: vi.fn(),
          withTransaction: async work => work({ query: vi.fn() } as never),
          loadSecrets: async () => ({
            refreshToken: 'refresh-secret',
            accessToken: 'opaque-token',
            accessTokenExpiresAt: new Date(Date.now() + 120_000),
            chatgptAccountId: null,
            credentialRevision: 3,
          }),
          encryptionKey: Buffer.alloc(32),
        }
      )
    ).rejects.toMatchObject({ code: 'connection_unavailable' })
  })
})
