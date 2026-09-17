import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { Pool } from 'pg'
import { initDb } from '../src/db.js'
import { deriveOAuthEncryptionKey } from '../src/oauth/encryption.js'
import {
  acquireGrokSubscriptionRefreshLock,
  insertInitialGrokSubscriptionConnection,
  releaseGrokSubscriptionRefreshLock,
} from '../src/services/grokSubscriptionConnection.js'
import { insertLlmProviderAttempt } from '../src/services/llmProviderAttemptStore.js'

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

describeRealPostgres('Grok subscription connection on real PostgreSQL', () => {
  const database = `grok_subscription_${randomBytes(6).toString('hex')}`
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
})
