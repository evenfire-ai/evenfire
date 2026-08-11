import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { config } from '../src/config.js'
import type { DbClient } from '../src/db.js'
import { initDb } from '../src/db.js'
import { deriveOAuthEncryptionKey } from '../src/oauth/encryption.js'
import { bootstrapSharedOAuthGrant, getOAuthGrant, upsertOAuthGrant } from '../src/oauth/store.js'

// T1/T5 — shared-identity grant semantics derived from the REAL producer
// (real ON CONFLICT DO NOTHING + CHECK constraints), not a hand-built fixture.
// Gated on a real Postgres, like the other *.realPostgres.integration.test.ts:
//   CONTROL_API_REAL_PG_ADMIN_URL=postgres://user:pass@host:5432 npm test -- \
//     test/oauth.store.sharedGrants.realPostgres.integration.test.ts
const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip

function databaseUrl(baseUrl: string, database: string): string {
  const url = new URL(baseUrl)
  url.pathname = `/${database}`
  return url.toString()
}

const KEY = deriveOAuthEncryptionKey(config.oauthEncryptionKey)

describeRealPostgres('oauth store — shared grants (real Postgres)', () => {
  const database = `control_api_shared_grants_${randomUUID().replace(/-/g, '')}`
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

  const sharedKey = (server: string, contextId: string) => ({
    grantKind: 'shared' as const,
    ownerKind: 'mcpserver' as const,
    recipeNamespace: config.mcpServersNamespace,
    recipeName: server,
    contextId,
    oauthClientId: 'google-drive',
  })

  it('bootstrap is first-wins; a token refresh preserves bootstrapped_by and updates tokens', async () => {
    const server = 'gdrive-a'
    const first = await bootstrapSharedOAuthGrant(db, KEY, {
      ...sharedKey(server, 'ctx-1'),
      bootstrappedByUserId: 'user-1',
      provider: 'google',
      accessToken: 'ACCESS-1',
      refreshToken: 'REFRESH-1',
      accessTokenExpiresInSec: 3600,
    })
    expect(first.inserted).toBe(true)

    // A concurrent second member's callback also succeeds but no-ops (DO NOTHING):
    // it inherits the team's grant; tokens + bootstrapper stay the first member's.
    const second = await bootstrapSharedOAuthGrant(db, KEY, {
      ...sharedKey(server, 'ctx-1'),
      bootstrappedByUserId: 'user-2',
      provider: 'google',
      accessToken: 'ACCESS-2',
      refreshToken: 'REFRESH-2',
      accessTokenExpiresInSec: 3600,
    })
    expect(second.inserted).toBe(false)

    const afterBootstrap = await getOAuthGrant(db, KEY, sharedKey(server, 'ctx-1'))
    expect(afterBootstrap?.accessToken).toBe('ACCESS-1')
    expect(afterBootstrap?.bootstrappedByUserId).toBe('user-1')

    // Token refresh (upsert by key) rotates the tokens but MUST NOT rewrite the
    // audit column or the shared identity.
    await upsertOAuthGrant(db, KEY, {
      ...sharedKey(server, 'ctx-1'),
      provider: 'google',
      accessToken: 'ACCESS-3',
      refreshToken: 'REFRESH-3',
      accessTokenExpiresInSec: 3600,
    })
    const afterRefresh = await getOAuthGrant(db, KEY, sharedKey(server, 'ctx-1'))
    expect(afterRefresh?.accessToken).toBe('ACCESS-3')
    expect(afterRefresh?.refreshToken).toBe('REFRESH-3')
    expect(afterRefresh?.bootstrappedByUserId).toBe('user-1')
  })

  it('shared grants of distinct context_id coexist (key disjunction)', async () => {
    const server = 'gdrive-b'
    await bootstrapSharedOAuthGrant(db, KEY, {
      ...sharedKey(server, 'ctx-A'),
      bootstrappedByUserId: 'user-1',
      provider: 'google',
      accessToken: 'A-TOKEN',
    })
    await bootstrapSharedOAuthGrant(db, KEY, {
      ...sharedKey(server, 'ctx-B'),
      bootstrappedByUserId: 'user-9',
      provider: 'google',
      accessToken: 'B-TOKEN',
    })
    const a = await getOAuthGrant(db, KEY, sharedKey(server, 'ctx-A'))
    const b = await getOAuthGrant(db, KEY, sharedKey(server, 'ctx-B'))
    expect(a?.accessToken).toBe('A-TOKEN')
    expect(a?.bootstrappedByUserId).toBe('user-1')
    expect(b?.accessToken).toBe('B-TOKEN')
    expect(b?.bootstrappedByUserId).toBe('user-9')
  })

  it('a user grant and a shared grant of the same server do not collide', async () => {
    const server = 'gdrive-c'
    await upsertOAuthGrant(db, KEY, {
      grantKind: 'user',
      ownerKind: 'mcpserver',
      recipeNamespace: config.mcpServersNamespace,
      recipeName: server,
      userId: 'user-1',
      oauthClientId: 'google-drive',
      provider: 'google',
      accessToken: 'USER-TOKEN',
    })
    await bootstrapSharedOAuthGrant(db, KEY, {
      ...sharedKey(server, 'ctx-1'),
      bootstrappedByUserId: 'user-2',
      provider: 'google',
      accessToken: 'SHARED-TOKEN',
    })
    const userGrant = await getOAuthGrant(db, KEY, {
      grantKind: 'user',
      ownerKind: 'mcpserver',
      recipeNamespace: config.mcpServersNamespace,
      recipeName: server,
      userId: 'user-1',
      oauthClientId: 'google-drive',
    })
    const sharedGrant = await getOAuthGrant(db, KEY, sharedKey(server, 'ctx-1'))
    expect(userGrant?.accessToken).toBe('USER-TOKEN')
    expect(sharedGrant?.accessToken).toBe('SHARED-TOKEN')
  })
})
