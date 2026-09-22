import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import { Pool } from 'pg'
import { initDb } from '../src/db.js'
import { deriveOAuthEncryptionKey } from '../src/oauth/encryption.js'
import {
  type CodexDiscoveredModel,
  syncCodexSubscriptionCatalog,
} from '../src/services/codexSubscriptionCatalog.js'
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

  it('T-R3-4c stores the catalog window and refreshes it on an existing row (#731 R3-4)', async () => {
    const model = 'gpt-5.5'
    const sync = (models: CodexDiscoveredModel[]) =>
      syncCodexSubscriptionCatalog(
        pool,
        {
          async listModels() {
            return { outcome: 'ready', models }
          },
        },
        'access-token'
      )
    const windows = async () => {
      const connection = await pool.query<{ context_window_tokens: number | null }>(
        `SELECT context_window_tokens FROM codex_catalog_models WHERE model = $1`,
        [model]
      )
      const union = await pool.query<{ context_window_tokens: number | null }>(
        `SELECT context_window_tokens FROM llm_allowed_models
          WHERE provider = 'codex-subscription' AND model = $1`,
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
    const supplied = await sync([{ model, contextWindowTokens: 272_000 }])
    expect(supplied.refreshed).toBe(1)
    expect(await windows()).toEqual({ connection: [272_000], union: [272_000] })

    // A later catalog without a window keeps the stored value.
    const silent = await sync([{ model }])
    expect(silent.refreshed).toBe(1)
    expect(await windows()).toEqual({ connection: [272_000], union: [272_000] })
  })

  it('T-R5-2 fills a NULL display_name on an existing row and keeps it when the catalog omits it', async () => {
    const model = 'gpt-5.6-sol'
    const sync = (models: CodexDiscoveredModel[]) =>
      syncCodexSubscriptionCatalog(
        pool,
        {
          async listModels() {
            return { outcome: 'ready', models }
          },
        },
        'access-token'
      )
    const names = async () => {
      const connection = await pool.query<{ display_name: string | null }>(
        `SELECT display_name FROM codex_catalog_models WHERE model = $1`,
        [model]
      )
      const union = await pool.query<{ display_name: string | null }>(
        `SELECT display_name FROM llm_allowed_models
          WHERE provider = 'codex-subscription' AND model = $1`,
        [model]
      )
      return {
        connection: connection.rows.map(row => row.display_name),
        union: union.rows.map(row => row.display_name),
      }
    }

    // Stored while the proxy dropped the name, as every existing row was.
    expect((await sync([{ model }])).added).toBe(1)
    expect(await names()).toEqual({ connection: [null], union: [null] })

    // The catalog now supplies the name; the existing rows take the refresh path.
    const supplied = await sync([{ model, displayName: 'GPT-5.6-Sol' }])
    expect(supplied.refreshed).toBe(1)
    expect(await names()).toEqual({ connection: ['GPT-5.6-Sol'], union: ['GPT-5.6-Sol'] })

    // A later catalog without a name keeps the stored one.
    const silent = await sync([{ model }])
    expect(silent.refreshed).toBe(1)
    expect(await names()).toEqual({ connection: ['GPT-5.6-Sol'], union: ['GPT-5.6-Sol'] })
  })
})
