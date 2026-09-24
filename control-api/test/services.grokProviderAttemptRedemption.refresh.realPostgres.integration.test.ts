import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { config } from '../src/config.js'
import { initDb } from '../src/db.js'
import { deriveOAuthEncryptionKey, encryptOAuthSecret } from '../src/oauth/encryption.js'
import {
  type RedeemGrokAttemptDeps,
  redeemGrokProviderAttempt,
} from '../src/services/grokProviderAttemptRedemption.js'
import { issueRegisteredGrokExecutionTicket } from '../src/services/grokProviderAttemptTicket.js'
import {
  getSafeGrokSubscriptionConnectionById,
  insertInitialGrokSubscriptionConnection,
  loadGrokSubscriptionSecrets,
} from '../src/services/grokSubscriptionConnection.js'
import { ensureFreshGrokAccessToken } from '../src/services/grokSubscriptionOAuth.js'
import { insertLlmProviderAttempt } from '../src/services/llmProviderAttemptStore.js'
import './realPostgres.requirement.ts'

/**
 * Redemption with `ensureFreshAccessToken` wired to the real refresh path.
 * The sibling suite (services.grokProviderAttemptRedemption.realPostgres) omits
 * the refresh dependency; this one proves refresh, refresh denial and the
 * consume rollback against real row locks and transactions.
 */

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip
const ENCRYPTION_KEY_HEX = 'cd'.repeat(32)
const KEY = deriveOAuthEncryptionKey(ENCRYPTION_KEY_HEX)

function databaseUrl(baseUrl: string, database: string): string {
  const url = new URL(baseUrl)
  url.pathname = `/${database}`
  return url.toString()
}

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

