/**
 * #753: a Codex refresh token the vendor rejects with `invalid_grant` marks the
 * connection `reauth_required`, the way the Grok broker already does.
 *
 * Everything below the OpenAI network boundary is real: the refresh lock, the
 * revision fence, the status write, the catalog sync result and the cron tick.
 * Only `fetchFn` (the token endpoint), the catalog transport and the ConfigMap
 * writer are doubled, because they are systems outside this process.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import { Pool } from 'pg'
import { initDb } from '../src/db.js'
import { deriveOAuthEncryptionKey } from '../src/oauth/encryption.js'
import type { CodexCatalogTransport } from '../src/services/codexSubscriptionCatalog.js'
import {
  acquireCodexSubscriptionRefreshLock,
  getSafeCodexSubscriptionConnection,
  insertInitialCodexSubscriptionConnection,
  listLiveCodexSubscriptionConnections,
  loadCodexSubscriptionSecrets,
  updateCodexAccessTokenInPlace,
} from '../src/services/codexSubscriptionConnection.js'
import {
  CODEX_OAUTH_TOKEN_URL,
  type CodexOAuthDeps,
  CodexSubscriptionOAuthError,
  ensureFreshCodexAccessToken,
  refreshCodexSubscriptionConnection,
  runCodexCatalogSync,
} from '../src/services/codexSubscriptionOAuth.js'
import {
  type AllowedModelsConfigMapMaterializer,
  syncOutcomeChangedTheRow,
} from '../src/services/llmAllowedModelsConfigMap.js'
import {
  type SubscriptionBrokerPort,
  reconcileSubscriptionCatalogs,
} from '../src/services/subscriptionCatalogSyncCron.js'
import './realPostgres.requirement.ts'

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip
const KEY = deriveOAuthEncryptionKey('ab'.repeat(32))

function databaseUrl(baseUrl: string, database: string): string {
  const url = new URL(baseUrl)
  url.pathname = `/${database}`
  return url.toString()
}

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response
}

/**
 * The token endpoint answers every refresh with `status` / `body`. `beforeReply`
 * runs while the refresh lock is held, which is where a concurrent writer can
 * move the revision or the lock under the exchange.
 */
function tokenEndpoint(
  status: number,
  body: Record<string, unknown>,
  beforeReply: () => Promise<void> = async () => {}
) {
  return vi.fn(async (url: string | URL) => {
    if (String(url) !== CODEX_OAUTH_TOKEN_URL) return jsonResponse(404, {})
    await beforeReply()
    return jsonResponse(status, body)
  })
}

function readyTransport(): { transport: CodexCatalogTransport; calls: number[] } {
  const calls: number[] = []
  return {
    calls,
    transport: {
      listModels: async () => {
        calls.push(1)
        return { outcome: 'ready', models: [{ model: 'gpt-5' }] }
      },
    },
  }
}

