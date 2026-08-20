import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { Pool } from 'pg'
import { initDb } from '../src/db.js'
import { deriveOAuthEncryptionKey } from '../src/oauth/encryption.js'
import {
  CodexSubscriptionStaleRevisionError,
  acquireCodexSubscriptionRefreshLock,
  getSafeCodexSubscriptionConnection,
  insertInitialCodexSubscriptionConnection,
  loadCodexSubscriptionSecrets,
  rotateCodexSubscriptionCredentials,
} from '../src/services/codexSubscriptionConnection.js'
import {
  cancelCodexSubscriptionOAuthState,
  consumeCodexSubscriptionOAuthState,
  insertCodexSubscriptionOAuthState,
} from '../src/services/codexSubscriptionOAuthState.js'

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

describeRealPostgres('Codex subscription connection on real PostgreSQL', () => {
  const database = `codex_subscription_${randomBytes(6).toString('hex')}`
  const connectionString = databaseUrl(
    adminUrl ?? 'postgresql://postgres@127.0.0.1/postgres',
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

  it('creates the connection and oauth-state tables', async () => {
    const tables = await pool.query<{ table_name: string }>(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = ANY($1::text[])
        ORDER BY table_name`,
      [['codex_subscription_connections', 'codex_subscription_oauth_states']]
    )
    expect(tables.rows.map(row => row.table_name)).toEqual([
      'codex_subscription_connections',
      'codex_subscription_oauth_states',
    ])
  })

  it('allows only one active deployment-default connection', async () => {
    await insertInitialCodexSubscriptionConnection(pool, KEY, {
      refreshToken: 'first-refresh',
      accountFingerprint: 'fp-one',
    })
    await expect(
      insertInitialCodexSubscriptionConnection(pool, KEY, {
        refreshToken: 'second-refresh',
        accountFingerprint: 'fp-two',
      })
    ).rejects.toThrow(/duplicate|unique/i)

    const count = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM codex_subscription_connections WHERE revoked_at IS NULL`
    )
    expect(count.rows[0]?.count).toBe('1')
  })

  it('rejects a stale writer so it cannot overwrite a newer credential', async () => {
    const current = await getSafeCodexSubscriptionConnection(pool)
    expect(current).not.toBeNull()
    const winner = await rotateCodexSubscriptionCredentials(
      pool,
      KEY,
      current!.credentialRevision,
      {
        refreshToken: 'winner-refresh',
        accountFingerprint: 'fp-winner',
      }
    )
    await expect(
      rotateCodexSubscriptionCredentials(pool, KEY, current!.credentialRevision, {
        refreshToken: 'stale-refresh',
        accountFingerprint: 'fp-stale',
      })
    ).rejects.toBeInstanceOf(CodexSubscriptionStaleRevisionError)

    const secrets = await loadCodexSubscriptionSecrets(pool, KEY)
    expect(secrets?.refreshToken).toBe('winner-refresh')
    expect(secrets?.refreshToken).not.toBe('stale-refresh')
    expect(winner.credentialRevision).toBe(current!.credentialRevision + 1)
    const safe = await getSafeCodexSubscriptionConnection(pool)
    expect(JSON.stringify(safe)).not.toContain('winner-refresh')
  })

  it('lets only one concurrent refresh lock win', async () => {
    const [first, second] = await Promise.all([
      acquireCodexSubscriptionRefreshLock(pool, 'lock-a', 5_000),
      acquireCodexSubscriptionRefreshLock(pool, 'lock-b', 5_000),
    ])
    const winners = [first, second].filter(Boolean)
    expect(winners).toHaveLength(1)
  })

  it('consumes OAuth state/PKCE exactly once and supports cancel plus replacement intent', async () => {
    const created = await insertCodexSubscriptionOAuthState(pool, KEY, {
      state: 'state-one',
      flow: 'browser',
      intent: 'replace',
      pkceVerifier: 'pkce-secret',
      expiresAt: new Date(Date.now() + 60_000),
    })
    expect(created.intent).toBe('replace')
    expect(JSON.stringify(created)).not.toContain('pkce-secret')

    const [first, second] = await Promise.all([
      consumeCodexSubscriptionOAuthState(pool, KEY, 'state-one'),
      consumeCodexSubscriptionOAuthState(pool, KEY, 'state-one'),
    ])
    const consumed = [first, second].filter(result => result !== null)
    expect(consumed).toHaveLength(1)
    expect(consumed[0]?.pkceVerifier).toBe('pkce-secret')
    expect(JSON.stringify(consumed[0]?.safe)).not.toContain('pkce-secret')

    const replay = await consumeCodexSubscriptionOAuthState(pool, KEY, 'state-one')
    expect(replay).toBeNull()

    await insertCodexSubscriptionOAuthState(pool, KEY, {
      state: 'state-cancel',
      flow: 'device',
      intent: 'connect',
      deviceCode: 'device-secret',
      expiresAt: new Date(Date.now() + 60_000),
    })
    expect(await cancelCodexSubscriptionOAuthState(pool, 'state-cancel')).toBe(true)
    expect(await consumeCodexSubscriptionOAuthState(pool, KEY, 'state-cancel')).toBeNull()
  })
})
