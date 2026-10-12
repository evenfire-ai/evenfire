import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { config } from '../src/config.js'
import type { DbClient } from '../src/db.js'
import { initDb } from '../src/db.js'
import {
  type UpsertDynamicClientInput,
  bindDynamicClientToResource,
  getDynamicClient,
  insertDynamicClientPending,
} from '../src/oauth/dynamicClientStore.js'
import { deriveOAuthEncryptionKey } from '../src/oauth/encryption.js'
import { teardownMcpServerOAuthState } from '../src/oauth/mcpServerOAuthTeardown.js'
import {
  bootstrapSharedOAuthGrant,
  oauthGrantExists,
  upsertOAuthGrant,
} from '../src/oauth/store.js'
import { rootLogger } from '../src/observability/logger.js'
import { makeDcrTransport } from './fixtures/remoteOAuthDiscovery.js'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'

/**
 * R3-H5 (T1/T3/T4) — the uninstall OAuth teardown fenced by the CR uid, observed as
 * SURVIVING ROWS and the exact RFC 7592 DELETE fired (T4), never as SQL text. All
 * rows are seeded by the REAL producers (insertDynamicClientPending + bind for DCR;
 * upsert/bootstrap for grants) and read through the REAL readers (T1).
 *
 * Gated on a real Postgres:
 *   CONTROL_API_REAL_PG_ADMIN_URL=postgres://<u>:<p>@<host>:5432/<db> npm test -- \
 *     test/oauth.mcpServerOAuthTeardown.realPostgres.integration.test.ts
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
const PUBLIC_IP = async () => ['93.184.216.34']

describeRealPostgres('teardownMcpServerOAuthState — fenced by cr_uid (real Postgres)', () => {
  const database = `control_api_teardown_${randomUUID().replace(/-/g, '')}`
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
    try {
      await endPoolAndWaitForClients(dbPool)
      if (adminPool) {
        await adminPool.query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
            WHERE datname = $1 AND pid <> pg_backend_pid()`,
          [database]
        )
        await adminPool.query(`DROP DATABASE IF EXISTS "${database.replace(/"/g, '""')}"`)
      }
    } finally {
      await adminPool?.end()
    }
  })

  const dcrCreds = (serverName: string, tag: string): UpsertDynamicClientInput => ({
    serverNamespace: NS,
    serverName,
    issuer: 'https://as.example.com',
    clientId: `cid-${tag}`,
    clientMode: 'confidential',
    clientSecret: `secret-${tag}`,
    registrationAccessToken: `rat-${tag}`,
    registrationClientUri: `https://as.example.com/register/${tag}`,
  })

  it('deletes the U-bound dynamic client and revokes ONLY its client', async () => {
    const name = `srv-tp-own-${randomUUID().slice(0, 8)}`
    const install = randomUUID()
    const U = randomUUID()
    await insertDynamicClientPending(db, KEY, { ...dcrCreds(name, 'own'), installId: install })
    await bindDynamicClientToResource(db, { serverNamespace: NS, serverName: name }, install, U)

    const { transport, calls } = makeDcrTransport({ responseJson: '' })
    const result = await teardownMcpServerOAuthState(
      db,
      KEY,
      { transport, resolveDns: PUBLIC_IP },
      { namespace: NS, name, crUid: U },
      rootLogger
    )

    expect(result.dynamicClient).toBe('done')
    expect(await getDynamicClient(db, KEY, { serverNamespace: NS, serverName: name })).toBeNull()
    // Exactly this row's client was revoked at the AS.
    const deletes = calls.filter(c => c.method === 'DELETE').map(c => c.url)
    expect(deletes).toEqual(['https://as.example.com/register/own'])
  })

  // Window B: the reinstall (uid U′) wrote its row BEFORE the old teardown ran. The
  // name-only teardown would read+revoke THIS new client; the fenced one leaves it be.
  it('leaves a reinstall row (uid U′) intact and does NOT revoke its client (Window B)', async () => {
    const name = `srv-tp-reinstall-${randomUUID().slice(0, 8)}`
    const install = randomUUID()
    const Uprime = randomUUID()
    const U = randomUUID() // the uninstalled (older) install's uid
    await insertDynamicClientPending(db, KEY, {
      ...dcrCreds(name, 'reinstall'),
      installId: install,
    })
    await bindDynamicClientToResource(
      db,
      { serverNamespace: NS, serverName: name },
      install,
      Uprime
    )

    const { transport, calls } = makeDcrTransport({ responseJson: '' })
    const result = await teardownMcpServerOAuthState(
      db,
      KEY,
      { transport, resolveDns: PUBLIC_IP },
      { namespace: NS, name, crUid: U },
      rootLogger
    )

    // The reinstall's row is a DIFFERENT uid → not claimed → 'none'.
    expect(result.dynamicClient).toBe('none')
    const survivor = await getDynamicClient(db, KEY, { serverNamespace: NS, serverName: name })
    expect(survivor?.crUid).toBe(Uprime)
    expect(calls.filter(c => c.method === 'DELETE')).toHaveLength(0)
  })

  it('deletes a legacy dynamic client row (both identity columns NULL)', async () => {
    const name = `srv-tp-legacy-${randomUUID().slice(0, 8)}`
    const install = randomUUID()
    await insertDynamicClientPending(db, KEY, { ...dcrCreds(name, 'legacy'), installId: install })
    // Emulate a pre-0121 legacy row: null the identity columns the migration added
    // (the encrypted creds still came from the real producer above).
    await db.query(
      `UPDATE dynamic_clients SET install_id = NULL, cr_uid = NULL
        WHERE owner_kind = 'mcpserver' AND server_namespace = $1 AND server_name = $2`,
      [NS, name]
    )

    const { transport, calls } = makeDcrTransport({ responseJson: '' })
    const result = await teardownMcpServerOAuthState(
      db,
      KEY,
      { transport, resolveDns: PUBLIC_IP },
      { namespace: NS, name, crUid: randomUUID() },
      rootLogger
    )
    expect(result.dynamicClient).toBe('done')
    expect(await getDynamicClient(db, KEY, { serverNamespace: NS, serverName: name })).toBeNull()
    expect(calls.filter(c => c.method === 'DELETE').map(c => c.url)).toEqual([
      'https://as.example.com/register/legacy',
    ])
  })

  it('purges this uid + legacy grants and spares a reinstall grant (uid U′)', async () => {
    const name = `srv-tp-grants-${randomUUID().slice(0, 8)}`
    const U = randomUUID()
    const Uprime = randomUUID()

    await upsertOAuthGrant(db, KEY, {
      grantKind: 'user',
      ownerKind: 'mcpserver',
      recipeNamespace: NS,
      recipeName: name,
      userId: 'user-u',
      oauthClientId: 'client',
      provider: 'google',
      accessToken: 'at-u',
      crUid: U,
    })
    await upsertOAuthGrant(db, KEY, {
      grantKind: 'user',
      ownerKind: 'mcpserver',
      recipeNamespace: NS,
      recipeName: name,
      userId: 'user-legacy',
      oauthClientId: 'client',
      provider: 'google',
      accessToken: 'at-legacy',
      // no crUid → legacy row
    })
    await upsertOAuthGrant(db, KEY, {
      grantKind: 'user',
      ownerKind: 'mcpserver',
      recipeNamespace: NS,
      recipeName: name,
      userId: 'user-reinstall',
      oauthClientId: 'client',
      provider: 'google',
      accessToken: 'at-reinstall',
      crUid: Uprime,
    })

    const { transport } = makeDcrTransport({ responseJson: '' })
    const result = await teardownMcpServerOAuthState(
      db,
      KEY,
      { transport, resolveDns: PUBLIC_IP },
      { namespace: NS, name, crUid: U },
      rootLogger
    )
    expect(result.grants).toBe('done')

    // Each row is read by the installation that could see it, so a `false` means
    // the row is gone rather than merely invisible to a foreign uid.
    const exists = (userId: string, crUid: string) =>
      oauthGrantExists(db, {
        grantKind: 'user',
        ownerKind: 'mcpserver',
        recipeNamespace: NS,
        recipeName: name,
        userId,
        oauthClientId: 'client',
        crUid,
      })
    expect(await exists('user-u', U)).toBe(false)
    // No reader key sees an unsealed row unless it names the row's provider, so the
    // legacy row is checked on the table itself: a fenced read would be `false`
    // whether or not the purge ran.
    const legacyRows = await db.query(
      `SELECT 1 FROM oauth_grants
        WHERE owner_kind = 'mcpserver' AND recipe_namespace = $1 AND recipe_name = $2
          AND user_id = 'user-legacy'`,
      [NS, name]
    )
    expect(legacyRows.rows).toHaveLength(0)
    // The reinstall's grant (uid U′) survives (R3-H5).
    expect(await exists('user-reinstall', Uprime)).toBe(true)
  })

  it('a server with no OAuth state is a clean no-op (none/none, no revoke)', async () => {
    const name = `srv-tp-clean-${randomUUID().slice(0, 8)}`
    const { transport, calls } = makeDcrTransport({ responseJson: '' })
    const result = await teardownMcpServerOAuthState(
      db,
      KEY,
      { transport, resolveDns: PUBLIC_IP },
      { namespace: NS, name, crUid: randomUUID() },
      rootLogger
    )
    expect(result).toEqual({ dynamicClient: 'none', grants: 'none' })
    expect(calls.filter(c => c.method === 'DELETE')).toHaveLength(0)
  })
})

// D-T3: the callback-side producer semantics that seal grants to an installation.
describeRealPostgres('grant cr_uid sealing (D-T3, real Postgres)', () => {
  const database = `control_api_sealing_${randomUUID().replace(/-/g, '')}`
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
    try {
      await endPoolAndWaitForClients(dbPool)
      if (adminPool) {
        await adminPool.query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
            WHERE datname = $1 AND pid <> pg_backend_pid()`,
          [database]
        )
        await adminPool.query(`DROP DATABASE IF EXISTS "${database.replace(/"/g, '""')}"`)
      }
    } finally {
      await adminPool?.end()
    }
  })

  async function grantCrUid(name: string, contextId?: string): Promise<string | null> {
    const res = await dbPool.query(
      contextId
        ? `SELECT cr_uid FROM oauth_grants WHERE owner_kind='mcpserver' AND recipe_namespace=$1
             AND recipe_name=$2 AND context_id=$3 AND grant_kind='shared'`
        : `SELECT cr_uid FROM oauth_grants WHERE owner_kind='mcpserver' AND recipe_namespace=$1
             AND recipe_name=$2 AND grant_kind='user'`,
      contextId ? [NS, name, contextId] : [NS, name]
    )
    return (res.rows[0] as { cr_uid: string | null }).cr_uid
  }

  it('upsertOAuthGrant (user) seals cr_uid and re-seals it on the latest consent', async () => {
    const name = `srv-seal-user-${randomUUID().slice(0, 8)}`
    const U = randomUUID()
    const Uprime = randomUUID()
    await upsertOAuthGrant(db, KEY, {
      grantKind: 'user',
      ownerKind: 'mcpserver',
      recipeNamespace: NS,
      recipeName: name,
      userId: 'user-a',
      oauthClientId: 'client',
      provider: 'google',
      accessToken: 'at-1',
      crUid: U,
    })
    expect(await grantCrUid(name)).toBe(U)
    // A later consent (reinstall) re-seals the SAME row with the new uid.
    await upsertOAuthGrant(db, KEY, {
      grantKind: 'user',
      ownerKind: 'mcpserver',
      recipeNamespace: NS,
      recipeName: name,
      userId: 'user-a',
      oauthClientId: 'client',
      provider: 'google',
      accessToken: 'at-2',
      crUid: Uprime,
    })
    expect(await grantCrUid(name)).toBe(Uprime)
  })

  it('bootstrapSharedOAuthGrant: same uid → no replace; different uid / legacy → replace', async () => {
    const name = `srv-seal-shared-${randomUUID().slice(0, 8)}`
    const ctx = 'ctx-A'
    const U = randomUUID()
    const Uprime = randomUUID()

    const first = await bootstrapSharedOAuthGrant(db, KEY, {
      ownerKind: 'mcpserver',
      recipeNamespace: NS,
      recipeName: name,
      contextId: ctx,
      oauthClientId: 'client',
      bootstrappedByUserId: 'user-a',
      provider: 'google',
      accessToken: 'shared-1',
      crUid: U,
    })
    expect(first.inserted).toBe(true)
    expect(await grantCrUid(name, ctx)).toBe(U)

    // Same uid, second member of the SAME install → first bootstrapper wins (no replace).
    const sameUid = await bootstrapSharedOAuthGrant(db, KEY, {
      ownerKind: 'mcpserver',
      recipeNamespace: NS,
      recipeName: name,
      contextId: ctx,
      oauthClientId: 'client',
      bootstrappedByUserId: 'user-b',
      provider: 'google',
      accessToken: 'shared-2',
      crUid: U,
    })
    expect(sameUid.inserted).toBe(false)
    expect(await grantCrUid(name, ctx)).toBe(U)

    // Different uid (reinstall) → this is not the same install's first bootstrapper;
    // the stale row is replaced and re-sealed to the new uid.
    const otherUid = await bootstrapSharedOAuthGrant(db, KEY, {
      ownerKind: 'mcpserver',
      recipeNamespace: NS,
      recipeName: name,
      contextId: ctx,
      oauthClientId: 'client',
      bootstrappedByUserId: 'user-c',
      provider: 'google',
      accessToken: 'shared-3',
      crUid: Uprime,
    })
    expect(otherUid.inserted).toBe(true)
    expect(await grantCrUid(name, ctx)).toBe(Uprime)
  })
})
