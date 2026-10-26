import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import request from 'supertest'
import { createApp } from '../src/app.js'
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
import {
  seedActiveMember,
  seedAgentHost,
  seedAllowlistedContext,
} from './fixtures/contextAllowlist.js'
import { mintHccControlToken, resolveHccHostBinding } from './fixtures/hccControlToken.js'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'
import { MockGateway } from './mockGateway.js'

// T1 — the batch grant-existence resolver exercised against grant state built
// by the REAL producers (`upsertOAuthGrant` / `bootstrapSharedOAuthGrant` /
// `deleteOAuthGrant`), users and Host access written by the production writers
// (`seedActiveMember`), and the Host binding produced by the real
// `resolveBrokerHostBinding`. NO hand-built oauth_grants rows and NO hand-typed
// `exists` booleans. Gated on a real Postgres:
//   CONTROL_API_REAL_PG_ADMIN_URL=postgres://<user>:<pass>@<host>:5432 npm test -- \
//     test/routes.mcpOauth.grantsExists.realPostgres.integration.test.ts

// The membership writers and the route read through the app's shared pool;
// point it at this suite's database.
const testDb = vi.hoisted(() => ({ pool: undefined as import('pg').Pool | undefined }))

vi.mock('../src/db.js', async () => {
  const actual = await vi.importActual<typeof import('../src/db.js')>('../src/db.js')
  const current = () => {
    if (!testDb.pool) throw new Error('test pool not initialised')
    return testDb.pool
  }
  return {
    ...actual,
    pool: {
      query: (text: string, values?: unknown[]) => current().query(text, values),
      connect: () => current().connect(),
    },
    withTransaction: (work: Parameters<typeof actual.withTransaction>[0]) =>
      actual.withTransaction(work, current()),
  }
})

vi.mock('../src/services/notificationEmitter.js', () => ({
  emitNotification: vi.fn().mockResolvedValue(undefined),
  enqueueApprovalRequestedNotification: vi.fn().mockResolvedValue(undefined),
  enqueueApprovalUpdatedNotification: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../src/services/rateLimiterService.js', () => ({
  checkAndIncrement: vi.fn().mockResolvedValue({
    allowed: true,
    backendAvailable: true,
    remaining: 59,
    resetMs: Date.now() + 60_000,
    windowStartMs: Date.now(),
    count: 1,
  }),
}))

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
const HOST = 'agent-host'
const CONTEXT = 'ctx-authoritative'
// Allowlisted in CONTEXT; `ghost` is never installed.
const ALLOWLIST = ['gdrive-u', 'has-grant', 'no-grant', 'other-user', 'team-drive', 'ghost']