describeRealPostgres('Codex refresh rejected by the vendor on real PostgreSQL (#753)', () => {
  const database = `codex_refresh_rejected_${randomBytes(6).toString('hex')}`
  const connectionString = databaseUrl(
    adminUrl ?? `postgresql://postgres@${['127', '0', '0', '1'].join('.')}/postgres`,
    database
  )
  let adminPool: Pool
  let pool: Pool

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`CREATE DATABASE ${quoteIdent(database)}`)
    pool = new Pool({ connectionString })
    await initDb({ connect: () => pool.connect() })
  }, 60_000)

  afterAll(async () => {
    await pool?.end()
    if (adminPool) {
      await adminPool
        .query(`DROP DATABASE IF EXISTS ${quoteIdent(database)}`)
        .catch(() => undefined)
      await adminPool.end()
    }
  })

  /**
   * A connected grant with no access token, so every ensure-fresh call goes to
   * the token endpoint instead of returning early.
   */
  async function seedConnected(connectionKey: string): Promise<void> {
    await insertInitialCodexSubscriptionConnection(
      pool,
      KEY,
      {
        refreshToken: `refresh-${connectionKey}`,
        accountFingerprint: createHash('sha256').update(connectionKey, 'utf8').digest('hex'),
      },
      connectionKey
    )
  }

  function deps(connectionKey: string, fetchFn: typeof fetch): CodexOAuthDeps {
    return {
      db: pool,
      encryptionKey: KEY,
      fetchFn,
      clientId: 'app_test_client',
      redirectUri: 'https://control.example/api/v1/auth/codex-subscription/callback',
      enabled: true,
      connectionKey,
    }
  }

  function codexPort(
    transport: CodexCatalogTransport,
    fetchFn: typeof fetch,
    syncedKeys: string[]
  ): SubscriptionBrokerPort {
    return {
      broker: 'codex-subscription',
      enabled: true,
      listConnections: () => listLiveCodexSubscriptionConnections(pool),
      syncCatalog: key => {
        syncedKeys.push(key)
        return runCodexCatalogSync(deps(key, fetchFn), key, transport)
      },
    }
  }

  async function statusOf(connectionKey: string): Promise<string | undefined> {
    return (await getSafeCodexSubscriptionConnection(pool, connectionKey))?.status
  }

  it('T-753a a 400 invalid_grant on ensure-fresh marks the row reauth_required and says so', async () => {
    const key = 'codex-753a'
    await seedConnected(key)
    const fetchFn = tokenEndpoint(400, { error: 'invalid_grant' })

    const failure = await ensureFreshCodexAccessToken(deps(key, fetchFn as typeof fetch)).then(
      () => null,
      (err: unknown) => err
    )

    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(failure).toBeInstanceOf(CodexSubscriptionOAuthError)
    expect(failure).toMatchObject({ code: 'reauth_required', persistedConnectionStatus: true })
    expect(await statusOf(key)).toBe('reauth_required')
  })

  it('T-753a a 401 invalid_grant on the manual refresh marks the row the same way', async () => {
    const key = 'codex-753a-manual'
    await seedConnected(key)
    const fetchFn = tokenEndpoint(401, { error: { code: 'invalid_grant' } })

    const failure = await refreshCodexSubscriptionConnection(
      deps(key, fetchFn as typeof fetch)
    ).then(
      () => null,
      (err: unknown) => err
    )

    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(failure).toMatchObject({ code: 'reauth_required', persistedConnectionStatus: true })
    expect(await statusOf(key)).toBe('reauth_required')
  })

  it('T-753b runCodexCatalogSync reports the written row as persisted, so a republish is owed', async () => {
    const key = 'codex-753b'
    await seedConnected(key)
    const fetchFn = tokenEndpoint(400, { error: 'invalid_grant' })
    const { transport, calls } = readyTransport()

    const synced = await runCodexCatalogSync(deps(key, fetchFn as typeof fetch), key, transport)

    expect(synced).toMatchObject({
      ok: false,
      catalogStatus: 'never_synced',
      reason: 'reauth_required',
      persisted: true,
    })
    expect(syncOutcomeChangedTheRow(synced)).toBe(true)
    // Liveness witness for the untouched catalog: the refresh really ran.
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(calls).toEqual([])
  })

  it('T-753c the cron marks the rejected grant once and skips it on the next tick', async () => {
    const key = 'codex-753c'
    await seedConnected(key)
    const fetchFn = tokenEndpoint(400, { error: 'invalid_grant' })
    const { transport } = readyTransport()
    const published: number[] = []
    const materializer: AllowedModelsConfigMapMaterializer = {
      materialize: async () => {
        published.push(Date.now())
      },
    }

    // Earlier cases in this file leave rows behind, so the expected counts are
    // read from the database rather than assumed.
    const live = await listLiveCodexSubscriptionConnections(pool)
    const connectedBefore = live
      .filter(row => row.status === 'connected')
      .map(row => row.connectionKey)
    expect(connectedBefore).toContain(key)

    const firstKeys: string[] = []
    const first = await reconcileSubscriptionCatalogs({
      brokers: [codexPort(transport, fetchFn as typeof fetch, firstKeys)],
      materializer,
    })
    const callsAfterFirstTick = fetchFn.mock.calls.length
    const publishesAfterFirstTick = published.length

    const secondKeys: string[] = []
    const second = await reconcileSubscriptionCatalogs({
      brokers: [codexPort(transport, fetchFn as typeof fetch, secondKeys)],
      materializer,
    })

    // Tick 1: every connected grant reached the token endpoint once, and each
    // rejection is a recorded change rather than a failure.
    expect(firstKeys).toEqual(connectedBefore)
    expect(callsAfterFirstTick).toBe(connectedBefore.length)
    expect(first).toMatchObject({
      synced: 0,
      degraded: connectedBefore.length,
      failed: 0,
      skipped: live.length - connectedBefore.length,
    })
    expect(publishesAfterFirstTick).toBe(1)
    expect(await statusOf(key)).toBe('reauth_required')
    // The cron publishes on every tick by design (subscriptionCatalogSyncCron.ts),
    // so tick 2 adds exactly one more.
    expect(published).toHaveLength(2)
    // Tick 2 listed every grant (all of them count as skipped) and sent no dead
    // refresh token again.
    expect(second).toMatchObject({ synced: 0, degraded: 0, failed: 0, skipped: live.length })
    expect(secondKeys).toEqual([])
    expect(fetchFn.mock.calls.length).toBe(callsAfterFirstTick)
  })

  it('T-753d invalid_grant after the revision moved is a lost race and leaves the row connected', async () => {
    const key = 'codex-753d-revision'
    await seedConnected(key)
    const fetchFn = tokenEndpoint(400, { error: 'invalid_grant' }, async () => {
      await pool.query(
        `UPDATE codex_subscription_connections
            SET credential_revision = credential_revision + 1
          WHERE connection_key = $1`,
        [key]
      )
    })

    const failure = await ensureFreshCodexAccessToken(deps(key, fetchFn as typeof fetch)).then(
      () => null,
      (err: unknown) => err
    )

    // `stale_revision` only comes out of the invalid_grant branch here, so it
    // is also the witness that the branch read the fence.
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(failure).toMatchObject({ code: 'stale_revision' })
    expect(await statusOf(key)).toBe('connected')
  })

  it('T-753d invalid_grant after the refresh lock was lost is a lost race too', async () => {
    const key = 'codex-753d-lock'
    await seedConnected(key)
    const fetchFn = tokenEndpoint(400, { error: 'invalid_grant' }, async () => {
      await pool.query(
        `UPDATE codex_subscription_connections
            SET refresh_lock_token = NULL,
                refresh_lock_expires_at = NULL
          WHERE connection_key = $1`,
        [key]
      )
    })

    const failure = await ensureFreshCodexAccessToken(deps(key, fetchFn as typeof fetch)).then(
      () => null,
      (err: unknown) => err
    )

    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(failure).toMatchObject({ code: 'stale_revision' })
    expect(await statusOf(key)).toBe('connected')
  })

  it('T-753j invalid_grant after another holder took the lock and refreshed in place is a lost race', async () => {
    const key = 'codex-753j-takeover'
    await seedConnected(key)
    const takeover: { locked?: boolean; revision?: number } = {}
    // Our lock expires mid-exchange; another holder acquires it with its own
    // token and rotates the refresh token in place. In-place refresh does not
    // bump credential_revision, so only the lock token tells the two apart.
    const fetchFn = tokenEndpoint(400, { error: 'invalid_grant' }, async () => {
      await pool.query(
        `UPDATE codex_subscription_connections
            SET refresh_lock_expires_at = now() - interval '1 second'
          WHERE connection_key = $1`,
        [key]
      )
      const locked = await acquireCodexSubscriptionRefreshLock(pool, 'other-holder', 30_000, key)
      const before = await loadCodexSubscriptionSecrets(pool, KEY, key)
      if (!before) throw new Error('seeded grant disappeared before the takeover')
      await updateCodexAccessTokenInPlace(
        pool,
        KEY,
        before.credentialRevision,
        { accessToken: 'access-other-holder', refreshToken: 'refresh-other-holder' },
        key
      )
      takeover.locked = locked
      takeover.revision = before.credentialRevision
    })

    const failure = await ensureFreshCodexAccessToken(deps(key, fetchFn as typeof fetch)).then(
      () => null,
      (err: unknown) => err
    )
    const after = await loadCodexSubscriptionSecrets(pool, KEY, key)

    // Liveness witness: the exchange ran, the other holder really took the
    // lock, and its write is the one stored, at the revision we also read.
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(takeover.locked).toBe(true)
    expect(typeof takeover.revision).toBe('number')
    expect(after).toMatchObject({
      refreshToken: 'refresh-other-holder',
      accessToken: 'access-other-holder',
      credentialRevision: takeover.revision,
    })
    expect(failure).toBeInstanceOf(CodexSubscriptionOAuthError)
    expect(failure).toMatchObject({ code: 'stale_revision', persistedConnectionStatus: false })
    expect(await statusOf(key)).toBe('connected')
  })

  it('T-753h a revoke landing between the fence check and the mark is a lost race, not a persisted reauth', async () => {
    const key = 'codex-753h-revoked'
    await seedConnected(key)
    const fetchFn = tokenEndpoint(400, { error: 'invalid_grant' })
    // The fence reads pass; the revoke lands just before the fenced UPDATE, so
    // the mark matches no row. Only the status write is intercepted; every other
    // statement runs unchanged against the real database.
    let markAttempts = 0
    const racingDb = {
      query: async (text: string, values?: unknown[]) => {
        if (text.includes("SET status = 'reauth_required'")) {
          markAttempts += 1
          await pool.query(
            `UPDATE codex_subscription_connections
                SET revoked_at = now()
              WHERE connection_key = $1`,
            [key]
          )
        }
        return pool.query(text, values)
      },
    }

    const failure = await ensureFreshCodexAccessToken({
      ...deps(key, fetchFn as typeof fetch),
      db: racingDb,
    }).then(
      () => null,
      (err: unknown) => err
    )

    // Liveness witness: the exchange ran and the mark was attempted, so the
    // outcome below is the empty UPDATE and not an earlier exit.
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(markAttempts).toBe(1)
    expect(failure).toBeInstanceOf(CodexSubscriptionOAuthError)
    expect(failure).toMatchObject({ code: 'stale_revision', persistedConnectionStatus: false })
    expect(await statusOf(key)).not.toBe('reauth_required')
  })

  it('T-753e a 503 from the token endpoint stays provider_unavailable and leaves the row connected', async () => {
    const key = 'codex-753e-503'
    await seedConnected(key)
    const fetchFn = tokenEndpoint(503, { error: 'invalid_grant' })

    const failure = await ensureFreshCodexAccessToken(deps(key, fetchFn as typeof fetch)).then(
      () => null,
      (err: unknown) => err
    )

    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(failure).toMatchObject({ code: 'provider_unavailable' })
    expect(failure).not.toMatchObject({ persistedConnectionStatus: true })
    expect(await statusOf(key)).toBe('connected')
  })

  it('T-753e a 400 with another error code stays provider_unavailable', async () => {
    const key = 'codex-753e-other'
    await seedConnected(key)
    const fetchFn = tokenEndpoint(400, { error: 'invalid_request' })

    const failure = await ensureFreshCodexAccessToken(deps(key, fetchFn as typeof fetch)).then(
      () => null,
      (err: unknown) => err
    )

    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(failure).toMatchObject({ code: 'provider_unavailable' })
    expect(await statusOf(key)).toBe('connected')
  })

  /**
   * The official Codex client treats a refresh as permanent on any 401, on the
   * three refresh-token codes at any status (case-insensitive), and on a 400
   * `invalid_grant` (`classify_refresh_token_failure` in openai/codex
   * `codex-rs/login/src/auth/manager.rs`). The body is the shape the token
   * endpoint returns for these codes.
   */
  function upstreamRefreshError(code: string): Record<string, unknown> {
    return {
      error: {
        message: 'Your refresh token could not be used to obtain a new access token.',
        type: 'invalid_request_error',
        code,
      },
    }
  }

  it.each([
    [401, 'refresh_token_expired', 'codex-753i-401-expired'],
    [401, 'refresh_token_reused', 'codex-753i-401-reused'],
    [401, 'refresh_token_invalidated', 'codex-753i-401-invalidated'],
    [400, 'refresh_token_expired', 'codex-753i-400-expired'],
    [400, 'refresh_token_reused', 'codex-753i-400-reused'],
    [400, 'refresh_token_invalidated', 'codex-753i-400-invalidated'],
    [400, 'REFRESH_TOKEN_REUSED', 'codex-753i-400-reused-upper'],
  ])('T-753i a %i with code %s marks the row reauth_required', async (status, code, key) => {
    await seedConnected(key)
    const fetchFn = tokenEndpoint(status, upstreamRefreshError(code))

    const failure = await ensureFreshCodexAccessToken(deps(key, fetchFn as typeof fetch)).then(
      () => null,
      (err: unknown) => err
    )

    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(failure).toBeInstanceOf(CodexSubscriptionOAuthError)
    expect(failure).toMatchObject({ code: 'reauth_required', persistedConnectionStatus: true })
    expect(await statusOf(key)).toBe('reauth_required')
  })

  it('T-753i a bare 401 with no error code marks the row reauth_required', async () => {
    const key = 'codex-753i-bare-401'
    await seedConnected(key)
    const fetchFn = tokenEndpoint(401, {})

    const failure = await ensureFreshCodexAccessToken(deps(key, fetchFn as typeof fetch)).then(
      () => null,
      (err: unknown) => err
    )

    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(failure).toMatchObject({ code: 'reauth_required', persistedConnectionStatus: true })
    expect(await statusOf(key)).toBe('reauth_required')
  })

  it('T-753i a 400 INVALID_GRANT in another case is the same permanent rejection', async () => {
    const key = 'codex-753i-400-invalid-grant-upper'
    await seedConnected(key)
    const fetchFn = tokenEndpoint(400, upstreamRefreshError('INVALID_GRANT'))

    const failure = await ensureFreshCodexAccessToken(deps(key, fetchFn as typeof fetch)).then(
      () => null,
      (err: unknown) => err
    )

    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(failure).toMatchObject({ code: 'reauth_required', persistedConnectionStatus: true })
    expect(await statusOf(key)).toBe('reauth_required')
  })

  it('T-753i control: a 400 with an unrelated code in the upstream shape stays provider_unavailable', async () => {
    const key = 'codex-753i-400-unrelated'
    await seedConnected(key)
    const fetchFn = tokenEndpoint(400, upstreamRefreshError('unsupported_grant_type'))

    const failure = await ensureFreshCodexAccessToken(deps(key, fetchFn as typeof fetch)).then(
      () => null,
      (err: unknown) => err
    )

    // Liveness witness: the exchange reached the token endpoint once and the
    // row is read back as present, so "connected" is not an absent row.
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(failure).toMatchObject({ code: 'provider_unavailable' })
    expect(failure).not.toMatchObject({ persistedConnectionStatus: true })
    expect(await statusOf(key)).toBe('connected')
  })
})
