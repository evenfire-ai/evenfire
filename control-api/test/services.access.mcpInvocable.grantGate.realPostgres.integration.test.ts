import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { config } from '../src/config.js'
import type { DbClient } from '../src/db.js'
import { initDb } from '../src/db.js'
import { deriveOAuthEncryptionKey } from '../src/oauth/encryption.js'
import { bootstrapSharedOAuthGrant, upsertOAuthGrant } from '../src/oauth/store.js'
import { resolveInvocableMcpServersForContexts } from '../src/services/access/mcpInvocable.js'
import { MockGateway } from './mockGateway.js'

// T1 — the rpc-proxy grant-presence gate exercised end-to-end against grant
// state built by the REAL producers (`upsertOAuthGrant` / `bootstrapSharedOAuthGrant`)
// and read by the REAL `oauthGrantExists` inside the resolver. No hand-built
// oauth_grants rows. Gated on a real Postgres, like the store integration test:
//   CONTROL_API_REAL_PG_ADMIN_URL=postgres://user:pass@host:5432 npm test -- \
//     test/services.access.mcpInvocable.grantGate.realPostgres.integration.test.ts
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

describeRealPostgres('mcpInvocable grant-presence gate (real Postgres)', () => {
  const database = `control_api_mcpinvocable_gate_${randomUUID().replace(/-/g, '')}`
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

  function gatewayWith(
    servers: Array<{ name: string; grantScope: 'user' | 'context'; contextRef: string }>
  ): MockGateway {
    const g = new MockGateway(NS)
    void g.createResource(
      'contexts',
      {
        metadata: { name: 'ctx-1' },
        spec: { contextId: 'ctx-1', mcpServers: servers.map(s => s.name) },
      },
      NS
    )
    for (const s of servers) {
      void g.createResource(
        'mcpservers',
        {
          metadata: { name: s.name },
          spec: {
            enabled: true,
            auth: { type: 'oauth' },
            transport: { url: `http://${s.name}.${NS}.svc:3000/mcp` },
            contextRef: s.contextRef,
            oauth: { id: CLIENT_ID, provider: 'google', grantScope: s.grantScope },
          },
        },
        NS
      )
    }
    return g
  }

  const list = async (g: MockGateway, userId: string) =>
    (await resolveInvocableMcpServersForContexts(g, NS, ['ctx-1'], userId, db)).map(s => s.name)

  it('user-flavor: excluded without a grant, invocable after the caller upserts one', async () => {
    const g = gatewayWith([{ name: 'gdrive-u', grantScope: 'user', contextRef: 'ctx-1' }])
    expect(await list(g, 'alice')).toEqual([])

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
    expect(await list(g, 'alice')).toEqual(['gdrive-u'])
    // Another user without their own grant still cannot invoke it.
    expect(await list(g, 'bob')).toEqual([])
  })

  it('context-flavor: invocable for EVERY member once the shared grant is bootstrapped, decoupled from userId', async () => {
    const g = gatewayWith([{ name: 'gdrive-s', grantScope: 'context', contextRef: 'ctx-1' }])
    expect(await list(g, 'alice')).toEqual([])

    // Bob bootstraps the team identity; Alice never consented individually.
    await bootstrapSharedOAuthGrant(db, KEY, {
      ownerKind: 'mcpserver',
      recipeNamespace: NS,
      recipeName: 'gdrive-s',
      contextId: 'ctx-1',
      oauthClientId: CLIENT_ID,
      bootstrappedByUserId: 'bob',
      provider: 'google',
      accessToken: 'S',
    })
    expect(await list(g, 'alice')).toEqual(['gdrive-s'])
    expect(await list(g, 'bob')).toEqual(['gdrive-s'])
  })

  // mini-spec 04 §5c literal "with OR without the caller's own user grant": the
  // "without" half is the test above (alice never consented). This is the "with"
  // half — a member who ALSO holds a stray per-user grant on the same server is
  // servable BECAUSE the shared grant exists (not because of their user grant).
  it('context-flavor: a member holding a stray user grant is still servable via the shared grant', async () => {
    const g = gatewayWith([{ name: 'gdrive-w', grantScope: 'context', contextRef: 'ctx-1' }])
    // dave happens to also carry a per-user grant on this (context-flavor) server.
    await upsertOAuthGrant(db, KEY, {
      grantKind: 'user',
      ownerKind: 'mcpserver',
      recipeNamespace: NS,
      recipeName: 'gdrive-w',
      userId: 'dave',
      oauthClientId: CLIENT_ID,
      provider: 'google',
      accessToken: 'U',
    })
    // The user grant alone does not make a context server invocable.
    expect(await list(g, 'dave')).toEqual([])

    // Once the shared grant is bootstrapped (by anyone), dave is servable —
    // driven by the SHARED key, with his own user grant present and irrelevant.
    await bootstrapSharedOAuthGrant(db, KEY, {
      ownerKind: 'mcpserver',
      recipeNamespace: NS,
      recipeName: 'gdrive-w',
      contextId: 'ctx-1',
      oauthClientId: CLIENT_ID,
      bootstrappedByUserId: 'erin',
      provider: 'google',
      accessToken: 'S',
    })
    expect(await list(g, 'dave')).toEqual(['gdrive-w'])
  })

  it('a user grant does NOT satisfy a context-flavor server (disjoint keyspaces)', async () => {
    const g = gatewayWith([{ name: 'gdrive-x', grantScope: 'context', contextRef: 'ctx-1' }])
    // A stray user grant on the same server/client for the caller.
    await upsertOAuthGrant(db, KEY, {
      grantKind: 'user',
      ownerKind: 'mcpserver',
      recipeNamespace: NS,
      recipeName: 'gdrive-x',
      userId: 'carol',
      oauthClientId: CLIENT_ID,
      provider: 'google',
      accessToken: 'A',
    })
    // Still not invocable: the context flavor reads the SHARED key only.
    expect(await list(g, 'carol')).toEqual([])
  })
})
