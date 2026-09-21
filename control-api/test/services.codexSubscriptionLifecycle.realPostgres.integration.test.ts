import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { Pool } from 'pg'
import { type DbClient, initDb } from '../src/db.js'
import { deriveOAuthEncryptionKey } from '../src/oauth/encryption.js'
import {
  type CodexCatalogTransport,
  syncCodexSubscriptionCatalog,
} from '../src/services/codexSubscriptionCatalog.js'
import {
  getSafeCodexSubscriptionConnection,
  insertInitialCodexSubscriptionConnection,
} from '../src/services/codexSubscriptionConnection.js'
import {
  CODEX_OAUTH_DEVICE_TOKEN_URL,
  CODEX_OAUTH_DEVICE_USERCODE_URL,
  CODEX_OAUTH_REVOKE_URL,
  CODEX_OAUTH_TOKEN_URL,
  type CodexOAuthDeps,
  handleCodexBrowserCallback,
  pollCodexDevice,
  revokeCodexSubscription,
  startCodexBrowserConnect,
  startCodexDeviceConnect,
} from '../src/services/codexSubscriptionOAuth.js'
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

function idTokenFor(subject: string): string {
  return `hdr.${Buffer.from(JSON.stringify({ sub: subject })).toString('base64url')}.sig`
}

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response
}

/**
 * Simulated ChatGPT device/browser authorization provider. Device polls
 * complete immediately; the authorization code carries the account subject so
 * a test chooses which account each flow grants.
 */
function simulatedCodexProvider(
  options: {
    subjectFor?: (deviceAuthId: string) => string
    beforeTokenExchange?: () => Promise<void>
  } = {}
): typeof fetch {
  let issued = 0
  return (async (url: string | URL, init?: RequestInit) => {
    const target = String(url)
    if (target === CODEX_OAUTH_DEVICE_USERCODE_URL) {
      issued += 1
      return jsonResponse(200, {
        device_auth_id: `deviceauth-${issued}-${randomBytes(4).toString('hex')}`,
        user_code: 'ABCD-EFGH',
        interval: 5,
        expires_in: 900,
      })
    }
    if (target === CODEX_OAUTH_DEVICE_TOKEN_URL) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { device_auth_id?: string }
      const deviceAuthId = body.device_auth_id ?? 'unknown'
      return jsonResponse(200, {
        authorization_code: `authz:${options.subjectFor?.(deviceAuthId) ?? `subject-${deviceAuthId}`}`,
        code_verifier: 'pkce-from-poll',
      })
    }
    if (target === CODEX_OAUTH_TOKEN_URL) {
      await options.beforeTokenExchange?.()
      const form = new URLSearchParams(String(init?.body ?? ''))
      const code = form.get('code') ?? 'authz:subject-browser'
      const subject = code.startsWith('authz:') ? code.slice('authz:'.length) : code
      return jsonResponse(200, {
        access_token: `access-${randomBytes(4).toString('hex')}`,
        refresh_token: `refresh-${randomBytes(4).toString('hex')}`,
        expires_in: 3600,
        id_token: idTokenFor(subject),
      })
    }
    if (target === CODEX_OAUTH_REVOKE_URL) return jsonResponse(200, {})
    return jsonResponse(404, {})
  }) as typeof fetch
}

