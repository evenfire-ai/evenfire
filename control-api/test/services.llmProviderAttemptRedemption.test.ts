import { beforeEach, describe, expect, it, vi } from 'vitest'
import { config } from '../src/config.js'
import { llmAllowlistConfigMapWriteFailuresTotal } from '../src/observability/metrics.js'
import * as connection from '../src/services/codexSubscriptionConnection.js'
import { CodexSubscriptionOAuthError } from '../src/services/codexSubscriptionOAuth.js'
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

const CONNECTION_ID = '11111111-1111-1111-1111-111111111111'
const SAFE_CONNECTION = {
  id: CONNECTION_ID,
  connectionKey: 'team-plus',
  displayName: 'Team Plus',
  createdBy: null,
  status: 'connected' as const,
  credentialRevision: 3,
  catalogRevision: 4,
  accountFingerprint: 'fp',
  catalogStatus: 'ready' as const,
  catalogSyncedAt: new Date(),
  lastRefreshAt: null,
  lastAuthAt: new Date(),
  refreshLockHeld: false,
  revokedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
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
      connectionId: CONNECTION_ID,
      status: 'authorized',
      outcome: null,
      createdAt: new Date(),
    })
    vi.spyOn(store, 'markLlmProviderAttemptTicketRedeemed').mockResolvedValue(true)
    vi.spyOn(connection, 'getSafeCodexSubscriptionConnectionById').mockResolvedValue(
      SAFE_CONNECTION
    )
    vi.spyOn(connection, 'getSafeCodexSubscriptionConnection').mockResolvedValue(SAFE_CONNECTION)
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
    // The per-attempt total cap the proxy enforces (30 min).
    expect(result.transport.maxStreamDurationMs).toBe(1_800_000)
    expect(JSON.stringify(result)).not.toContain('refresh-secret')
    expect(JSON.stringify(result)).not.toMatch(/encrypted|Authorization/i)
  })

  it('prefers the stored ChatGPT account id over a conflicting access-token claim', async () => {
    const accessJwt = `hdr.${Buffer.from(
      JSON.stringify({
        'https://api.openai.com/auth': { chatgpt_account_id: 'acct_from_jwt' },
      })
    ).toString('base64url')}.sig`
    const result = await redeemLlmProviderAttempt(
      { executionTicket: 'ticket', requestHash: CLAIMS.requestHash },
      {
        enabled: true,
        db: { query: vi.fn() },
        getConnectionById: vi.fn(),
        withTransaction: async work => work({ query: vi.fn() } as never),
        loadSecrets: async () => ({
          refreshToken: 'refresh-secret',
          accessToken: accessJwt,
          accessTokenExpiresAt: new Date(Date.now() + 120_000),
          chatgptAccountId: 'acct_stored',
          credentialRevision: 3,
        }),
        encryptionKey: Buffer.alloc(32),
      }
    )
    expect(result.chatgptAccountId).toBe('acct_stored')
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
      redeemLlmProviderAttempt(
        { executionTicket: 'ticket', requestHash: 'c'.repeat(64) },
        {
          enabled: true,
          db: { query: vi.fn() },
          getConnectionById: vi.fn(),
          withTransaction: async () => {
            throw new Error('should not run')
          },
          loadSecrets: async () => null,
          encryptionKey: Buffer.alloc(32),
          publishAllowlist: vi.fn(),
        }
      )
    ).rejects.toMatchObject({
      name: 'LlmProviderAttemptRedeemError',
      code: 'request_hash_mismatch',
    })
  })

  it('refuses to redeem a pre-revoke ticket after the grant is revoked', async () => {
    vi.mocked(connection.getSafeCodexSubscriptionConnectionById).mockResolvedValueOnce({
      ...SAFE_CONNECTION,
      status: 'revoked',
      credentialRevision: 4,
      revokedAt: new Date(),
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

  it('refuses to fall back to the reserved grant when the attempt has no connectionId', async () => {
    vi.mocked(store.loadLlmProviderAttempt).mockResolvedValueOnce({
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
    await expect(
      redeemLlmProviderAttempt(
        { executionTicket: 'ticket', requestHash: CLAIMS.requestHash },
        {
          enabled: true,
          db: { query: vi.fn() },
          getConnectionById: vi.fn(),
          withTransaction: async work => work({ query: vi.fn() } as never),
          loadSecrets: async () => {
            throw new Error('should not load secrets without a connection binding')
          },
          encryptionKey: Buffer.alloc(32),
        }
      )
    ).rejects.toMatchObject({ code: 'connection_unavailable' })
    expect(connection.getSafeCodexSubscriptionConnection).not.toHaveBeenCalled()
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

  /**
   * R9-19: a refresh that wrote the connection row (a rejected refresh token
   * moves it to `reauth_required`) changed what the allowlist ConfigMap must
   * say. mcp-host and HCC read the ConfigMap, not Postgres, so redemption
   * republishes before it fails, as the refresh and catalog-sync routes do.
   */
  function refreshingDeps(
    ensureFreshAccessToken: (connectionKey?: string) => Promise<void>,
    publishAllowlist: () => Promise<void>
  ) {
    vi.mocked(ticket.verifyCodexExecutionTicket).mockReturnValue({
      ...CLAIMS,
      connectionId: CONNECTION_ID,
    })
    return {
      enabled: true,
      db: { query: vi.fn() },
      getConnectionById: vi.fn(async () => SAFE_CONNECTION),
      withTransaction: vi.fn(async () => {
        throw new Error('should not open the redemption transaction')
      }),
      loadSecrets: vi.fn(async () => null),
      encryptionKey: Buffer.alloc(32),
      ensureFreshAccessToken: vi.fn(ensureFreshAccessToken),
      publishAllowlist: vi.fn(publishAllowlist),
    }
  }

  async function mutationWriteFailures(): Promise<number> {
    const metric = await llmAllowlistConfigMapWriteFailuresTotal.get()
    return metric.values.find(v => v.labels.phase === 'mutation')?.value ?? 0
  }

  it('R9-19 republishes the allowlist before failing when the refresh persisted a status', async () => {
    const deps = refreshingDeps(
      async () => {
        throw new CodexSubscriptionOAuthError('reauth_required', 'refresh token was rejected', {
          persistedConnectionStatus: true,
        })
      },
      async () => {}
    )

    await expect(
      redeemLlmProviderAttempt({ executionTicket: 'ticket', requestHash: CLAIMS.requestHash }, deps)
    ).rejects.toMatchObject({
      name: 'LlmProviderAttemptRedeemError',
      code: 'connection_unavailable',
    })

    expect(deps.ensureFreshAccessToken).toHaveBeenCalledWith('team-plus')
    expect(deps.publishAllowlist).toHaveBeenCalledTimes(1)
    expect(deps.withTransaction).not.toHaveBeenCalled()
  })

  it('R9-19 does not republish when the refresh failed without writing the row', async () => {
    const deps = refreshingDeps(
      async () => {
        throw new CodexSubscriptionOAuthError(
          'provider_unavailable',
          'refresh token exchange failed'
        )
      },
      async () => {}
    )

    await expect(
      redeemLlmProviderAttempt({ executionTicket: 'ticket', requestHash: CLAIMS.requestHash }, deps)
    ).rejects.toBeInstanceOf(LlmProviderAttemptRedeemError)

    // Liveness witness: the refresh ran and threw, so the missing publish is a
    // decision and not a path that never reached the catch.
    expect(deps.ensureFreshAccessToken).toHaveBeenCalledTimes(1)
    await expect(
      deps.ensureFreshAccessToken.mock.results[0]?.value as Promise<void>
    ).rejects.toBeInstanceOf(CodexSubscriptionOAuthError)
    expect(deps.publishAllowlist).not.toHaveBeenCalled()
  })

  it('R9-19 counts a failed republish and still fails the redemption with its own code', async () => {
    const before = await mutationWriteFailures()
    const deps = refreshingDeps(
      async () => {
        throw new CodexSubscriptionOAuthError('reauth_required', 'refresh token was rejected', {
          persistedConnectionStatus: true,
        })
      },
      async () => {
        throw new Error('configmap write refused')
      }
    )

    await expect(
      redeemLlmProviderAttempt({ executionTicket: 'ticket', requestHash: CLAIMS.requestHash }, deps)
    ).rejects.toMatchObject({
      name: 'LlmProviderAttemptRedeemError',
      code: 'connection_unavailable',
    })

    expect(deps.publishAllowlist).toHaveBeenCalledTimes(1)
    expect(await mutationWriteFailures()).toBe(before + 1)
  })
})
