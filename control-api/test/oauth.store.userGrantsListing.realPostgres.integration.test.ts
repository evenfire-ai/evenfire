import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { config } from '../src/config.js'
import type { DbClient } from '../src/db.js'
import { initDb } from '../src/db.js'
import { deriveOAuthEncryptionKey } from '../src/oauth/encryption.js'
import {
  deleteOAuthGrant,
  listUserGrantsForServer,
  listUserOAuthGrants,
  upsertOAuthGrant,
} from '../src/oauth/store.js'

// T1/T3/T4/T5 (spec 04 U1/U3) — the owner-generalised grant listing exercised
// against grants written by the REAL producer (`upsertOAuthGrant`), never a
// hand-built oauth_grants fixture (the mcpserver recipe_namespace/recipe_name
// shape is subtle). Gated on a real Postgres, like the other
// *.realPostgres.integration.test.ts:
//   CONTROL_API_REAL_PG_ADMIN_URL=postgres://<user>:<pass>@<host>:5432 npm test -- \
//     test/oauth.store.userGrantsListing.realPostgres.integration.test.ts
//
// T3: "the user sees their mcpserver grant via listUserOAuthGrants('all')" FAILS
// at the parent sha (16efcaa7e), where listUserOAuthGrants takes (db, userId) and
// hardcodes owner_kind='recipe' — the third arg is ignored and the mcpserver
// grant never appears.
const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip

function databaseUrl(baseUrl: string, database: string): string {
  const url = new URL(baseUrl)
  url.pathname = `/${database}`
  return url.toString()
}

const KEY = deriveOAuthEncryptionKey(config.oauthEncryptionKey)
const USER = 'user-42'
const MCP_NS = config.mcpServersNamespace
const RECIPE_NS = config.sandboxNamespace

describeRealPostgres('listUserOAuthGrants / listUserGrantsForServer (real Postgres)', () => {
  const database = `control_api_user_grants_${randomUUID().replace(/-/g, '')}`
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

  beforeEach(async () => {
    await dbPool.query('DELETE FROM oauth_grants')
  })

  // The two grants the user actually owns, written by the real ALTA path.
  async function seedRecipeAndMcpserverGrants(): Promise<void> {
    await upsertOAuthGrant(db, KEY, {
      grantKind: 'user',
      // owner_kind defaults to 'recipe'
      recipeNamespace: RECIPE_NS,
      recipeName: 'leadforge',
      userId: USER,
      oauthClientId: 'google-gmail',
      provider: 'google',
      accessToken: 'RECIPE-TOKEN',
    })
    await upsertOAuthGrant(db, KEY, {
      grantKind: 'user',
      ownerKind: 'mcpserver',
      recipeNamespace: MCP_NS,
      recipeName: 'gdrive',
      userId: USER,
      oauthClientId: 'self://as.example/x',
      provider: 'remote',
      accessToken: 'MCP-TOKEN',
    })
  }

  it("T3/T4 — 'all' surfaces both owners with ownerKind + mcpServerName; default stays recipe-only (T5)", async () => {
    await seedRecipeAndMcpserverGrants()

    const all = await listUserOAuthGrants(db, USER, 'all')
    const byServer = Object.fromEntries(all.map(g => [g.recipeName, g]))
    expect(all).toHaveLength(2)
    expect(byServer.leadforge).toMatchObject({ ownerKind: 'recipe' })
    expect(byServer.leadforge.mcpServerName).toBeUndefined()
    expect(byServer.gdrive).toMatchObject({
      ownerKind: 'mcpserver',
      mcpServerName: 'gdrive',
      oauthClientId: 'self://as.example/x',
    })

    // T5 — the default preserves the historical recipe-only behavior: the
    // mcpserver grant is NOT returned.
    const recipeOnly = await listUserOAuthGrants(db, USER)
    expect(recipeOnly).toHaveLength(1)
    expect(recipeOnly[0]).toMatchObject({ ownerKind: 'recipe', recipeName: 'leadforge' })
  })

  it('T4 — the mcpserver grant disappears from the observable list after deleteOAuthGrant', async () => {
    await seedRecipeAndMcpserverGrants()
    expect(await listUserOAuthGrants(db, USER, 'all')).toHaveLength(2)

    const deleted = await deleteOAuthGrant(db, {
      grantKind: 'user',
      ownerKind: 'mcpserver',
      recipeNamespace: MCP_NS,
      recipeName: 'gdrive',
      userId: USER,
      oauthClientId: 'self://as.example/x',
    })
    expect(deleted).toBe(1)

    const after = await listUserOAuthGrants(db, USER, 'all')
    expect(after).toHaveLength(1)
    expect(after[0]).toMatchObject({ ownerKind: 'recipe', recipeName: 'leadforge' })
  })

  it('listUserGrantsForServer lists all users of a server across clients (U3 admin oversight)', async () => {
    // Two users, two clients on the same server — plus a recipe grant that must
    // never bleed into the server listing.
    await upsertOAuthGrant(db, KEY, {
      grantKind: 'user',
      ownerKind: 'mcpserver',
      recipeNamespace: MCP_NS,
      recipeName: 'gdrive',
      userId: 'user-a',
      oauthClientId: 'self://client-1',
      provider: 'remote',
      accessToken: 'A1',
    })
    await upsertOAuthGrant(db, KEY, {
      grantKind: 'user',
      ownerKind: 'mcpserver',
      recipeNamespace: MCP_NS,
      recipeName: 'gdrive',
      userId: 'user-b',
      oauthClientId: 'self://client-2',
      provider: 'remote',
      accessToken: 'B2',
    })
    await upsertOAuthGrant(db, KEY, {
      grantKind: 'user',
      recipeNamespace: RECIPE_NS,
      recipeName: 'gdrive',
      userId: 'user-a',
      oauthClientId: 'google-gmail',
      provider: 'google',
      accessToken: 'RECIPE',
    })

    const rows = await listUserGrantsForServer(db, { namespace: MCP_NS, name: 'gdrive' })
    expect(rows).toHaveLength(2)
    expect(rows.map(r => `${r.userId}:${r.oauthClientId}`).sort()).toEqual([
      'user-a:self://client-1',
      'user-b:self://client-2',
    ])
  })
})