describeRealPostgres('Codex subscription grant lifecycle on real PostgreSQL', () => {
  const database = `codex_lifecycle_${randomBytes(6).toString('hex')}`
  let adminPool: Pool
  let pool: Pool

  function oauthDeps(
    connectionKey: string,
    fetchFn: typeof fetch = simulatedCodexProvider(),
    db: DbClient = pool
  ): CodexOAuthDeps {
    return {
      db,
      encryptionKey: KEY,
      fetchFn,
      clientId: 'app_test_client',
      redirectUri: 'https://control.example/api/v1/auth/codex-subscription/callback',
      enabled: true,
      connectionKey,
    }
  }

  async function rowsForKey(connectionKey: string) {
    const result = await pool.query<{ id: string; status: string; revoked_at: Date | null }>(
      `SELECT id, status, revoked_at
         FROM codex_subscription_connections
        WHERE connection_key = $1
        ORDER BY created_at ASC`,
      [connectionKey]
    )
    return result.rows
  }

  async function stateStatus(state: string): Promise<string | undefined> {
    const result = await pool.query<{ status: string }>(
      `SELECT status FROM codex_subscription_oauth_states WHERE state = $1`,
      [state]
    )
    return result.rows[0]?.status
  }

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`CREATE DATABASE ${quoteIdent(database)}`)
    pool = new Pool({ connectionString: databaseUrl(adminUrl!, database) })
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

  for (const key of ['deployment-default', 'team-codex-reconnect']) {
    it(`revoke cancels pending flows for ${key}, and a NEW device flow reconnects the same key`, async () => {
      const sameAccount = simulatedCodexProvider({ subjectFor: () => `acct-${key}` })
      const first = await startCodexDeviceConnect(oauthDeps(key, sameAccount), 'connect')
      await expect(
        pollCodexDevice(oauthDeps(key, sameAccount), first.state)
      ).resolves.toMatchObject({ status: 'connected' })

      const pendingDevice = await startCodexDeviceConnect(oauthDeps(key, sameAccount), 'reconnect')
      const pendingBrowser = await startCodexBrowserConnect(
        oauthDeps(key, sameAccount),
        'reconnect'
      )
      const revoked = await revokeCodexSubscription(oauthDeps(key, sameAccount))
      expect(revoked.status).toBe('revoked')
      expect(await stateStatus(pendingDevice.state)).toBe('cancelled')
      expect(await stateStatus(pendingBrowser.state)).toBe('cancelled')
      await expect(
        pollCodexDevice(oauthDeps(key, sameAccount), pendingDevice.state)
      ).rejects.toMatchObject({ code: 'state_replayed' })
      expect((await rowsForKey(key)).filter(row => row.revoked_at === null)).toHaveLength(0)

      // Codex keys are NOT terminal: a flow started after the revoke reconnects
      // the same key (and the same ChatGPT account) as a fresh live row.
      const reconnect = await startCodexDeviceConnect(oauthDeps(key, sameAccount), 'connect')
      const connected = await pollCodexDevice(oauthDeps(key, sameAccount), reconnect.state)
      expect(connected).toMatchObject({ status: 'connected' })
      const rows = await rowsForKey(key)
      expect(rows).toHaveLength(2)
      expect(rows[0]).toMatchObject({ status: 'revoked' })
      expect(rows[1]).toMatchObject({ status: 'connected', revoked_at: null })
      expect(await getSafeCodexSubscriptionConnection(pool, key)).toMatchObject({
        id: rows[1]!.id,
        status: 'connected',
      })
    })
  }

  it('a browser completion whose state predates a revoke cannot revive the key', async () => {
    const key = 'team-codex-browser-race'
    await insertInitialCodexSubscriptionConnection(
      pool,
      KEY,
      { refreshToken: 'refresh-browser-race', accountFingerprint: 'fp-browser-race' },
      key
    )
    // The revoke lands after the callback consumed its state and before the
    // grant is persisted (the provider's token exchange sits in between).
    const fetchFn = simulatedCodexProvider({
      beforeTokenExchange: async () => {
        await revokeCodexSubscription(oauthDeps(key))
      },
    })
    const started = await startCodexBrowserConnect(oauthDeps(key, fetchFn), 'reconnect')
    await expect(
      handleCodexBrowserCallback(oauthDeps(key, fetchFn), {
        code: 'authz:acct-browser-race',
        state: started.state,
      })
    ).rejects.toMatchObject({ code: 'state_cancelled' })
    expect(await stateStatus(started.state)).toBe('consumed')
    const rows = await rowsForKey(key)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ status: 'revoked' })
    expect(await getSafeCodexSubscriptionConnection(pool, key)).toBeNull()
  })

  it('a device completion that consumed its state before a revoke cannot revive the key', async () => {
    const key = 'team-codex-device-race'
    await insertInitialCodexSubscriptionConnection(
      pool,
      KEY,
      { refreshToken: 'refresh-device-race', accountFingerprint: 'fp-device-race' },
      key
    )
    let revokeRan = false
    const revokeAfterConsume: DbClient = {
      query: async (text, values) => {
        const result = await pool.query(text, values)
        if (!revokeRan && /SET status = 'consumed'/.test(text)) {
          revokeRan = true
          await revokeCodexSubscription(oauthDeps(key))
        }
        return result
      },
    }
    const started = await startCodexDeviceConnect(oauthDeps(key), 'reconnect')
    await expect(
      pollCodexDevice(oauthDeps(key, simulatedCodexProvider(), revokeAfterConsume), started.state)
    ).rejects.toMatchObject({ code: 'state_cancelled' })
    expect(revokeRan).toBe(true)
    const rows = await rowsForKey(key)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ status: 'revoked' })
  })

  it('parallel first grants for one key: one connects and the loser gets stale_revision', async () => {
    const key = 'team-codex-first-grant-race'
    const held: Array<() => void> = []
    // Hold each first-grant INSERT until both completions reached it, so both
    // observed "no live row" before either wrote.
    const gatedDb: DbClient = {
      query: async (text, values) => {
        if (text.includes('INSERT INTO codex_subscription_connections')) {
          await new Promise<void>(resolve => {
            held.push(resolve)
            if (held.length === 2) for (const release of held) release()
          })
        }
        return pool.query(text, values)
      },
    }
    const first = await startCodexDeviceConnect(oauthDeps(key), 'connect')
    const second = await startCodexDeviceConnect(oauthDeps(key), 'connect')
    const results = await Promise.allSettled([
      pollCodexDevice(oauthDeps(key, simulatedCodexProvider(), gatedDb), first.state),
      pollCodexDevice(oauthDeps(key, simulatedCodexProvider(), gatedDb), second.state),
    ])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    )
    expect(rejected).toHaveLength(1)
    expect(rejected[0]?.reason).toMatchObject({ code: 'stale_revision' })
    const rows = await rowsForKey(key)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ status: 'connected', revoked_at: null })
  })

  it('a catalog failure mid-sync leaves readiness, revision and model rows unchanged', async () => {
    const key = 'team-codex-catalog'
    const created = await insertInitialCodexSubscriptionConnection(
      pool,
      KEY,
      { refreshToken: 'refresh-catalog', accessToken: 'access', accountFingerprint: 'fp-catalog' },
      key
    )
    const failing: CodexCatalogTransport = {
      listModels: async () => ({
        outcome: 'ready',
        // INTEGER overflow fails the second model INSERT after readiness was recorded.
        models: [
          { model: 'codex-catalog-ok' },
          { model: 'codex-catalog-bad', contextWindowTokens: 3_000_000_000 },
        ],
      }),
    }
    await expect(
      syncCodexSubscriptionCatalog(pool, failing, 'access', { connectionKey: key })
    ).rejects.toThrow()
    expect(await getSafeCodexSubscriptionConnection(pool, key)).toMatchObject({
      catalogStatus: 'never_synced',
      catalogRevision: created.catalogRevision,
      catalogSyncedAt: null,
    })
    const models = await pool.query(
      `SELECT model FROM codex_catalog_models WHERE connection_id = $1`,
      [created.id]
    )
    expect(models.rows).toEqual([])
    const union = await pool.query(
      `SELECT model FROM llm_allowed_models WHERE provider = 'codex-subscription' AND model = $1`,
      ['codex-catalog-ok']
    )
    expect(union.rows).toEqual([])

    const healthy = await syncCodexSubscriptionCatalog(
      pool,
      { listModels: async () => ({ outcome: 'ready', models: [{ model: 'codex-catalog-ok' }] }) },
      'access',
      { connectionKey: key }
    )
    expect(healthy.connection).toMatchObject({
      catalogStatus: 'ready',
      catalogRevision: created.catalogRevision + 1,
    })
    expect(healthy.added).toBe(1)
  })
})
