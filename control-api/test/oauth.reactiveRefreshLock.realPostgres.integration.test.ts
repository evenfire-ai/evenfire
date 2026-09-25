/**
 * Reactive refresh row-lock serialization (mini-spec 16, R2-M1), on a REAL
 * Postgres so the BLOCKING `FOR UPDATE` and its mutual exclusion with the
 * proactive `FOR UPDATE SKIP LOCKED` are exercised against the actual schema —
 * a mock `DbClient` cannot model row locking.
 *
 * Fixtures come from the REAL producers (`bootstrapSharedOAuthGrant`, T1). The
 * fake token endpoint (a `PinnedTransport`, like the proactive test) models a
 * ROTATING refresh token: the first POST rotates it and returns fresh tokens; any
 * later POST that presents an already-used refresh token gets `400 invalid_grant`.
 * Counting POSTs is the observable (T4): the bug is two POSTs (double-spend) that
 * kill the grant; the fix is exactly one.
 *
 *   CONTROL_API_REAL_PG_ADMIN_URL=postgres://<user>:<pass>@<host>:5432 npm test -- \
 *     test/oauth.reactiveRefreshLock.realPostgres.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { config } from '../src/config.js'
import type { DbClient, DbTransactionClient } from '../src/db.js'
import { initDb } from '../src/db.js'
import type {
  PinnedRawResponse,
  PinnedTransport,
  PinnedTransportInput,
} from '../src/http/pinnedFetch.js'
import type { RecipeWithOAuthClients } from '../src/oauth/callback.js'
import { deriveOAuthEncryptionKey } from '../src/oauth/encryption.js'
import { resolveServerOAuthSubject } from '../src/oauth/mcpServerOAuthSpec.js'
import { getAccessTokenReactive } from '../src/oauth/reactiveTokenHelper.js'
import {
  type OAuthGrantKey,
  bootstrapSharedOAuthGrant,
  claimRemoteGrantForRefresh,
  getOAuthGrant,
} from '../src/oauth/store.js'
import { getAccessToken } from '../src/oauth/tokenHelper.js'

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip

function databaseUrl(baseUrl: string, database: string): string {
  const url = new URL(baseUrl)
  url.pathname = `/${database}`
  return url.toString()
}

const KEY = deriveOAuthEncryptionKey(config.oauthEncryptionKey)
const NS = config.mcpServersNamespace
// Bp/Br as the proactive sweep uses them; a token in the proactive window is
// treated as stale by BOTH sides here (refreshBufferMs = Bp), which is what lets
// the proactive claim (window predicate) and the reactive refresh contend on the
// SAME row — the crux of the P↔R case.
const WINDOW = { proactiveBufferMs: 300_000, reactiveBufferMs: 60_000 }
const IN_WINDOW_SEC = 200 // 60s < 200s ≤ 300s → proactive window AND stale under Bp
const REMOTE_OAUTH_ID = 'https://control.example.com/.well-known/evenfire-mcp-client'
const REMOTE_TOKEN_ENDPOINT = 'https://as.example.com/token'
const REMOTE_VALIDATED_IP = '93.184.216.34'

describeRealPostgres('oauth reactive refresh — row-lock serialization (real Postgres)', () => {
  const database = `control_api_reactive_lock_${randomUUID().replace(/-/g, '')}`
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
    oauthClientId: REMOTE_OAUTH_ID,
  })

  async function seedShared(server: string, ctx: string, expiresInSec: number): Promise<void> {
    await bootstrapSharedOAuthGrant(db, KEY, {
      ...sharedKey(server, ctx),
      bootstrappedByUserId: 'user-1',
      provider: 'remote',
      accessToken: 'AT-0',
      refreshToken: 'RT-0',
      accessTokenExpiresInSec: expiresInSec,
    })
  }

  function remoteOwnerDecl(): RecipeWithOAuthClients {
    const resolved = resolveServerOAuthSubject({
      spec: {
        contextRef: 'ctx-1',
        oauth: {
          source: 'remote',
          id: REMOTE_OAUTH_ID,
          clientMode: 'public',
          authorizationEndpoint: 'https://as.example.com/authorize',
          tokenEndpoint: REMOTE_TOKEN_ENDPOINT,
          issuer: 'https://as.example.com',
          resource: 'https://as.example.com',
          grantScope: 'user',
          scopes: ['read'],
          bearerInBody: false,
          supportsRefresh: true,
        },
      },
    })
    if (!resolved) throw new Error('fixture: remote resolve returned null')
    return { spec: { oauthClients: [resolved.decl] } }
  }

  /**
   * Rotating-refresh-token AS. Each accepted POST invalidates the presented
   * refresh token and mints a new pair; reusing a spent refresh token → 400
   * invalid_grant (what a real AS does on rotation reuse, killing the grant).
   */
  function rotatingAs() {
    const validRefreshTokens = new Set<string>(['RT-0'])
    let generation = 0
    let postCount = 0
    const transport: PinnedTransport = async (
      input: PinnedTransportInput
    ): Promise<PinnedRawResponse> => {
      postCount += 1
      const presented = new URLSearchParams(input.body ?? '').get('refresh_token') ?? ''
      if (!validRefreshTokens.has(presented)) {
        return {
          status: 400,
          headers: { 'content-type': 'application/json' },
          bodyText: JSON.stringify({ error: 'invalid_grant' }),
        }
      }
      validRefreshTokens.delete(presented)
      generation += 1
      const next = `RT-${generation}`
      validRefreshTokens.add(next)
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        bodyText: JSON.stringify({
          access_token: `AT-${generation}`,
          refresh_token: next,
          expires_in: 3600,
        }),
      }
    }
    return {
      transport,
      get postCount() {
        return postCount
      },
    }
  }

  const reactiveDeps = (transport: PinnedTransport) => ({
    db,
    recipeReader: { read: async () => remoteOwnerDecl() },
    secretReader: { read: async () => ({}) },
    fetchFn: (async () => {
      throw new Error('remote refresh must not use fetchFn')
    }) as unknown as typeof fetch,
    encryptionKey: KEY,
    resolveDns: async () => [REMOTE_VALIDATED_IP],
    pinnedTransport: transport,
    // Bp so an in-proactive-window token is treated as stale by the reactive path
    // too — exactly the overlap that produced the double-spend.
    refreshBufferMs: WINDOW.proactiveBufferMs,
    // Reactive slow-path tx bound to the TEST pool (the module `pool` points at the
    // real configured DB, not this ephemeral one), so the row lock lands here.
    runInTransaction: async <T>(work: (txDb: DbTransactionClient) => Promise<T>): Promise<T> => {
      const client = await dbPool.connect()
      try {
        await client.query('BEGIN')
        const txDb = {
          query: (t: string, v?: unknown[]) => client.query(t, v),
        } as unknown as DbTransactionClient
        const result = await work(txDb)
        await client.query('COMMIT')
        return result
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {})
        throw err
      } finally {
        client.release()
      }
    },
  })

  async function waitForLockWaiter(): Promise<void> {
    for (let i = 0; i < 200; i += 1) {
      const r = await adminPool.query(
        `SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = $1 AND wait_event_type = 'Lock'`,
        [database]
      )
      if (((r.rows[0] as { n: number }).n ?? 0) > 0) return
      await new Promise(res => setTimeout(res, 25))
    }
    throw new Error('the reactive refresh never blocked on the row lock')
  }

  it('P↔R: a reactive refresh blocks on the proactive row lock, then re-reads fresh (1 POST)', async () => {
    await seedShared('pr', 'ctx-1', IN_WINDOW_SEC)
    const key = sharedKey('pr', 'ctx-1')
    const as = rotatingAs()

    // Proactive side: claim (FOR UPDATE SKIP LOCKED) + refresh on the SAME tx,
    // held OPEN (uncommitted) so it owns the row lock while the reactive contends.
    const c1 = await dbPool.connect()
    try {
      await c1.query('BEGIN')
      const c1Tx = { query: (t: string, v?: unknown[]) => c1.query(t, v) }
      const claimed = await claimRemoteGrantForRefresh(c1Tx, key, WINDOW)
      expect(claimed).toBe(true)
      const proactive = await getAccessToken(
        { ...key, requireBackground: false },
        {
          db: c1Tx,
          recipeReader: { read: async () => remoteOwnerDecl() },
          secretReader: { read: async () => ({}) },
          fetchFn: (async () => {
            throw new Error('remote refresh must not use fetchFn')
          }) as unknown as typeof fetch,
          encryptionKey: KEY,
          resolveDns: async () => [REMOTE_VALIDATED_IP],
          pinnedTransport: as.transport,
          refreshBufferMs: WINDOW.proactiveBufferMs,
        }
      )
      expect(proactive.kind).toBe('ok')
      expect(as.postCount).toBe(1) // proactive did the single POST

      // Reactive side: still sees the OLD (uncommitted) token → wants to refresh →
      // blocks on the row lock. It must NOT double-spend.
      const reactivePromise = getAccessTokenReactive(key, reactiveDeps(as.transport))
      await waitForLockWaiter()

      await c1.query('COMMIT') // releases the lock; row now carries the fresh token
      const reactive = await reactivePromise
      expect(reactive.kind).toBe('ok')
    } finally {
      c1.release()
    }

    // The observable: exactly ONE POST total; the grant survives with the rotated
    // token; no invalid_grant was ever provoked.
    expect(as.postCount).toBe(1)
    const after = await getOAuthGrant(db, KEY, key)
    expect(after?.accessToken).toBe('AT-1')
    expect(after?.refreshToken).toBe('RT-1')
  })

  it('R↔R: two concurrent reactive refreshes over one grant issue exactly 1 POST', async () => {
    await seedShared('rr', 'ctx-1', IN_WINDOW_SEC)
    const key = sharedKey('rr', 'ctx-1')
    const as = rotatingAs()

    const [a, b] = await Promise.all([
      getAccessTokenReactive(key, reactiveDeps(as.transport)),
      getAccessTokenReactive(key, reactiveDeps(as.transport)),
    ])

    expect(a.kind).toBe('ok')
    expect(b.kind).toBe('ok')
    expect(as.postCount).toBe(1) // one refreshed, the other re-read fresh under the lock
    const after = await getOAuthGrant(db, KEY, key)
    expect(after?.accessToken).toBe('AT-1')
    expect(after?.refreshToken).toBe('RT-1')
  })
})
