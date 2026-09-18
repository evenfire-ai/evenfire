import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

  it('maps a missing connection row to connection_unavailable instead of an unmapped error', async () => {
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
    const ensureFresh = vi.fn(async (connectionKey?: string) => {
      connection.assertGrokConnectionKey(connectionKey ?? '')
    })
    const withTransaction = vi.fn()
    await expect(
      redeemGrokProviderAttempt(
        { executionTicket: 'ticket', requestHash: CLAIMS.requestHash },
        {
          enabled: true,
          db: { query: vi.fn() },
          withTransaction: withTransaction as never,
          loadSecrets: vi.fn(),
          getConnectionById: vi.fn().mockResolvedValue(null),
          encryptionKey: Buffer.alloc(32),
          ensureFreshAccessToken: ensureFresh,
        }
      )
    ).rejects.toMatchObject({
      name: 'GrokProviderAttemptRedeemError',
      code: 'connection_unavailable',
    })
    expect(ensureFresh).not.toHaveBeenCalled()
    expect(withTransaction).not.toHaveBeenCalled()
  })
})

describe('redeemGrokProviderAttempt error-path matrix', () => {
  const ISSUED_TICKET = {
    jti: CLAIMS.jti,
    providerAttemptId: CLAIMS.providerAttemptId,
    status: 'issued' as const,
    expiresAt: new Date(Date.now() + 30_000),
    receiptHash: null,
  }

  function attemptRow(overrides: Record<string, unknown> = {}) {
    return {
      id: CLAIMS.providerAttemptId,
      provider: 'grok-subscription',
      status: 'authorized',
      connectionId: CONNECTION_ID,
      requestHash: CLAIMS.requestHash,
      model: CLAIMS.model,
      hostRef: CLAIMS.hostRef,
      invocationId: CLAIMS.invocationId,
      attemptGeneration: CLAIMS.attemptGeneration,
      policyHash: CLAIMS.policyHash,
      policyRevision: CLAIMS.policyRevision,
      budgetReservationId: CLAIMS.budgetReservationId,
      connectionRevision: CLAIMS.connectionRevision,
      ...overrides,
    }
  }

  function liveConnection(overrides: Record<string, unknown> = {}) {
    return {
      id: CONNECTION_ID,
      connectionKey: 'team-grok',
      status: 'connected',
      revokedAt: null,
      credentialRevision: CLAIMS.connectionRevision,
      ...overrides,
    }
  }

  type Scenario = {
    enabled?: boolean
    claims?: Partial<typeof CLAIMS> | null
    input?: Partial<{ requestHash: string; model: string; hostRef: string }>
    peek?: unknown
    previewAttempt?: unknown
    assigned?: unknown
    ensureFresh?: ((key?: string) => Promise<void>) | null
    locked?: unknown
    txAttempt?: unknown
    connection?: unknown
    markRedeemed?: boolean
    secrets?: unknown
  }

  function arrange(scenario: Scenario = {}) {
    vi.spyOn(ticket, 'verifyGrokExecutionTicket').mockReturnValue(
      scenario.claims === null ? null : ({ ...CLAIMS, ...scenario.claims } as typeof CLAIMS)
    )
    const peek = vi
      .spyOn(store, 'peekLlmProviderAttemptTicket')
      .mockResolvedValue(('peek' in scenario ? scenario.peek : ISSUED_TICKET) as never)
    const previewAttempt = 'previewAttempt' in scenario ? scenario.previewAttempt : attemptRow()
    const txAttempt = 'txAttempt' in scenario ? scenario.txAttempt : attemptRow()
    vi.spyOn(store, 'loadLlmProviderAttempt')
      .mockResolvedValueOnce(previewAttempt as never)
      .mockResolvedValueOnce(txAttempt as never)
    const lock = vi
      .spyOn(store, 'lockLlmProviderAttemptTicket')
      .mockResolvedValue(('locked' in scenario ? scenario.locked : ISSUED_TICKET) as never)
    const connectionById = vi
      .spyOn(connection, 'getSafeGrokSubscriptionConnectionById')
      .mockResolvedValue(
        ('connection' in scenario ? scenario.connection : liveConnection()) as never
      )
    const markRedeemed = vi
      .spyOn(store, 'markLlmProviderAttemptTicketRedeemed')
      .mockResolvedValue(scenario.markRedeemed ?? true)
    const loadSecrets = vi.fn().mockResolvedValue(
      'secrets' in scenario
        ? scenario.secrets
        : {
            refreshToken: 'refresh-secret',
            accessToken: 'access-secret',
            accessTokenExpiresAt: null,
            credentialRevision: CLAIMS.connectionRevision,
          }
    )
    const ensureFresh =
      scenario.ensureFresh === null ? undefined : vi.fn(scenario.ensureFresh ?? (async () => {}))
    const getConnectionById = vi
      .fn()
      .mockResolvedValue('assigned' in scenario ? scenario.assigned : liveConnection())
    const tx = { query: vi.fn() }
    const withTransaction = vi.fn(async (work: (db: typeof tx) => unknown) => work(tx))
    const run = () =>
      redeemGrokProviderAttempt(
        {
          executionTicket: 'ticket',
          requestHash: CLAIMS.requestHash,
          ...scenario.input,
        },
        {
          enabled: scenario.enabled ?? true,
          db: { query: vi.fn() },
          withTransaction: withTransaction as never,
          loadSecrets,
          getConnectionById,
          encryptionKey: Buffer.alloc(32),
          ...(ensureFresh ? { ensureFreshAccessToken: ensureFresh } : {}),
        }
      )
    return {
      run,
      peek,
      lock,
      connectionById,
      markRedeemed,
      loadSecrets,
      ensureFresh,
      getConnectionById,
      withTransaction,
    }
  }

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('redeems when every binding matches and never returns the refresh token', async () => {
    const h = arrange()
    const result = await h.run()
    expect(result.accessToken).toBe('access-secret')
    expect(result.expiryClass).toBe('upstream_managed')
    expect(result.transport.servedModel).toBe(CLAIMS.model)
    expect(JSON.stringify(result)).not.toContain('refresh-secret')
    expect(h.ensureFresh).toHaveBeenCalledWith('team-grok')
    expect(h.markRedeemed).toHaveBeenCalledTimes(1)
    expect(h.loadSecrets).toHaveBeenCalledWith(expect.anything(), expect.any(Buffer), 'team-grok')
  })

  it('classifies an access token expiring within the hour as short_lived', async () => {
    const h = arrange({
      secrets: {
        refreshToken: 'refresh-secret',
        accessToken: 'access-secret',
        accessTokenExpiresAt: new Date(Date.now() + 60_000),
        credentialRevision: CLAIMS.connectionRevision,
      },
    })
    await expect(h.run()).resolves.toMatchObject({ expiryClass: 'short_lived' })
  })

  it('rejects while disabled before verifying the ticket', async () => {
    const h = arrange({ enabled: false })
    await expect(h.run()).rejects.toMatchObject({ code: 'disabled' })
    expect(ticket.verifyGrokExecutionTicket).not.toHaveBeenCalled()
    expect(h.peek).not.toHaveBeenCalled()
  })

  type PreTx = [string, Scenario, string]
  const preTransaction: PreTx[] = [
    ['an unverifiable ticket', { claims: null }, 'ticket_invalid'],
    [
      'a non-Grok ticket provider',
      { claims: { provider: 'codex-subscription' as never } },
      'ticket_invalid',
    ],
    [
      'a request hash mismatch',
      { input: { requestHash: 'c'.repeat(64) } },
      'request_hash_mismatch',
    ],
    ['a model mismatch', { input: { model: 'grok-other' } }, 'ticket_invalid'],
    ['a hostRef mismatch', { input: { hostRef: 'other-host' } }, 'ticket_invalid'],
    ['an unregistered ticket', { peek: null }, 'ticket_invalid'],
    [
      'an already-redeemed ticket',
      { peek: { ...ISSUED_TICKET, status: 'redeemed' } },
      'ticket_replayed',
    ],
    ['a missing attempt', { previewAttempt: null }, 'ticket_invalid'],
    [
      'a Codex attempt row',
      { previewAttempt: attemptRow({ provider: 'codex-subscription' }) },
      'ticket_invalid',
    ],
    [
      'an attempt bound to another connection',
      { previewAttempt: attemptRow({ connectionId: '44444444-4444-4444-8444-444444444444' }) },
      'ticket_invalid',
    ],
    ['a vanished connection row', { assigned: null }, 'connection_unavailable'],
  ]

  it.each(preTransaction)(
    'rejects %s before refreshing tokens or opening the transaction',
    async (_label, scenario, code) => {
      const h = arrange(scenario)
      await expect(h.run()).rejects.toMatchObject({ name: 'GrokProviderAttemptRedeemError', code })
      expect(h.ensureFresh).not.toHaveBeenCalled()
      expect(h.withTransaction).not.toHaveBeenCalled()
      expect(h.loadSecrets).not.toHaveBeenCalled()
    }
  )

  it.each([
    ['no_grant', 'no_grant'],
    ['not_connected', 'no_grant'],
    ['reauth_required', 'no_grant'],
    ['provider_unavailable', 'provider_unavailable'],
    ['refresh_in_flight', 'connection_unavailable'],
    ['stale_revision', 'connection_unavailable'],
  ] as const)('maps refresh failure %s to %s without redeeming', async (oauthCode, code) => {
    const h = arrange({
      ensureFresh: async () => {
        throw new GrokSubscriptionOAuthError(oauthCode, 'refresh failed')
      },
    })
    await expect(h.run()).rejects.toMatchObject({ code })
    expect(h.withTransaction).not.toHaveBeenCalled()
    expect(h.markRedeemed).not.toHaveBeenCalled()
  })

  it('rethrows a non-OAuth refresh failure unchanged', async () => {
    const boom = new Error('socket hang up')
    const h = arrange({
      ensureFresh: async () => {
        throw boom
      },
    })
    await expect(h.run()).rejects.toBe(boom)
    expect(h.markRedeemed).not.toHaveBeenCalled()
  })

  const inTransaction: Array<[string, Scenario, string]> = [
    ['a ticket row that disappeared', { locked: null }, 'ticket_invalid'],
    [
      'a ticket redeemed concurrently',
      { locked: { ...ISSUED_TICKET, status: 'redeemed' } },
      'ticket_replayed',
    ],
    [
      'an expired ticket',
      { locked: { ...ISSUED_TICKET, expiresAt: new Date(Date.now() - 1) } },
      'ticket_expired',
    ],
    ['an attempt that vanished', { txAttempt: null }, 'ticket_invalid'],
    [
      'a non-authorized attempt',
      { txAttempt: attemptRow({ status: 'redeemed' }) },
      'ticket_invalid',
    ],
    [
      'a provider swap inside the transaction',
      { txAttempt: attemptRow({ provider: 'codex-subscription' }) },
      'ticket_invalid',
    ],
    ...(
      [
        ['requestHash', 'f'.repeat(64)],
        ['model', 'grok-other'],
        ['hostRef', 'other-host'],
        ['invocationId', 'invocation-2'],
        ['attemptGeneration', 2],
        ['policyHash', 'c'.repeat(64)],
        ['policyRevision', 5],
        ['budgetReservationId', 'res-other'],
        ['connectionRevision', 4],
      ] as const
    ).map(([field, value]): [string, Scenario, string] => [
      `${field} drift`,
      { txAttempt: attemptRow({ [field]: value }) },
      'no_grant',
    ]),
    ['a connection row that is gone', { connection: null }, 'connection_unavailable'],
    [
      'a connection needing reauth',
      { connection: liveConnection({ status: 'reauth_required' }) },
      'connection_unavailable',
    ],
    [
      'a revoked connection',
      { connection: liveConnection({ revokedAt: new Date() }) },
      'connection_unavailable',
    ],
    [
      'a credential revision change',
      { connection: liveConnection({ credentialRevision: CLAIMS.connectionRevision + 1 }) },
      'connection_unavailable',
    ],
  ]

  it.each(inTransaction)(
    'rejects %s before consuming the ticket',
    async (_label, scenario, code) => {
      const h = arrange(scenario)
      await expect(h.run()).rejects.toMatchObject({ name: 'GrokProviderAttemptRedeemError', code })
      expect(h.withTransaction).toHaveBeenCalledTimes(1)
      expect(h.markRedeemed).not.toHaveBeenCalled()
      expect(h.loadSecrets).not.toHaveBeenCalled()
    }
  )

  it('reports a lost consume race as ticket_replayed without loading secrets', async () => {
    const h = arrange({ markRedeemed: false })
    await expect(h.run()).rejects.toMatchObject({ code: 'ticket_replayed' })
    expect(h.loadSecrets).not.toHaveBeenCalled()
  })

  it.each([
    ['no secrets row', null],
    [
      'a null access token',
      {
        refreshToken: 'refresh-secret',
        accessToken: null,
        accessTokenExpiresAt: null,
        credentialRevision: CLAIMS.connectionRevision,
      },
    ],
  ])('throws inside the transaction for %s so the consume rolls back', async (_label, secrets) => {
    const h = arrange({ secrets })
    let rolledBack = false
    h.withTransaction.mockImplementation(async work => {
      try {
        return await work({ query: vi.fn() })
      } catch (err) {
        rolledBack = true
        throw err
      }
    })
    await expect(h.run()).rejects.toMatchObject({ code: 'connection_unavailable' })
    expect(h.markRedeemed).toHaveBeenCalledTimes(1)
    expect(rolledBack).toBe(true)
  })
})
