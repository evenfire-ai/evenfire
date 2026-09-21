/**
 * Enumeration + claim for the proactive refresh sweep (mini-spec L §6.3), on a
 * REAL Postgres so `FOR UPDATE SKIP LOCKED`, the window predicate, and the
 * eligibility filter are exercised against the actual schema/migrations — not a
 * hand-built row shape. Fixtures come from the REAL producers
 * (`bootstrapSharedOAuthGrant` / `upsertOAuthGrant` / `upsertDynamicClient`, T1).
 *
 *   CONTROL_API_REAL_PG_ADMIN_URL=postgres://<user>:<pass>@<host>:5432 npm test -- \
 *     test/oauth.proactiveRefresh.realPostgres.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { config } from '../src/config.js'
import type { DbClient } from '../src/db.js'
import { initDb } from '../src/db.js'
import { listExpiringDynamicClients, upsertDynamicClient } from '../src/oauth/dynamicClientStore.js'
import { deriveOAuthEncryptionKey } from '../src/oauth/encryption.js'
import {
  type OAuthGrantKey,
  bootstrapSharedOAuthGrant,
  claimRemoteGrantForRefresh,
  listRemoteGrantsInProactiveWindow,
  upsertOAuthGrant,
} from '../src/oauth/store.js'

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip

function databaseUrl(baseUrl: string, database: string): string {
  const url = new URL(baseUrl)
  url.pathname = `/${database}`
  return url.toString()
}

const KEY = deriveOAuthEncryptionKey(config.oauthEncryptionKey)
const NS = config.mcpServersNamespace
const WINDOW = { proactiveBufferMs: 300_000, reactiveBufferMs: 60_000 }
// Seconds-to-expiry that land a grant in each region of the token life.
const IN_WINDOW_SEC = 200 // 60s < 200s ≤ 300s → proactive window
const HEALTHY_SEC = 1_000 // > Bp
const REACTIVE_SEC = 30 // ≤ Br

describeRealPostgres('oauth proactive refresh — enumeration + claim (real Postgres)', () => {
  const database = `control_api_proactive_${randomUUID().replace(/-/g, '')}`
  let adminPool: Pool
  let dbPool: Pool
  let db: DbClient

  beforeAll(async () => {
    if (!adminUrl) throw new Error('CONTROL_API_REAL_PG_ADMIN_URL is required')
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`CREATE DATABASE "${database.replace(/"/g, '""')}"`)
    dbPool = new Pool({ connectionString: databaseUrl(adminUrl, database) })
    await initDb({ connect: () => dbPool.connect() })
    db = { query: (text, values) => dbPool.query(text, values) }
  })

  afterAll(async () => {
    await dbPool?.end()
    if (adminPool) {
      await adminPool.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
          WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [database]
      )
      await adminPool.query(`DROP DATABASE IF EXISTS "${database.replace(/"/g, '""')}"`)
      await adminPool.end()
    }
  })

  const sharedKey = (server: string, ctx: string): OAuthGrantKey => ({
    grantKind: 'shared',
    ownerKind: 'mcpserver',
    recipeNamespace: NS,
    recipeName: server,
    contextId: ctx,
    oauthClientId: 'remote-cid',
  })

  async function seedShared(
    server: string,
    ctx: string,
    provider: string,
    expiresInSec: number | undefined
  ): Promise<void> {
    await bootstrapSharedOAuthGrant(db, KEY, {
      ...sharedKey(server, ctx),
      bootstrappedByUserId: 'user-1',
      provider,
      accessToken: 'AT',
      refreshToken: 'RT',
      accessTokenExpiresInSec: expiresInSec,
    })
  }

  async function seedUser(
    server: string,
    userId: string,
    background: boolean,
    expiresInSec: number
  ): Promise<void> {
    await upsertOAuthGrant(db, KEY, {
      grantKind: 'user',
      ownerKind: 'mcpserver',
      recipeNamespace: NS,
      recipeName: server,
      userId,
      oauthClientId: 'remote-cid',
      provider: 'remote',
      accessToken: 'AT',
      refreshToken: 'RT',
      accessTokenExpiresInSec: expiresInSec,
    })
    // The background column is set elsewhere at consent time; drive it directly
    // here (real schema column) to build the background-vs-not distinction.
    if (background) {
      await dbPool.query(
        `UPDATE oauth_grants SET background = true
          WHERE owner_kind = 'mcpserver' AND recipe_namespace = $1 AND recipe_name = $2
            AND user_id = $3 AND grant_kind = 'user'`,
        [NS, server, userId]
      )
    }
  }

  it('enumerates only remote mcpserver grants (shared + background user) inside the window', async () => {
    await seedShared('e-shared-in', 'ctx-in', 'remote', IN_WINDOW_SEC)
    await seedShared('e-shared-healthy', 'ctx-h', 'remote', HEALTHY_SEC)
    await seedShared('e-shared-reactive', 'ctx-r', 'remote', REACTIVE_SEC)
    await seedShared('e-shared-nullexp', 'ctx-n', 'remote', undefined)
    await seedShared('e-shared-baked', 'ctx-b', 'google', IN_WINDOW_SEC) // non-remote
    await seedUser('e-user-bg', 'u-bg', true, IN_WINDOW_SEC)
    await seedUser('e-user-nobg', 'u-nobg', false, IN_WINDOW_SEC)
    // Recipe-domain grant in-window: must never be touched by the mcpserver sweep.
    await upsertOAuthGrant(db, KEY, {
      grantKind: 'user',
      ownerKind: 'recipe',
      recipeNamespace: NS,
      recipeName: 'e-recipe',
      userId: 'u-recipe',
      oauthClientId: 'remote-cid',
      provider: 'remote',
      accessToken: 'AT',
      accessTokenExpiresInSec: IN_WINDOW_SEC,
    })

    const keys = await listRemoteGrantsInProactiveWindow(db, WINDOW)
    const names = keys.map(k => k.recipeName).sort()
    expect(names).toEqual(['e-shared-in', 'e-user-bg'])
  })

  it('FOR UPDATE SKIP LOCKED serializes the claim across connections', async () => {
    await seedShared('claim-a', 'ctx-1', 'remote', IN_WINDOW_SEC)
    const key = sharedKey('claim-a', 'ctx-1')

    const c1 = await dbPool.connect()
    const c2 = await dbPool.connect()
    try {
      await c1.query('BEGIN')
      await c2.query('BEGIN')
      const first = await claimRemoteGrantForRefresh(
        { query: (t, v) => c1.query(t, v) },
        key,
        WINDOW
      )
      const second = await claimRemoteGrantForRefresh(
        { query: (t, v) => c2.query(t, v) },
        key,
        WINDOW
      )
      expect(first).toBe(true)
      expect(second).toBe(false) // c1 holds the row lock; c2 skips it
      await c1.query('COMMIT')
      await c2.query('ROLLBACK')
    } finally {
      c1.release()
      c2.release()
    }
  })

  it('the claim re-checks the window: a grant renewed out of the window is not claimed', async () => {
    await seedShared('claim-b', 'ctx-1', 'remote', IN_WINDOW_SEC)
    const key = sharedKey('claim-b', 'ctx-1')
    // Simulate the reactive path having already renewed it to a full life.
    await dbPool.query(
      `UPDATE oauth_grants SET access_token_expires_at = NOW() + INTERVAL '1000 seconds'
        WHERE owner_kind = 'mcpserver' AND recipe_namespace = $1 AND recipe_name = $2
          AND context_id = $3 AND grant_kind = 'shared'`,
      [NS, 'claim-b', 'ctx-1']
    )
    const c1 = await dbPool.connect()
    try {
      await c1.query('BEGIN')
      const claimed = await claimRemoteGrantForRefresh(
        { query: (t, v) => c1.query(t, v) },
        key,
        WINDOW
      )
      expect(claimed).toBe(false)
      await c1.query('ROLLBACK')
    } finally {
      c1.release()
    }
  })

  it('T5(b): a successful proactive refresh moves the row out of the enumeration window', async () => {
    await seedShared('t5b', 'ctx-1', 'remote', IN_WINDOW_SEC)
    const before = await listRemoteGrantsInProactiveWindow(db, WINDOW)
    expect(before.some(k => k.recipeName === 't5b')).toBe(true)
    // A refresh pushes expiry to a full life ahead.
    await dbPool.query(
      `UPDATE oauth_grants SET access_token_expires_at = NOW() + INTERVAL '3600 seconds'
        WHERE owner_kind = 'mcpserver' AND recipe_namespace = $1 AND recipe_name = $2
          AND context_id = $3 AND grant_kind = 'shared'`,
      [NS, 't5b', 'ctx-1']
    )
    const after = await listRemoteGrantsInProactiveWindow(db, WINDOW)
    expect(after.some(k => k.recipeName === 't5b')).toBe(false)
  })

  it('listExpiringDynamicClients returns expiring + expired confidential clients only', async () => {
    const nowSec = Math.floor(Date.now() / 1000)
    await upsertDynamicClient(db, KEY, {
      serverNamespace: NS,
      serverName: 'dc-expiring',
      issuer: 'https://as.example.com',
      clientId: 'cid-1',
      clientMode: 'confidential',
      clientSecret: 'sec',
      clientSecretExpiresAtSec: nowSec + 3600, // within 7d
    })
    await upsertDynamicClient(db, KEY, {
      serverNamespace: NS,
      serverName: 'dc-expired',
      issuer: 'https://as.example.com',
      clientId: 'cid-2',
      clientMode: 'confidential',
      clientSecret: 'sec',
      clientSecretExpiresAtSec: nowSec - 3600, // already lapsed
    })
    await upsertDynamicClient(db, KEY, {
      serverNamespace: NS,
      serverName: 'dc-healthy',
      issuer: 'https://as.example.com',
      clientId: 'cid-3',
      clientMode: 'confidential',
      clientSecret: 'sec',
      clientSecretExpiresAtSec: nowSec + 400 * 24 * 3600, // far beyond Wc
    })
    await upsertDynamicClient(db, KEY, {
      serverNamespace: NS,
      serverName: 'dc-nonexpiring',
      issuer: 'https://as.example.com',
      clientId: 'cid-4',
      clientMode: 'confidential',
      clientSecret: 'sec',
      // no clientSecretExpiresAtSec → NULL (non-expiring)
    })
    await upsertDynamicClient(db, KEY, {
      serverNamespace: NS,
      serverName: 'dc-public',
      issuer: 'https://as.example.com',
      clientId: 'cid-5',
      clientMode: 'public',
    })

    const rows = await listExpiringDynamicClients(db, { withinMs: 7 * 24 * 3600 * 1000 })
    const names = rows.map(r => r.serverName).sort()
    expect(names).toEqual(['dc-expired', 'dc-expiring'])
    expect(rows.every(r => r.clientMode === 'confidential')).toBe(true)
  })
})
