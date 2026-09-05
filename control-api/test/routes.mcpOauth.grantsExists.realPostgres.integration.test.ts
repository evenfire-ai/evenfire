import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { config } from '../src/config.js'
import type { DbClient } from '../src/db.js'
import { initDb } from '../src/db.js'
import { deriveOAuthEncryptionKey } from '../src/oauth/encryption.js'
import {
  bootstrapSharedOAuthGrant,
  deleteOAuthGrant,
  upsertOAuthGrant,
} from '../src/oauth/store.js'
import { resolveBatchGrantExistence } from '../src/routes/mcpOauth.js'
import { MockGateway } from './mockGateway.js'

// T1 — the batch grant-existence resolver (mini-spec 13 §4.1) exercised against
// grant state built by the REAL producers (`upsertOAuthGrant` /
// `bootstrapSharedOAuthGrant` / `deleteOAuthGrant`) and read by the REAL
// `oauthGrantExists` inside the resolver. NO hand-built oauth_grants rows and NO
// hand-typed `exists` booleans. Gated on a real Postgres, like the store and
// grant-gate integration tests:
//   CONTROL_API_REAL_PG_ADMIN_URL=postgres://<user>:<pass>@<host>:5432 npm test -- \
//     test/routes.mcpOauth.grantsExists.realPostgres.integration.test.ts
const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip

function databaseUrl(baseUrl: string, database: string): string {
  const url = new URL(baseUrl)
  url.pathname = `/${database}`
  return url.toString()
}

const KEY = deriveOAuthEncryptionKey(config.oauthEncryptionKey)
const NS = config.mcpServersNamespace
const CLIENT_ID = 'google-drive'

