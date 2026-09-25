import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { config } from '../src/config.js'
import type { DbClient } from '../src/db.js'
import { initDb } from '../src/db.js'
import { deriveOAuthEncryptionKey } from '../src/oauth/encryption.js'
import {
  bootstrapSharedOAuthGrant,
  deleteOAuthGrantsForServer,
  oauthGrantExists,
  upsertOAuthGrant,
} from '../src/oauth/store.js'

/**
 * R1-L3 (T4) — the server-teardown purge (DEC-R2) observed as SURVIVING ROWS, not
 * as SQL text. The unit test (oauth/__tests__/deleteOAuthGrantsForServer.test.ts)
 * can only assert the emitted DELETE's shape because it has no DB; this pins the
 * observable outcome the uninstall actually depends on:
 *   - EVERY flavor of the target server's grants (user + shared/context) is gone;
 *   - a peer server's grant is untouched (the purge is scoped, not a blast radius).
 *
 * Rows are built by the REAL producers (upsertOAuthGrant / bootstrapSharedOAuthGrant)
 * and read through the REAL oauthGrantExists — no hand-built oauth_grants rows (T1).
 * Gated on a real Postgres like the other integration suites:
 *   CONTROL_API_REAL_PG_ADMIN_URL=postgres://<user>:<pass>@<host>:5432 npm test -- \
 *     test/oauth.deleteOAuthGrantsForServer.realPostgres.integration.test.ts
 */
const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip

function databaseUrl(baseUrl: string, database: string): string {
  const url = new URL(baseUrl)
  url.pathname = `/${database}`
  return url.toString()
}

const KEY = deriveOAuthEncryptionKey(config.oauthEncryptionKey)
const NS = config.mcpServersNamespace

describeRealPostgres('deleteOAuthGrantsForServer — full server-scoped wipe (real Postgres)', () => {
  const database = `control_api_delsrvgrants_${randomUUID().replace(/-/g, '')}`
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

  it('wipes every flavor of the target server and leaves a peer server intact', async () => {
    // Target server 'gdrive': one user grant + one shared/context grant.
    await upsertOAuthGrant(db, KEY, {
      grantKind: 'user',
      ownerKind: 'mcpserver',
      recipeNamespace: NS,
      recipeName: 'gdrive',
      userId: 'user-a',
      oauthClientId: 'google-drive',
      provider: 'google',
      accessToken: 'at-user-a',
      refreshToken: 'rt-user-a',
    })
    const { inserted } = await bootstrapSharedOAuthGrant(db, KEY, {
      ownerKind: 'mcpserver',
      recipeNamespace: NS,
      recipeName: 'gdrive',
      contextId: 'ctx-A',
      oauthClientId: 'google-drive',
      bootstrappedByUserId: 'user-a',
      provider: 'google',
      accessToken: 'shared-at',
      refreshToken: 'shared-rt',
    })
    expect(inserted).toBe(true)

    // Peer server 'teamdrive': a grant that MUST survive the gdrive purge.
    await upsertOAuthGrant(db, KEY, {
      grantKind: 'user',
      ownerKind: 'mcpserver',
      recipeNamespace: NS,
      recipeName: 'teamdrive',
      userId: 'user-a',
      oauthClientId: 'google-drive',
      provider: 'google',
      accessToken: 'at-peer',
      refreshToken: 'rt-peer',
    })

    const purged = await deleteOAuthGrantsForServer(db, {
      recipeNamespace: NS,
      recipeName: 'gdrive',
    })
    expect(purged).toBe(2)

    // Observable state (T4): both gdrive flavors are gone …
    expect(
      await oauthGrantExists(db, {
        grantKind: 'user',
        ownerKind: 'mcpserver',
        recipeNamespace: NS,
        recipeName: 'gdrive',
        userId: 'user-a',
        oauthClientId: 'google-drive',
      })
    ).toBe(false)
    expect(
      await oauthGrantExists(db, {
        grantKind: 'shared',
        ownerKind: 'mcpserver',
        recipeNamespace: NS,
        recipeName: 'gdrive',
        contextId: 'ctx-A',
        oauthClientId: 'google-drive',
      })
    ).toBe(false)
    // … and the peer server's grant is untouched (scoped purge, no blast radius).
    expect(
      await oauthGrantExists(db, {
        grantKind: 'user',
        ownerKind: 'mcpserver',
        recipeNamespace: NS,
        recipeName: 'teamdrive',
        userId: 'user-a',
        oauthClientId: 'google-drive',
      })
    ).toBe(true)
  })
})
