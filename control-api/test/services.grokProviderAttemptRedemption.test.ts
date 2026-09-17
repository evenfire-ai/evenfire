import { beforeEach, describe, expect, it, vi } from 'vitest'
import { config } from '../src/config.js'
import {
  GrokProviderAttemptRedeemError,
  redeemGrokProviderAttempt,
} from '../src/services/grokProviderAttemptRedemption.js'
import * as ticket from '../src/services/grokProviderAttemptTicket.js'
import * as connection from '../src/services/grokSubscriptionConnection.js'
import { GrokSubscriptionOAuthError } from '../src/services/grokSubscriptionOAuth.js'
import * as store from '../src/services/llmProviderAttemptStore.js'

vi.mock('../src/db.js', () => ({
  pool: { query: vi.fn() },
  withTransaction: async (work: (tx: { query: typeof vi.fn }) => unknown) =>
    work({ query: vi.fn() }),
}))

const CONNECTION_ID = '11111111-1111-4111-8111-111111111111'
const CLAIMS = {
  jti: '22222222-2222-4222-8222-222222222222',
  typ: 'grok-execution-ticket' as const,
  sub: 'host/research-host',
  hostRef: 'research-host',
  invocationId: 'invocation-1',
  attemptGeneration: 1,
  providerAttemptId: '33333333-3333-4333-8333-333333333333',
  providerAttemptIndex: 1,
  provider: 'grok-subscription' as const,
  model: 'grok-4.6',
  requestHash: 'a'.repeat(64),
  policyRevision: 4,
  policyHash: 'b'.repeat(64),
  budgetReservationId: 'unbudgeted',
  connectionRevision: 3,
  connectionId: CONNECTION_ID,
}

describe('redeemGrokProviderAttempt', () => {
  beforeEach(() => {
    config.grokSubscriptionEnabled = true
    vi.spyOn(ticket, 'verifyGrokExecutionTicket').mockReturnValue(CLAIMS)
  })

  it('rejects a replayed ticket before rotating the refresh token', async () => {
    const ensureFresh = vi.fn()
    vi.spyOn(store, 'peekLlmProviderAttemptTicket').mockResolvedValue({
      jti: CLAIMS.jti,
      providerAttemptId: CLAIMS.providerAttemptId,
      status: 'redeemed',
      expiresAt: new Date(Date.now() + 30_000),
      receiptHash: null,
    })
    await expect(
      redeemGrokProviderAttempt(
        { executionTicket: 'ticket', requestHash: CLAIMS.requestHash },
        {
          enabled: true,
          db: { query: vi.fn() },
          withTransaction: async work => work({ query: vi.fn() }),
          loadSecrets: vi.fn(),
          getConnectionById: connection.getSafeGrokSubscriptionConnectionById,
          encryptionKey: Buffer.alloc(32),
          ensureFreshAccessToken: ensureFresh,
        }
      )
    ).rejects.toMatchObject({
      code: 'ticket_replayed',
    } satisfies Partial<GrokProviderAttemptRedeemError>)
    expect(ensureFresh).not.toHaveBeenCalled()
  })

  it('rejects a Codex-shaped ticket before loading Grok secrets', async () => {
    vi.spyOn(ticket, 'verifyGrokExecutionTicket').mockReturnValue(null)
    const loadSecrets = vi.fn()
    await expect(
      redeemGrokProviderAttempt(
        { executionTicket: 'codex-ticket', requestHash: CLAIMS.requestHash },
        {
          enabled: true,
          db: { query: vi.fn() },
          withTransaction: async work => work({ query: vi.fn() }),
          loadSecrets,
          getConnectionById: connection.getSafeGrokSubscriptionConnectionById,
          encryptionKey: Buffer.alloc(32),
        }
      )
    ).rejects.toMatchObject({ code: 'ticket_invalid' })
    expect(loadSecrets).not.toHaveBeenCalled()
  })

  it('maps reauth_required refresh to a non-retryable no_grant', async () => {
    vi.spyOn(store, 'peekLlmProviderAttemptTicket').mockResolvedValue({
      jti: CLAIMS.jti,
      providerAttemptId: CLAIMS.providerAttemptId,
      status: 'issued',
      expiresAt: new Date(Date.now() + 30_000),
      receiptHash: null,
    })
    vi.spyOn(store, 'loadLlmProviderAttempt').mockResolvedValue({
      id: CLAIMS.providerAttemptId,
      provider: 'grok-subscription',
      connectionId: CONNECTION_ID,
      status: 'authorized',
    } as never)
    await expect(
      redeemGrokProviderAttempt(
        { executionTicket: 'ticket', requestHash: CLAIMS.requestHash },
        {
          enabled: true,
          db: { query: vi.fn() },
          withTransaction: async work => work({ query: vi.fn() }),
          loadSecrets: vi.fn(),
          getConnectionById: vi.fn().mockResolvedValue({ connectionKey: 'team-grok' }),
          encryptionKey: Buffer.alloc(32),
          ensureFreshAccessToken: async () => {
            throw new GrokSubscriptionOAuthError('reauth_required', 'refresh token was rejected')
          },
        }
      )
    ).rejects.toMatchObject({ code: 'no_grant' })
  })
})
