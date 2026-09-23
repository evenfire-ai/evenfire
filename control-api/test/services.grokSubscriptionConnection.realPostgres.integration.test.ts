import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { Pool } from 'pg'
import { type DbClient, initDb } from '../src/db.js'
import { deriveOAuthEncryptionKey } from '../src/oauth/encryption.js'
import {
  type GrokCatalogTransport,
  type GrokDiscoveredModel,
  type GrokTransactionRunner,
  syncGrokSubscriptionCatalog,
} from '../src/services/grokSubscriptionCatalog.js'
import {
  GrokSubscriptionConnectionKeyConflictError,
  acquireGrokSubscriptionRefreshLock,
  createNamedGrokSubscriptionConnection,
  getSafeGrokSubscriptionConnection,
  insertInitialGrokSubscriptionConnection,
  releaseGrokSubscriptionRefreshLock,
} from '../src/services/grokSubscriptionConnection.js'
import {
  GROK_OAUTH_DEVICE_URL,
  GROK_OAUTH_REVOKE_URL,
  GROK_OAUTH_TOKEN_URL,
  type GrokOAuthDeps,
  pollGrokDevice,
  revokeGrokSubscription,
  startGrokDeviceConnect,
} from '../src/services/grokSubscriptionOAuth.js'
import { insertGrokSubscriptionOAuthState } from '../src/services/grokSubscriptionOAuthState.js'
import { applyGrokSubscriptionTerminalConnectionKeySchema } from '../src/services/grokSubscriptionSchema.js'
import { insertLlmProviderAttempt } from '../src/services/llmProviderAttemptStore.js'
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
 * Simulated xAI device-authorization provider. Every device code completes
 * immediately with a subject derived from the code, so parallel flows carry
 * distinct account fingerprints.
 */
function simulatedGrokProvider(): typeof fetch {
  let issued = 0
  return (async (url: string | URL, init?: RequestInit) => {
    const target = String(url)
    const form = new URLSearchParams(String(init?.body ?? ''))
    if (target === GROK_OAUTH_DEVICE_URL) {
      issued += 1
      return jsonResponse(200, {
        device_code: `device-code-${issued}-${randomBytes(4).toString('hex')}`,
        user_code: 'ABCD-EFGH',
        verification_uri: 'https://auth.x.ai/activate',
        expires_in: 900,
        interval: 5,
      })
    }
    if (target === GROK_OAUTH_TOKEN_URL) {
      const deviceCode = form.get('device_code') ?? 'refresh'
      return jsonResponse(200, {
        access_token: `access-${deviceCode}`,
        refresh_token: `refresh-${deviceCode}`,
        expires_in: 3600,
        id_token: idTokenFor(`subject-${deviceCode}`),
      })
    }
    if (target === GROK_OAUTH_REVOKE_URL) return jsonResponse(200, {})
    return jsonResponse(404, {})
  }) as typeof fetch
}

