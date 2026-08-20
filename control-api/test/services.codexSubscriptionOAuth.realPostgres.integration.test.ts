import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import { Pool } from 'pg'
import { initDb } from '../src/db.js'
import { deriveOAuthEncryptionKey } from '../src/oauth/encryption.js'
import { insertInitialCodexSubscriptionConnection } from '../src/services/codexSubscriptionConnection.js'
import {
  type CodexOAuthDeps,
  CodexSubscriptionOAuthError,
  refreshCodexSubscriptionConnection,
  revokeCodexSubscription,
} from '../src/services/codexSubscriptionOAuth.js'

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
  const payload = Buffer.from(JSON.stringify({ sub: subject })).toString('base64url')
  return `hdr.${payload}.sig`
}

describeRealPostgres('Codex subscription OAuth on real PostgreSQL', () => {
  const database = `codex_oauth_${randomBytes(6).toString('hex')}`
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
    await insertInitialCodexSubscriptionConnection(pool, KEY, {
      refreshToken: 'seed-refresh',
      accountFingerprint: createHash('sha256').update('acct-seed', 'utf8').digest('hex'),
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

  function deps(fetchFn: typeof fetch): CodexOAuthDeps {
    return {
      db: pool,
      encryptionKey: KEY,
      fetchFn,
      clientId: 'app_test_client',
      redirectUri: 'https://control.example/api/v1/auth/codex-subscription/callback',
      enabled: true,
    }
  }

  it('lets only one concurrent refresh win the single-flight lock', async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: 'access-secret',
        refresh_token: 'winner-refresh',
        id_token: idTokenFor('acct-seed'),
      }),
    })
    const results = await Promise.allSettled([
      refreshCodexSubscriptionConnection(deps(fetchFn)),
      refreshCodexSubscriptionConnection(deps(fetchFn)),
    ])
    const fulfilled = results.filter(result => result.status === 'fulfilled')
    const rejected = results.filter(result => result.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      CodexSubscriptionOAuthError
    )
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      code: expect.stringMatching(/refresh_in_flight|stale_revision/),
    })
  })

  it('revokes locally first when upstream revoke fails', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error('upstream revoke down'))
    const revoked = await revokeCodexSubscription(deps(fetchFn))
    expect(revoked.status).toBe('revoked')
    expect(JSON.stringify(revoked)).not.toContain('seed-refresh')
    expect(JSON.stringify(revoked)).not.toContain('winner-refresh')
  })
})