/** Unsigned JWT-shaped token; the refresh path only reads `sub` for the fingerprint. */
function tokenWithSubject(subject: string, marker: string): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${part({ alg: 'none' })}.${part({ sub: subject, marker })}.sig`
}

function fingerprintOf(connectionKey: string): string {
  return createHash('sha256').update(`sub-${connectionKey}`, 'utf8').digest('hex')
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describeRealPostgres('Grok ticket redemption with token refresh on real PostgreSQL', () => {
  const database = `grok_attempt_refresh_${randomBytes(6).toString('hex')}`
  const connectionString = databaseUrl(
    adminUrl ?? `postgresql://postgres@${['127', '0', '0', '1'].join('.')}/postgres`,
    database
  )
  let adminPool: Pool
  let pool: Pool
  const previousFlag = config.grokSubscriptionEnabled
  const previousEncryptionKey = config.oauthEncryptionKey

  beforeAll(async () => {
    config.grokSubscriptionEnabled = true
    config.oauthEncryptionKey = ENCRYPTION_KEY_HEX
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`CREATE DATABASE ${quoteIdent(database)}`)
    pool = new Pool({ connectionString })
    await initDb({ connect: () => pool.connect() })
  }, 60_000)

  afterAll(async () => {
    config.grokSubscriptionEnabled = previousFlag
    config.oauthEncryptionKey = previousEncryptionKey
    await pool?.end()
    if (adminPool) {
      await adminPool
        .query(`DROP DATABASE IF EXISTS ${quoteIdent(database)}`)
        .catch(() => undefined)
      await adminPool.end()
    }
  })

  async function connect(
    connectionKey: string,
    tokens: { accessToken: string | null; accessTokenExpiresAt: Date | null }
  ) {
    return insertInitialGrokSubscriptionConnection(
      pool,
      KEY,
      {
        refreshToken: `refresh-secret-${connectionKey}`,
        accessToken: tokens.accessToken,
        accessTokenExpiresAt: tokens.accessTokenExpiresAt,
        accountFingerprint: fingerprintOf(connectionKey),
      },
      connectionKey
    )
  }

  async function issueTicket(connection: { id: string; credentialRevision: number }) {
    const attempt = await insertLlmProviderAttempt(pool, {
      callerKind: 'host',
      hostRef: 'research-host',
      invocationId: `invocation-${randomUUID()}`,
      attemptGeneration: 1,
      providerAttemptIndex: 1,
      provider: 'grok-subscription',
      model: 'grok-4.6',
      requestHash: 'd'.repeat(64),
      policyRevision: 1,
      policyHash: 'e'.repeat(64),
      budgetReservationId: 'unbudgeted',
      connectionRevision: connection.credentialRevision,
      connectionId: connection.id,
    })
    const issued = await issueRegisteredGrokExecutionTicket(pool, {
      sub: 'host/research-host',
      hostRef: attempt.hostRef,
      invocationId: attempt.invocationId,
      attemptGeneration: attempt.attemptGeneration,
      providerAttemptId: attempt.id,
      providerAttemptIndex: attempt.providerAttemptIndex,
      model: attempt.model,
      requestHash: attempt.requestHash,
      policyRevision: attempt.policyRevision,
      policyHash: attempt.policyHash,
      budgetReservationId: attempt.budgetReservationId,
      connectionRevision: attempt.connectionRevision,
      connectionId: connection.id,
    })
    return { attempt, issued }
  }

  async function ledgerState(jti: string, attemptId: string) {
    const ticket = await pool.query<{ status: string; redeemed_at: Date | null }>(
      `SELECT status, redeemed_at FROM llm_provider_attempt_tickets WHERE jti = $1`,
      [jti]
    )
    const attempt = await pool.query<{ status: string }>(
      `SELECT status FROM llm_provider_attempts WHERE id = $1`,
      [attemptId]
    )
    return {
      ticketStatus: ticket.rows[0]?.status,
      redeemedAt: ticket.rows[0]?.redeemed_at ?? null,
      attemptStatus: attempt.rows[0]?.status,
    }
  }

  /** Real refresh path bound to this database and a scripted token endpoint. */
  function realEnsureFresh(fetchFn: typeof fetch) {
    return (connectionKey?: string) =>
      ensureFreshGrokAccessToken({
        db: pool,
        encryptionKey: KEY,
        fetchFn,
        clientId: 'grok-client-test',
        enabled: true,
        connectionKey: connectionKey ?? '',
      })
  }

  function redeemDeps(
    ensureFreshAccessToken: (connectionKey?: string) => Promise<void>,
    publishAllowlist: () => Promise<void> = vi.fn(async () => {})
  ) {
    return {
      enabled: true as const,
      db: pool,
      encryptionKey: KEY,
      loadSecrets: loadGrokSubscriptionSecrets,
      getConnectionById: getSafeGrokSubscriptionConnectionById,
      ensureFreshAccessToken,
      publishAllowlist,
      withTransaction: (async <T>(work: (tx: never) => Promise<T>): Promise<T> => {
        const client = await pool.connect()
        try {
          await client.query('BEGIN')
          const result = await work(client as never)
          await client.query('COMMIT')
          return result
        } catch (error) {
          try {
            await client.query('ROLLBACK')
          } catch {
            // keep the original error
          }
          throw error
        } finally {
          client.release()
        }
      }) as RedeemGrokAttemptDeps['withTransaction'],
    }
  }

  it('refreshes an expired access token before redeeming and returns the new token', async () => {
    const connection = await connect('grok-refresh-ok', {
      accessToken: 'access-expired',
      accessTokenExpiresAt: new Date(Date.now() - 60_000),
    })
    const { attempt, issued } = await issueTicket(connection)
    const rotatedAccessToken = tokenWithSubject('sub-grok-refresh-ok', 'rotated')
    const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(String(init?.body)).toContain('grant_type=refresh_token')
      return jsonResponse(200, {
        access_token: rotatedAccessToken,
        refresh_token: 'refresh-rotated',
        expires_in: 7200,
      })
    })

    const redeemed = await redeemGrokProviderAttempt(
      { executionTicket: issued.executionTicket, requestHash: attempt.requestHash },
      redeemDeps(realEnsureFresh(fetchFn as unknown as typeof fetch))
    )

    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(redeemed.accessToken).toBe(rotatedAccessToken)
    expect(redeemed.expiryClass).toBe('upstream_managed')
    expect(JSON.stringify(redeemed)).not.toMatch(/refresh-/)
    const secrets = await loadGrokSubscriptionSecrets(pool, KEY, 'grok-refresh-ok')
    expect(secrets).toMatchObject({
      refreshToken: 'refresh-rotated',
      accessToken: rotatedAccessToken,
      credentialRevision: connection.credentialRevision,
    })
    expect(await ledgerState(issued.claims.jti, attempt.id)).toMatchObject({
      ticketStatus: 'redeemed',
      attemptStatus: 'redeemed',
    })
  })

  it('skips the token endpoint when the access token is still fresh', async () => {
    const connection = await connect('grok-refresh-fresh', {
      accessToken: 'access-fresh',
      accessTokenExpiresAt: new Date(Date.now() + 2 * 3_600_000),
    })
    const { attempt, issued } = await issueTicket(connection)
    const fetchFn = vi.fn(async () => {
      throw new Error('token endpoint must not be called')
    })
    const redeemed = await redeemGrokProviderAttempt(
      { executionTicket: issued.executionTicket, requestHash: attempt.requestHash },
      redeemDeps(realEnsureFresh(fetchFn as unknown as typeof fetch))
    )
    expect(redeemed.accessToken).toBe('access-fresh')
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('maps a rejected refresh token to no_grant and leaves the ticket issued', async () => {
    const connection = await connect('grok-refresh-denied', {
      accessToken: null,
      accessTokenExpiresAt: null,
    })
    const { attempt, issued } = await issueTicket(connection)
    const fetchFn = vi.fn(async () => jsonResponse(400, { error: 'invalid_grant' }))
    const publishAllowlist = vi.fn(async () => {})

    await expect(
      redeemGrokProviderAttempt(
        { executionTicket: issued.executionTicket, requestHash: attempt.requestHash },
        redeemDeps(realEnsureFresh(fetchFn as unknown as typeof fetch), publishAllowlist)
      )
    ).rejects.toMatchObject({ name: 'GrokProviderAttemptRedeemError', code: 'no_grant' })

    expect(fetchFn).toHaveBeenCalledTimes(1)
    // R9-19: the row below is now reauth_required, so the ConfigMap is owed a
    // republish before the redemption fails.
    expect(publishAllowlist).toHaveBeenCalledTimes(1)
    expect(await ledgerState(issued.claims.jti, attempt.id)).toEqual({
      ticketStatus: 'issued',
      redeemedAt: null,
      attemptStatus: 'authorized',
    })
    const row = await getSafeGrokSubscriptionConnectionById(pool, connection.id)
    expect(row?.status).toBe('reauth_required')
    expect(row?.refreshLockHeld).toBe(false)
  })

  it('rolls back the consume when the access token disappears after refresh, keeping the ticket redeemable', async () => {
    const connection = await connect('grok-refresh-rollback', {
      accessToken: 'access-fresh',
      accessTokenExpiresAt: null,
    })
    const { attempt, issued } = await issueTicket(connection)
    const fetchFn = vi.fn(async () => {
      throw new Error('token endpoint must not be called')
    })
    const ensureFresh = realEnsureFresh(fetchFn as unknown as typeof fetch)
    // A concurrent writer clears the access token between the refresh check and
    // the redemption transaction. Consume runs before the secrets read, so only
    // a real ROLLBACK can leave the ticket issued.
    const clearingEnsureFresh = vi.fn(async (connectionKey?: string) => {
      await ensureFresh(connectionKey)
      await pool.query(
        `UPDATE grok_subscription_connections
            SET access_token_encrypted = NULL
          WHERE id = $1`,
        [connection.id]
      )
    })

    await expect(
      redeemGrokProviderAttempt(
        { executionTicket: issued.executionTicket, requestHash: attempt.requestHash },
        redeemDeps(clearingEnsureFresh)
      )
    ).rejects.toMatchObject({ code: 'connection_unavailable' })

    expect(clearingEnsureFresh).toHaveBeenCalledWith('grok-refresh-rollback')
    expect(await ledgerState(issued.claims.jti, attempt.id)).toEqual({
      ticketStatus: 'issued',
      redeemedAt: null,
      attemptStatus: 'authorized',
    })

    await pool.query(
      `UPDATE grok_subscription_connections
          SET access_token_encrypted = $2
        WHERE id = $1`,
      [connection.id, encryptOAuthSecret(KEY, 'access-restored')]
    )
    const retried = await redeemGrokProviderAttempt(
      { executionTicket: issued.executionTicket, requestHash: attempt.requestHash },
      redeemDeps(ensureFresh)
    )
    expect(retried.accessToken).toBe('access-restored')
    expect((await ledgerState(issued.claims.jti, attempt.id)).ticketStatus).toBe('redeemed')
    await expect(
      redeemGrokProviderAttempt(
        { executionTicket: issued.executionTicket, requestHash: attempt.requestHash },
        redeemDeps(ensureFresh)
      )
    ).rejects.toMatchObject({ code: 'ticket_replayed' })
  })

  it('refuses a credential revision change between refresh and redemption without consuming', async () => {
    const connection = await connect('grok-refresh-revision', {
      accessToken: 'access-fresh',
      accessTokenExpiresAt: null,
    })
    const { attempt, issued } = await issueTicket(connection)
    const bumpingEnsureFresh = vi.fn(async () => {
      await pool.query(
        `UPDATE grok_subscription_connections
            SET credential_revision = credential_revision + 1
          WHERE id = $1`,
        [connection.id]
      )
    })
    await expect(
      redeemGrokProviderAttempt(
        { executionTicket: issued.executionTicket, requestHash: attempt.requestHash },
        redeemDeps(bumpingEnsureFresh)
      )
    ).rejects.toMatchObject({ code: 'connection_unavailable' })
    expect(await ledgerState(issued.claims.jti, attempt.id)).toMatchObject({
      ticketStatus: 'issued',
      attemptStatus: 'authorized',
    })
  })
})
