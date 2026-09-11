import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import { Pool } from 'pg'
import { initDb } from '../src/db.js'
import { deriveOAuthEncryptionKey } from '../src/oauth/encryption.js'
import { syncCodexSubscriptionCatalog } from '../src/services/codexSubscriptionCatalog.js'
import { insertInitialCodexSubscriptionConnection } from '../src/services/codexSubscriptionConnection.js'

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

describeRealPostgres('Codex subscription catalog on real PostgreSQL', () => {
  const database = `codex_catalog_${randomBytes(6).toString('hex')}`
  let adminPool: Pool
  let pool: Pool

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`CREATE DATABASE ${quoteIdent(database)}`)
    pool = new Pool({ connectionString: databaseUrl(adminUrl!, database) })
    await initDb({ connect: () => pool.connect() })
    await insertInitialCodexSubscriptionConnection(pool, KEY, {
      refreshToken: 'catalog-refresh',
      accountFingerprint: createHash('sha256').update('acct-catalog', 'utf8').digest('hex'),
    })
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

  it('ready stales missing discovery rows and a stale writer cannot stale a newer connection', async () => {
    const ready = await syncCodexSubscriptionCatalog(
      pool,
      {
        async listModels() {
          return { outcome: 'ready', models: [{ model: 'gpt-5' }, { model: 'gpt-5.3-codex' }] }
        },
      },
      'access-token'
    )
    expect(ready.outcome).toBe('ready')
    expect(ready.added).toBe(2)
    expect(ready.connection?.catalogStatus).toBe('ready')

    const next = await syncCodexSubscriptionCatalog(
      pool,
      {
        async listModels() {
          return { outcome: 'ready', models: [{ model: 'gpt-5' }] }
        },
      },
      'access-token'
    )
    expect(next.staled).toBe(1)
    const stale = await pool.query<{ stale: boolean }>(
      `SELECT stale FROM llm_allowed_models WHERE provider = 'codex-subscription' AND model = 'gpt-5.3-codex'`
    )
    expect(stale.rows[0]?.stale).toBe(true)

    const lost = await syncCodexSubscriptionCatalog(
      pool,
      {
        async listModels() {
          return { outcome: 'ready', models: [] }
        },
      },
      'access-token',
      { credentialRevision: 1, catalogRevision: 0 }
    )
    expect(lost.connection).toBeNull()
    expect(lost.staled).toBe(0)
    const kept = await pool.query<{ stale: boolean }>(
      `SELECT stale FROM llm_allowed_models WHERE provider = 'codex-subscription' AND model = 'gpt-5'`
    )
    expect(kept.rows[0]?.stale).toBe(false)
  })
})