describeRealPostgres('resolveBatchGrantExistence (real Postgres)', () => {
  const database = `control_api_grants_exists_${randomUUID().replace(/-/g, '')}`
  let adminPool: Pool
  let dbPool: Pool
  let db: DbClient
  let gateway: MockGateway

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
    gateway = new MockGateway(NS)
  })

  function seedUserServer(name: string): void {
    void gateway.createResource(
      'mcpservers',
      {
        metadata: { name },
        spec: {
          enabled: true,
          auth: { type: 'oauth' },
          transport: { url: `http://${name}.${NS}.svc:3000/mcp` },
          oauth: { id: CLIENT_ID, provider: 'google', grantScope: 'user' },
        },
      },
      NS
    )
  }

  function seedContextServer(name: string, contextRef: string): void {
    void gateway.createResource(
      'mcpservers',
      {
        metadata: { name },
        spec: {
          enabled: true,
          auth: { type: 'oauth' },
          transport: { url: `http://${name}.${NS}.svc:3000/mcp` },
          contextRef,
          oauth: { id: CLIENT_ID, provider: 'google', grantScope: 'context' },
        },
      },
      NS
    )
  }

  const resolve = (queries: Parameters<typeof resolveBatchGrantExistence>[1]) =>
    resolveBatchGrantExistence({ db, gateway, mcpServersNamespace: NS }, queries)

  it('(a) reports exists:true for a per-user server once the grant is upserted', async () => {
    seedUserServer('gdrive-u')

    // No grant yet → false (definitive). Results echo the query's userId.
    expect(await resolve([{ mcpServerName: 'gdrive-u', userId: 'alice' }])).toEqual([
      { mcpServerName: 'gdrive-u', userId: 'alice', exists: false },
    ])

    await upsertOAuthGrant(db, KEY, {
      grantKind: 'user',
      ownerKind: 'mcpserver',
      recipeNamespace: NS,
      recipeName: 'gdrive-u',
      userId: 'alice',
      oauthClientId: CLIENT_ID,
      provider: 'google',
      accessToken: 'A',
    })

    expect(await resolve([{ mcpServerName: 'gdrive-u', userId: 'alice' }])).toEqual([
      { mcpServerName: 'gdrive-u', userId: 'alice', exists: true },
    ])
    // A different user without their own grant is still false.
    expect(await resolve([{ mcpServerName: 'gdrive-u', userId: 'bob' }])).toEqual([
      { mcpServerName: 'gdrive-u', userId: 'bob', exists: false },
    ])
  })

  it('(c2) distinguishes two userIds on the SAME server within one batch (real grants)', async () => {
    seedUserServer('gdrive-u')
    // alice consents; bob does not.
    await upsertOAuthGrant(db, KEY, {
      grantKind: 'user',
      ownerKind: 'mcpserver',
      recipeNamespace: NS,
      recipeName: 'gdrive-u',
      userId: 'alice',
      oauthClientId: CLIENT_ID,
      provider: 'google',
      accessToken: 'A',
    })

    // Both partitions of the same server in ONE batch — distinguishable by the
    // echoed userId, not by position (FIX A).
    const results = await resolve([
      { mcpServerName: 'gdrive-u', userId: 'bob' },
      { mcpServerName: 'gdrive-u', userId: 'alice' },
    ])
    expect(results).toEqual([
      { mcpServerName: 'gdrive-u', userId: 'bob', exists: false },
      { mcpServerName: 'gdrive-u', userId: 'alice', exists: true },
    ])
  })

  it('(b) flips to exists:false after the grant is deleted', async () => {
    seedUserServer('gdrive-u')
    await upsertOAuthGrant(db, KEY, {
      grantKind: 'user',
      ownerKind: 'mcpserver',
      recipeNamespace: NS,
      recipeName: 'gdrive-u',
      userId: 'alice',
      oauthClientId: CLIENT_ID,
      provider: 'google',
      accessToken: 'A',
    })
    expect(await resolve([{ mcpServerName: 'gdrive-u', userId: 'alice' }])).toEqual([
      { mcpServerName: 'gdrive-u', userId: 'alice', exists: true },
    ])

    await deleteOAuthGrant(db, {
      grantKind: 'user',
      ownerKind: 'mcpserver',
      recipeNamespace: NS,
      recipeName: 'gdrive-u',
      userId: 'alice',
      oauthClientId: CLIENT_ID,
    })

    expect(await resolve([{ mcpServerName: 'gdrive-u', userId: 'alice' }])).toEqual([
      { mcpServerName: 'gdrive-u', userId: 'alice', exists: false },
    ])
  })

  it('(c) mixed batch: results correspond by mcpServerName across present/absent grants', async () => {
    seedUserServer('has-grant')
    seedUserServer('no-grant')
    seedUserServer('other-user') // grant exists for someone else, not the caller

    await upsertOAuthGrant(db, KEY, {
      grantKind: 'user',
      ownerKind: 'mcpserver',
      recipeNamespace: NS,
      recipeName: 'has-grant',
      userId: 'alice',
      oauthClientId: CLIENT_ID,
      provider: 'google',
      accessToken: 'A',
    })
    await upsertOAuthGrant(db, KEY, {
      grantKind: 'user',
      ownerKind: 'mcpserver',
      recipeNamespace: NS,
      recipeName: 'other-user',
      userId: 'someone-else',
      oauthClientId: CLIENT_ID,
      provider: 'google',
      accessToken: 'A',
    })

    const results = await resolve([
      { mcpServerName: 'no-grant', userId: 'alice' },
      { mcpServerName: 'has-grant', userId: 'alice' },
      { mcpServerName: 'other-user', userId: 'alice' },
    ])

    // Observable output (T4): the full results list, in request order, each
    // echoing its query coordinates.
    expect(results).toEqual([
      { mcpServerName: 'no-grant', userId: 'alice', exists: false },
      { mcpServerName: 'has-grant', userId: 'alice', exists: true },
      { mcpServerName: 'other-user', userId: 'alice', exists: false },
    ])
  })

  it('(e) context server: keyed by spec.contextRef server-side; a lying body contextId does not change the answer', async () => {
    seedContextServer('team-drive', 'ctx-authoritative')

    // Bootstrap the shared identity for the AUTHORITATIVE context.
    await bootstrapSharedOAuthGrant(db, KEY, {
      ownerKind: 'mcpserver',
      recipeNamespace: NS,
      recipeName: 'team-drive',
      contextId: 'ctx-authoritative',
      oauthClientId: CLIENT_ID,
      bootstrappedByUserId: 'alice',
      provider: 'google',
      accessToken: 'A',
    })

    // Body contextId is a DIFFERENT (foreign) context, and userId varies — the
    // result must be driven ONLY by the server's authoritative contextRef.
    const withLie = await resolve([
      { mcpServerName: 'team-drive', userId: 'anyone', contextId: 'ctx-foreign' },
    ])
    // The lying body contextId is echoed back verbatim but never used to key.
    expect(withLie).toEqual([
      { mcpServerName: 'team-drive', userId: 'anyone', contextId: 'ctx-foreign', exists: true },
    ])

    // Delete the shared grant for the authoritative context → false, regardless
    // of the foreign body contextId (which, if trusted, would still be absent).
    await deleteOAuthGrant(db, {
      grantKind: 'shared',
      ownerKind: 'mcpserver',
      recipeNamespace: NS,
      recipeName: 'team-drive',
      contextId: 'ctx-authoritative',
      oauthClientId: CLIENT_ID,
    })
    const afterDelete = await resolve([
      { mcpServerName: 'team-drive', userId: 'anyone', contextId: 'ctx-authoritative' },
    ])
    expect(afterDelete).toEqual([
      {
        mcpServerName: 'team-drive',
        userId: 'anyone',
        contextId: 'ctx-authoritative',
        exists: false,
      },
    ])
  })

  it('fail-open: an unknown (deleted) server yields exists:true, never a spurious false', async () => {
    // No server seeded → getResource throws K8sNotFoundError → fail-open.
    expect(await resolve([{ mcpServerName: 'ghost', userId: 'alice' }])).toEqual([
      { mcpServerName: 'ghost', userId: 'alice', exists: true },
    ])
  })
})