describeRealPostgres('resolveBatchGrantExistence (real Postgres)', () => {
  const database = `control_api_grants_exists_${randomUUID().replace(/-/g, '')}`
  let adminPool: Pool
  let dbPool: Pool
  let db: DbClient
  let gateway: MockGateway
  // Active users who enter HOST.
  let alice: string
  let bob: string
  const originalBrokerEnabled = config.mcpOauthBrokerEnabled

  beforeAll(async () => {
    if (!adminUrl) throw new Error('CONTROL_API_REAL_PG_ADMIN_URL is required')
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`CREATE DATABASE "${database.replace(/"/g, '""')}"`)
    dbPool = new Pool({ connectionString: databaseUrl(adminUrl, database) })
    await initDb({ connect: () => dbPool.connect() })
    db = { query: (text, values) => dbPool.query(text, values) }
    testDb.pool = dbPool
    alice = await seedActiveMember(db, { agents: [HOST] })
    bob = await seedActiveMember(db, { agents: [HOST] })
  })

  afterAll(async () => {
    try {
      testDb.pool = undefined
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

  beforeEach(async () => {
    await dbPool.query('DELETE FROM oauth_grants')
    gateway = new MockGateway(NS)
    await seedAgentHost(gateway, HOST, CONTEXT)
    await seedAllowlistedContext(gateway, CONTEXT, ALLOWLIST, config.contextsNamespace)
    config.mcpOauthBrokerEnabled = true
  })

  afterEach(() => {
    config.mcpOauthBrokerEnabled = originalBrokerEnabled
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

  const consentUser = (recipeName: string, userId: string, crUid?: string) =>
    upsertOAuthGrant(db, KEY, {
      grantKind: 'user',
      ownerKind: 'mcpserver',
      recipeNamespace: NS,
      recipeName,
      userId,
      oauthClientId: CLIENT_ID,
      provider: 'google',
      accessToken: `at-${userId}`,
      ...(crUid ? { crUid } : {}),
    })

  // The binding is resolved per sweep, as the route does on every batch.
  const resolve = async (queries: Parameters<typeof resolveBatchGrantExistence>[1]) =>
    resolveBatchGrantExistence(
      { db, gateway, binding: await resolveHccHostBinding(gateway, HOST), mcpServersNamespace: NS },
      queries
    )

  it('(a) reports exists:true for a per-user server once the grant is upserted', async () => {
    seedUserServer('gdrive-u')

    // No grant yet → false (definitive). Results echo the query's userId.
    expect(await resolve([{ mcpServerName: 'gdrive-u', userId: alice }])).toEqual([
      { mcpServerName: 'gdrive-u', userId: alice, exists: false },
    ])

    await consentUser('gdrive-u', alice)

    expect(await resolve([{ mcpServerName: 'gdrive-u', userId: alice }])).toEqual([
      { mcpServerName: 'gdrive-u', userId: alice, exists: true },
    ])
    // A different user without their own grant is still false.
    expect(await resolve([{ mcpServerName: 'gdrive-u', userId: bob }])).toEqual([
      { mcpServerName: 'gdrive-u', userId: bob, exists: false },
    ])
  })

  // A same-name reinstall gets a new uid. A grant consented against the previous
  // installation must read as gone, so mcp-host evicts the token it still caches.
  it('(uid) a grant of a previous installation reports exists:false after a same-name reinstall', async () => {
    const uidOf = async (name: string) =>
      ((await gateway.getResource('mcpservers', name, NS)) as { metadata: { uid: string } })
        .metadata.uid

    seedUserServer('gdrive-u')
    await consentUser('gdrive-u', alice, await uidOf('gdrive-u'))
    expect(await resolve([{ mcpServerName: 'gdrive-u', userId: alice }])).toEqual([
      { mcpServerName: 'gdrive-u', userId: alice, exists: true },
    ])

    // Uninstall without purging the grant, then reinstall under the same name.
    await gateway.deleteResource('mcpservers', 'gdrive-u', NS)
    seedUserServer('gdrive-u')
    await consentUser('gdrive-u', bob, await uidOf('gdrive-u'))

    expect(
      await resolve([
        { mcpServerName: 'gdrive-u', userId: alice },
        { mcpServerName: 'gdrive-u', userId: bob },
      ])
    ).toEqual([
      { mcpServerName: 'gdrive-u', userId: alice, exists: false },
      { mcpServerName: 'gdrive-u', userId: bob, exists: true },
    ])
  })

  it('(c2) distinguishes two userIds on the SAME server within one batch (real grants)', async () => {
    seedUserServer('gdrive-u')
    await consentUser('gdrive-u', alice)

    // Both partitions of the same server in ONE batch — distinguishable by the
    // echoed userId, not by position.
    expect(
      await resolve([
        { mcpServerName: 'gdrive-u', userId: bob },
        { mcpServerName: 'gdrive-u', userId: alice },
      ])
    ).toEqual([
      { mcpServerName: 'gdrive-u', userId: bob, exists: false },
      { mcpServerName: 'gdrive-u', userId: alice, exists: true },
    ])
  })

  it('(b) flips to exists:false after the grant is deleted', async () => {
    seedUserServer('gdrive-u')
    await consentUser('gdrive-u', alice)
    expect(await resolve([{ mcpServerName: 'gdrive-u', userId: alice }])).toEqual([
      { mcpServerName: 'gdrive-u', userId: alice, exists: true },
    ])

    await deleteOAuthGrant(db, {
      grantKind: 'user',
      ownerKind: 'mcpserver',
      recipeNamespace: NS,
      recipeName: 'gdrive-u',
      userId: alice,
      oauthClientId: CLIENT_ID,
    })

    expect(await resolve([{ mcpServerName: 'gdrive-u', userId: alice }])).toEqual([
      { mcpServerName: 'gdrive-u', userId: alice, exists: false },
    ])
  })

  it('(c) mixed batch: results correspond by mcpServerName across present/absent grants', async () => {
    seedUserServer('has-grant')
    seedUserServer('no-grant')
    seedUserServer('other-user') // grant exists for someone else, not the caller

    await consentUser('has-grant', alice)
    await consentUser('other-user', bob)

    // Observable output (T4): the full results list, in request order, each
    // echoing its query coordinates.
    expect(
      await resolve([
        { mcpServerName: 'no-grant', userId: alice },
        { mcpServerName: 'has-grant', userId: alice },
        { mcpServerName: 'other-user', userId: alice },
      ])
    ).toEqual([
      { mcpServerName: 'no-grant', userId: alice, exists: false },
      { mcpServerName: 'has-grant', userId: alice, exists: true },
      { mcpServerName: 'other-user', userId: alice, exists: false },
    ])
  })

  it('(e) context server of the Host Context: keyed by it; a lying body contextId does not change the answer', async () => {
    seedContextServer('team-drive', CONTEXT)
    await bootstrapSharedOAuthGrant(db, KEY, {
      ownerKind: 'mcpserver',
      recipeNamespace: NS,
      recipeName: 'team-drive',
      contextId: CONTEXT,
      oauthClientId: CLIENT_ID,
      bootstrappedByUserId: alice,
      provider: 'google',
      accessToken: 'A',
    })

    // The lying body contextId is echoed back verbatim but never used to key.
    expect(
      await resolve([{ mcpServerName: 'team-drive', userId: 'anyone', contextId: 'ctx-foreign' }])
    ).toEqual([
      { mcpServerName: 'team-drive', userId: 'anyone', contextId: 'ctx-foreign', exists: true },
    ])

    await deleteOAuthGrant(db, {
      grantKind: 'shared',
      ownerKind: 'mcpserver',
      recipeNamespace: NS,
      recipeName: 'team-drive',
      contextId: CONTEXT,
      oauthClientId: CLIENT_ID,
    })
    expect(
      await resolve([{ mcpServerName: 'team-drive', userId: 'anyone', contextId: CONTEXT }])
    ).toEqual([
      { mcpServerName: 'team-drive', userId: 'anyone', contextId: CONTEXT, exists: false },
    ])
  })

  it('R6: a context server owned by another Context → false although its shared grant exists (I-1)', async () => {
    seedContextServer('team-drive', 'ctx-other')
    await bootstrapSharedOAuthGrant(db, KEY, {
      ownerKind: 'mcpserver',
      recipeNamespace: NS,
      recipeName: 'team-drive',
      contextId: 'ctx-other',
      oauthClientId: CLIENT_ID,
      bootstrappedByUserId: alice,
      provider: 'google',
      accessToken: 'A',
    })
    expect(await resolve([{ mcpServerName: 'team-drive' }])).toEqual([
      { mcpServerName: 'team-drive', exists: false },
    ])
  })

  it('GE3 (S05-D10): a missing server in the allowlist fails open (exists:true)', async () => {
    // Allowlisted, never installed → getResource throws K8sNotFoundError.
    expect(await resolve([{ mcpServerName: 'ghost', userId: alice }])).toEqual([
      { mcpServerName: 'ghost', userId: alice, exists: true },
    ])
  })

  it('GE3 (S05-D10): a server outside the allowlist is false even with a grant', async () => {
    seedUserServer('elsewhere')
    await consentUser('elsewhere', alice)
    expect(await resolve([{ mcpServerName: 'elsewhere', userId: alice }])).toEqual([
      { mcpServerName: 'elsewhere', userId: alice, exists: false },
    ])
  })

  it('R7: a user who cannot enter the Host is false although the grant exists (I-3)', async () => {
    const outsider = await seedActiveMember(db, { contexts: [CONTEXT], agents: ['sibling-host'] })
    seedUserServer('gdrive-u')
    await consentUser('gdrive-u', outsider)
    expect(await resolve([{ mcpServerName: 'gdrive-u', userId: outsider }])).toEqual([
      { mcpServerName: 'gdrive-u', userId: outsider, exists: false },
    ])
  })

  it('R7e: ids that are not canonical UUIDs are false, never a fail-open error', async () => {
    seedUserServer('gdrive-u')
    // The braced and hyphen-less spellings are valid Postgres uuid input; each
    // carries its own grant, so only the format rule can refuse them.
    const variants = ['U024BE7LH', 'e2e-vitest-runtime', `{${alice}}`, alice.replace(/-/g, '')]
    for (const id of variants) await consentUser('gdrive-u', id)
    expect(await resolve(variants.map(userId => ({ mcpServerName: 'gdrive-u', userId })))).toEqual(
      variants.map(userId => ({ mcpServerName: 'gdrive-u', userId, exists: false }))
    )
  })

  it('R7e: an upper-case UUID is evaluated, not rejected by format', async () => {
    seedUserServer('gdrive-u')
    const upper = alice.toUpperCase()
    await consentUser('gdrive-u', upper)
    expect(await resolve([{ mcpServerName: 'gdrive-u', userId: upper }])).toEqual([
      { mcpServerName: 'gdrive-u', userId: upper, exists: true },
    ])
  })

  it('GE1: through the route, a Host that no longer binds answers every entry false', async () => {
    seedUserServer('gdrive-u')
    await consentUser('gdrive-u', alice)
    const app = createApp(gateway as never)
    const token = await mintHccControlToken(app, gateway, HOST)
    const sweep = () =>
      request(app)
        .post('/api/v1/mcp-oauth/grants/exists')
        .set('Authorization', `Bearer ${token}`)
        .send({ queries: [{ mcpServerName: 'gdrive-u', userId: alice }] })

    // Precondition: bound, the real grant answers.
    expect((await sweep()).body.results).toEqual([
      { mcpServerName: 'gdrive-u', userId: alice, exists: true },
    ])

    await gateway.deleteResource('hosts', HOST, config.hostsNamespace)
    const res = await sweep()
    expect(res.status).toBe(200)
    expect(res.body.results).toEqual([{ mcpServerName: 'gdrive-u', userId: alice, exists: false }])
  })
})