describeRealPostgres('Grok subscription connection on real PostgreSQL', () => {
  const database = `grok_subscription_${randomBytes(6).toString('hex')}`
  const connectionString = databaseUrl(
    adminUrl ?? `postgresql://postgres@${['127', '0', '0', '1'].join('.')}/postgres`,
    database
  )
  let adminPool: Pool
  let pool: Pool

  const poolTransaction: GrokTransactionRunner = async work => {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const result = await work(client)
      await client.query('COMMIT')
      return result
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw err
    } finally {
      client.release()
    }
  }

  function oauthDeps(connectionKey: string, db: DbClient = pool): GrokOAuthDeps {
    return {
      db,
      encryptionKey: KEY,
      fetchFn: simulatedGrokProvider(),
      clientId: 'b1a00492-073a-47ea-816f-4c329264a828',
      enabled: true,
      connectionKey,
      withTransaction: poolTransaction,
    }
  }

  async function rowsForKey(connectionKey: string) {
    const result = await pool.query<{ id: string; status: string; revoked_at: Date | null }>(
      `SELECT id, status, revoked_at
         FROM grok_subscription_connections
        WHERE connection_key = $1`,
      [connectionKey]
    )
    return result.rows
  }

  async function stateStatus(state: string): Promise<string | undefined> {
    const result = await pool.query<{ status: string }>(
      `SELECT status FROM grok_subscription_oauth_states WHERE state = $1`,
      [state]
    )
    return result.rows[0]?.status
  }

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

  it('creates Grok grant tables', async () => {
    const tables = await pool.query<{ table_name: string }>(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = ANY($1::text[])
        ORDER BY table_name`,
      [['grok_catalog_models', 'grok_subscription_connections', 'grok_subscription_oauth_states']]
    )
    expect(tables.rows.map(row => row.table_name)).toEqual([
      'grok_catalog_models',
      'grok_subscription_connections',
      'grok_subscription_oauth_states',
    ])
  })

  it('rejects reserved Grok connection keys', async () => {
    await expect(
      insertInitialGrokSubscriptionConnection(
        pool,
        KEY,
        { refreshToken: 'refresh', accountFingerprint: 'fp' },
        'unassigned'
      )
    ).rejects.toThrow()
    await expect(
      insertInitialGrokSubscriptionConnection(
        pool,
        KEY,
        { refreshToken: 'refresh', accountFingerprint: 'fp' },
        'deployment-default'
      )
    ).rejects.toThrow()
  })

  it('lets only one concurrent refresh lock win and reclaims after expiry', async () => {
    const created = await insertInitialGrokSubscriptionConnection(
      pool,
      KEY,
      { refreshToken: 'refresh-lock', accountFingerprint: 'fp-lock' },
      'team-grok-lock'
    )
    expect(created.connectionKey).toBe('team-grok-lock')
    const [first, second] = await Promise.all([
      acquireGrokSubscriptionRefreshLock(pool, 'lock-a', 5_000, 'team-grok-lock'),
      acquireGrokSubscriptionRefreshLock(pool, 'lock-b', 5_000, 'team-grok-lock'),
    ])
    expect([first, second].filter(Boolean)).toHaveLength(1)
    const winner = first ? 'lock-a' : 'lock-b'
    expect(await releaseGrokSubscriptionRefreshLock(pool, winner, 'team-grok-lock')).toBe(true)
    expect(await acquireGrokSubscriptionRefreshLock(pool, 'lock-c', 1, 'team-grok-lock')).toBe(true)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(await acquireGrokSubscriptionRefreshLock(pool, 'lock-d', 5_000, 'team-grok-lock')).toBe(
      true
    )
  })

  it('requires connection_id on grok-subscription provider attempts', async () => {
    const created = await insertInitialGrokSubscriptionConnection(
      pool,
      KEY,
      { refreshToken: 'refresh-check', accountFingerprint: 'fp-check' },
      'team-grok-check'
    )
    await expect(
      insertLlmProviderAttempt(pool, {
        callerKind: 'host',
        hostRef: 'research-host',
        invocationId: `invocation-${randomBytes(8).toString('hex')}`,
        attemptGeneration: 1,
        providerAttemptIndex: 1,
        provider: 'grok-subscription',
        model: 'grok-4.6',
        requestHash: 'd'.repeat(64),
        policyRevision: 1,
        policyHash: 'e'.repeat(64),
        budgetReservationId: 'unbudgeted',
        connectionRevision: 1,
      })
    ).rejects.toThrow()
    const row = await insertLlmProviderAttempt(pool, {
      callerKind: 'host',
      hostRef: 'research-host',
      invocationId: `invocation-${randomBytes(8).toString('hex')}`,
      attemptGeneration: 1,
      providerAttemptIndex: 1,
      provider: 'grok-subscription',
      model: 'grok-4.6',
      requestHash: 'd'.repeat(64),
      policyRevision: 1,
      policyHash: 'e'.repeat(64),
      budgetReservationId: 'unbudgeted',
      connectionRevision: 1,
      connectionId: created.id,
    })
    expect(row.provider).toBe('grok-subscription')
    expect(row.connectionId).toBe(created.id)
  })

  it('revoke cancels pending device states and a revoked key never gets a new live row', async () => {
    const key = 'team-grok-revoke'
    await insertInitialGrokSubscriptionConnection(
      pool,
      KEY,
      { refreshToken: 'refresh-revoke', accountFingerprint: 'fp-revoke' },
      key
    )
    const deps = oauthDeps(key)
    const started = await startGrokDeviceConnect(deps, 'reconnect')
    expect(await stateStatus(started.state)).toBe('pending')

    await revokeGrokSubscription(deps)
    expect(await stateStatus(started.state)).toBe('cancelled')

    await expect(pollGrokDevice(deps, started.state)).rejects.toMatchObject({
      code: 'not_connected',
    })
    await expect(startGrokDeviceConnect(deps, 'connect')).rejects.toMatchObject({
      code: 'not_connected',
    })
    const rows = await rowsForKey(key)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ status: 'revoked' })
    expect(rows[0]?.revoked_at).toBeInstanceOf(Date)

    // DB backstop: even a writer that skips the service checks cannot revive the key.
    await expect(
      insertInitialGrokSubscriptionConnection(
        pool,
        KEY,
        { refreshToken: 'refresh-revive', accountFingerprint: 'fp-revive' },
        key
      )
    ).rejects.toBeInstanceOf(GrokSubscriptionConnectionKeyConflictError)
    await expect(
      createNamedGrokSubscriptionConnection(pool, { connectionKey: key, displayName: 'revive' })
    ).rejects.toMatchObject({ code: '23505' })
    expect(await rowsForKey(key)).toHaveLength(1)
  })

  it('revoke of a key that never connected still invalidates its pending device state', async () => {
    const key = 'team-grok-never'
    const deps = oauthDeps(key)
    const started = await startGrokDeviceConnect(deps, 'connect')
    await revokeGrokSubscription(deps)
    expect(await stateStatus(started.state)).toBe('cancelled')
    await expect(pollGrokDevice(deps, started.state)).rejects.toMatchObject({
      code: 'state_replayed',
    })
    expect(await rowsForKey(key)).toHaveLength(0)
  })

  it('parallel first grants for one key: one connects and the loser gets stale_revision', async () => {
    const key = 'team-grok-race'
    const held: Array<() => void> = []
    // Hold each first-grant INSERT until both completions reached it, so both
    // observed "no row" before either wrote (the M13 race).
    const gatedDb: DbClient = {
      query: async (text, values) => {
        if (text.includes('INSERT INTO grok_subscription_connections')) {
          await new Promise<void>(resolve => {
            held.push(resolve)
            if (held.length === 2) for (const release of held) release()
          })
        }
        return pool.query(text, values)
      },
    }
    const first = await startGrokDeviceConnect(oauthDeps(key), 'connect')
    const second = await startGrokDeviceConnect(oauthDeps(key), 'connect')
    const results = await Promise.allSettled([
      pollGrokDevice(oauthDeps(key, gatedDb), first.state),
      pollGrokDevice(oauthDeps(key, gatedDb), second.state),
    ])
    const fulfilled = results.filter(result => result.status === 'fulfilled')
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    )
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect(rejected[0]?.reason).toMatchObject({ code: 'stale_revision' })
    const rows = await rowsForKey(key)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ status: 'connected', revoked_at: null })
  })

  it('concurrent raw inserts for one key yield exactly one row and one key conflict', async () => {
    const key = 'team-grok-insert-race'
    const results = await Promise.allSettled([
      insertInitialGrokSubscriptionConnection(
        pool,
        KEY,
        { refreshToken: 'refresh-a', accountFingerprint: 'fp-insert-a' },
        key
      ),
      insertInitialGrokSubscriptionConnection(
        pool,
        KEY,
        { refreshToken: 'refresh-b', accountFingerprint: 'fp-insert-b' },
        key
      ),
    ])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    )
    expect(rejected?.reason).toBeInstanceOf(GrokSubscriptionConnectionKeyConflictError)
    expect(await rowsForKey(key)).toHaveLength(1)
  })

  it('a catalog failure mid-sync leaves readiness, revision and model rows unchanged', async () => {
    const key = 'team-grok-catalog'
    const created = await insertInitialGrokSubscriptionConnection(
      pool,
      KEY,
      { refreshToken: 'refresh-catalog', accessToken: 'access', accountFingerprint: 'fp-catalog' },
      key
    )
    const failing: GrokCatalogTransport = {
      listModels: async () => ({
        outcome: 'ready',
        // INTEGER overflow fails the second model INSERT after readiness was recorded.
        models: [
          { model: 'grok-catalog-ok' },
          { model: 'grok-catalog-bad', contextWindowTokens: 3_000_000_000 },
        ],
      }),
    }
    await expect(
      syncGrokSubscriptionCatalog(
        pool,
        failing,
        'access',
        { connectionKey: key },
        { withTransaction: poolTransaction }
      )
    ).rejects.toThrow()
    const after = await getSafeGrokSubscriptionConnection(pool, key)
    expect(after).toMatchObject({
      catalogStatus: 'never_synced',
      catalogRevision: created.catalogRevision,
      catalogSyncedAt: null,
    })
    const models = await pool.query(
      `SELECT model FROM grok_catalog_models WHERE connection_id = $1`,
      [created.id]
    )
    expect(models.rows).toEqual([])
    const union = await pool.query(
      `SELECT model FROM llm_allowed_models WHERE provider = 'grok-subscription' AND model = $1`,
      ['grok-catalog-ok']
    )
    expect(union.rows).toEqual([])

    const healthy = await syncGrokSubscriptionCatalog(
      pool,
      { listModels: async () => ({ outcome: 'ready', models: [{ model: 'grok-catalog-ok' }] }) },
      'access',
      { connectionKey: key },
      { withTransaction: poolTransaction }
    )
    expect(healthy.connection).toMatchObject({
      catalogStatus: 'ready',
      catalogRevision: created.catalogRevision + 1,
    })
    expect(healthy.added).toBe(1)
  })

  it('concurrent catalog syncs on one revision commit exactly one outcome', async () => {
    const key = 'team-grok-catalog-race'
    const created = await insertInitialGrokSubscriptionConnection(
      pool,
      KEY,
      { refreshToken: 'refresh-cr', accessToken: 'access', accountFingerprint: 'fp-catalog-race' },
      key
    )
    const waiting: Array<() => void> = []
    const transport: GrokCatalogTransport = {
      listModels: async () => {
        await new Promise<void>(resolve => {
          waiting.push(resolve)
          if (waiting.length === 2) for (const release of waiting) release()
        })
        return { outcome: 'ready', models: [{ model: 'grok-catalog-race' }] }
      },
    }
    const results = await Promise.all([
      syncGrokSubscriptionCatalog(
        pool,
        transport,
        'access',
        { connectionKey: key },
        {
          withTransaction: poolTransaction,
        }
      ),
      syncGrokSubscriptionCatalog(
        pool,
        transport,
        'access',
        { connectionKey: key },
        {
          withTransaction: poolTransaction,
        }
      ),
    ])
    expect(results.filter(result => result.connection !== null)).toHaveLength(1)
    const after = await getSafeGrokSubscriptionConnection(pool, key)
    expect(after?.catalogRevision).toBe(created.catalogRevision + 1)
  })

  it('0113 archives superseded tombstones, cancels their pending states and is idempotent', async () => {
    await pool.query(`DROP INDEX IF EXISTS grok_subscription_connections_key_unique`)
    const insertRow = async (
      key: string,
      revokedAgoMinutes: number | null,
      createdAgoMinutes: number
    ) => {
      const result = await pool.query<{ id: string }>(
        `INSERT INTO grok_subscription_connections
           (connection_key, status, revoked_at, created_at)
         VALUES ($1, $2, $3, now() - ($4 * interval '1 minute'))
         RETURNING id`,
        [
          key,
          revokedAgoMinutes === null ? 'disconnected' : 'revoked',
          revokedAgoMinutes === null ? null : new Date(Date.now() - revokedAgoMinutes * 60_000),
          createdAgoMinutes,
        ]
      )
      return result.rows[0]!.id
    }
    const staleTombstone = await insertRow('team-grok-dup', 50, 60)
    const live = await insertRow('team-grok-dup', null, 10)
    const olderTombstone = await insertRow('team-grok-tomb', 40, 60)
    const newestTombstone = await insertRow('team-grok-tomb', 5, 30)
    const pendingFor = async (key: string) =>
      (
        await insertGrokSubscriptionOAuthState(pool, KEY, {
          state: `state-${randomBytes(6).toString('hex')}`,
          intent: 'connect',
          deviceCode: 'device-secret',
          expiresAt: new Date(Date.now() + 600_000),
          connectionKey: key,
        })
      ).state
    const liveState = await pendingFor('team-grok-dup')
    const tombState = await pendingFor('team-grok-tomb')

    await applyGrokSubscriptionTerminalConnectionKeySchema(pool)
    await applyGrokSubscriptionTerminalConnectionKeySchema(pool)

    expect((await rowsForKey('team-grok-dup')).map(row => row.id)).toEqual([live])
    expect((await rowsForKey('team-grok-tomb')).map(row => row.id)).toEqual([newestTombstone])
    const archived = await pool.query<{
      id: string
      connection_key: string
      revoked_at: Date | null
    }>(
      `SELECT id, connection_key, revoked_at
         FROM grok_subscription_connections
        WHERE id = ANY($1::uuid[])
        ORDER BY id`,
      [[staleTombstone, olderTombstone]]
    )
    expect(archived.rows).toHaveLength(2)
    for (const row of archived.rows) {
      expect(row.revoked_at).toBeInstanceOf(Date)
      expect(row.connection_key).toContain(`~revoked~${row.id}`)
    }
    expect(await stateStatus(liveState)).toBe('pending')
    expect(await stateStatus(tombState)).toBe('cancelled')
    const index = await pool.query(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'grok_subscription_connections_key_unique'`
    )
    expect(String((index.rows[0] as { indexdef?: string } | undefined)?.indexdef)).toMatch(
      /UNIQUE INDEX .* \(connection_key\)$/
    )
    await expect(
      insertInitialGrokSubscriptionConnection(
        pool,
        KEY,
        { refreshToken: 'refresh-tomb', accountFingerprint: 'fp-tomb' },
        'team-grok-tomb'
      )
    ).rejects.toBeInstanceOf(GrokSubscriptionConnectionKeyConflictError)
  })

  it('T-R3-4c-grok stores the catalog window and refreshes it on an existing row (#731 R3-4)', async () => {
    const key = 'team-grok-window'
    const model = 'grok-window-r34'
    const created = await insertInitialGrokSubscriptionConnection(
      pool,
      KEY,
      { refreshToken: 'refresh-window', accessToken: 'access', accountFingerprint: 'fp-window' },
      key
    )
    const sync = (models: GrokDiscoveredModel[]) =>
      syncGrokSubscriptionCatalog(
        pool,
        { listModels: async () => ({ outcome: 'ready', models }) },
        'access',
        { connectionKey: key },
        { withTransaction: poolTransaction }
      )
    const windows = async () => {
      const connection = await pool.query<{ context_window_tokens: number | null }>(
        `SELECT context_window_tokens FROM grok_catalog_models
          WHERE connection_id = $1 AND model = $2`,
        [created.id, model]
      )
      const union = await pool.query<{ context_window_tokens: number | null }>(
        `SELECT context_window_tokens FROM llm_allowed_models
          WHERE provider = 'grok-subscription' AND model = $1`,
        [model]
      )
      return {
        connection: connection.rows.map(row => row.context_window_tokens),
        union: union.rows.map(row => row.context_window_tokens),
      }
    }

    // Discovered before the catalog supplied a window.
    expect((await sync([{ model }])).added).toBe(1)
    expect(await windows()).toEqual({ connection: [null], union: [null] })

    // The catalog now supplies one; the existing rows take the refresh path.
    const supplied = await sync([{ model, contextWindowTokens: 500_000 }])
    expect(supplied.refreshed).toBe(1)
    expect(await windows()).toEqual({ connection: [500_000], union: [500_000] })

    // A later catalog without a window keeps the stored value.
    const silent = await sync([{ model }])
    expect(silent.refreshed).toBe(1)
    expect(await windows()).toEqual({ connection: [500_000], union: [500_000] })
  })

  it('T-R5-2-grok fills a NULL display_name on an existing row and keeps it when the catalog omits it', async () => {
    const key = 'team-grok-display-name'
    const model = 'grok-display-name-r52'
    const created = await insertInitialGrokSubscriptionConnection(
      pool,
      KEY,
      { refreshToken: 'refresh-name', accessToken: 'access', accountFingerprint: 'fp-name' },
      key
    )
    const sync = (models: GrokDiscoveredModel[]) =>
      syncGrokSubscriptionCatalog(
        pool,
        { listModels: async () => ({ outcome: 'ready', models }) },
        'access',
        { connectionKey: key },
        { withTransaction: poolTransaction }
      )
    const names = async () => {
      const connection = await pool.query<{ display_name: string | null }>(
        `SELECT display_name FROM grok_catalog_models
          WHERE connection_id = $1 AND model = $2`,
        [created.id, model]
      )
      const union = await pool.query<{ display_name: string | null }>(
        `SELECT display_name FROM llm_allowed_models
          WHERE provider = 'grok-subscription' AND model = $1`,
        [model]
      )
      return {
        connection: connection.rows.map(row => row.display_name),
        union: union.rows.map(row => row.display_name),
      }
    }

    // Discovered before the catalog supplied a name.
    expect((await sync([{ model }])).added).toBe(1)
    expect(await names()).toEqual({ connection: [null], union: [null] })

    // The catalog now supplies the name; the existing rows take the refresh path.
    const supplied = await sync([{ model, displayName: 'Grok Display R52' }])
    expect(supplied.refreshed).toBe(1)
    expect(await names()).toEqual({
      connection: ['Grok Display R52'],
      union: ['Grok Display R52'],
    })

    // A later catalog without a name keeps the stored one.
    const silent = await sync([{ model }])
    expect(silent.refreshed).toBe(1)
    expect(await names()).toEqual({
      connection: ['Grok Display R52'],
      union: ['Grok Display R52'],
    })
  })

  it('R9-20-grok a catalog that changes a stored name and window replaces both in both tables', async () => {
    const key = 'team-grok-r9-20-replace'
    const model = 'grok-r9-20-replace'
    const created = await insertInitialGrokSubscriptionConnection(
      pool,
      KEY,
      { refreshToken: 'refresh-r920', accessToken: 'access', accountFingerprint: 'fp-r920' },
      key
    )
    const sync = (models: GrokDiscoveredModel[]) =>
      syncGrokSubscriptionCatalog(
        pool,
        { listModels: async () => ({ outcome: 'ready', models }) },
        'access',
        { connectionKey: key },
        { withTransaction: poolTransaction }
      )
    const stored = async () => {
      const connection = await pool.query<{
        display_name: string | null
        context_window_tokens: number | null
      }>(
        `SELECT display_name, context_window_tokens FROM grok_catalog_models
          WHERE connection_id = $1 AND model = $2`,
        [created.id, model]
      )
      const union = await pool.query<{
        display_name: string | null
        context_window_tokens: number | null
      }>(
        `SELECT display_name, context_window_tokens FROM llm_allowed_models
          WHERE provider = 'grok-subscription' AND model = $1`,
        [model]
      )
      return { connection: connection.rows, union: union.rows }
    }

    // Catalog A: both values non-null, inserted on first sight.
    const first = await sync([{ model, displayName: 'Grok A', contextWindowTokens: 131_072 }])
    expect(first.added).toBe(1)
    const a = { display_name: 'Grok A', context_window_tokens: 131_072 }
    expect(await stored()).toEqual({ connection: [a], union: [a] })

    // Catalog B: different non-null values; the existing rows take the refresh
    // path and must store what the catalog now says, not keep A.
    const second = await sync([{ model, displayName: 'Grok B', contextWindowTokens: 262_144 }])
    expect(second.refreshed).toBe(1)
    const b = { display_name: 'Grok B', context_window_tokens: 262_144 }
    expect(await stored()).toEqual({ connection: [b], union: [b] })
  })
})
