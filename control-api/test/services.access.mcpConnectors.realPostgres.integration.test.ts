import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { config } from '../src/config.js'
import type { DbClient } from '../src/db.js'
import { initDb } from '../src/db.js'
import { deriveOAuthEncryptionKey } from '../src/oauth/encryption.js'
import { bootstrapSharedOAuthGrant, upsertOAuthGrant } from '../src/oauth/store.js'
import { resolveConnectorsForAgents } from '../src/services/access/mcpInvocable.js'
import { MockGateway } from './mockGateway.js'

// T1 — the connectors classifier exercised end-to-end against grant state built
// by the REAL producers (`upsertOAuthGrant` / `bootstrapSharedOAuthGrant`) and
// read by the REAL `oauthGrantExists` inside the resolver. No hand-built
// oauth_grants rows. Gated on a real Postgres, like the store integration test:
//   CONTROL_API_REAL_PG_ADMIN_URL=postgres://user:pass@host:5432 npm test -- \
//     test/services.access.mcpConnectors.realPostgres.integration.test.ts
const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip

function databaseUrl(baseUrl: string, database: string): string {
  const url = new URL(baseUrl)
  url.pathname = `/${database}`
  return url.toString()
}

const KEY = deriveOAuthEncryptionKey(config.oauthEncryptionKey)
const NS = config.mcpServersNamespace
const HOSTS_NS = config.hostsNamespace
const CLIENT_PREFIX = 'client'

describeRealPostgres('resolveConnectorsForAgents tri-state (real Postgres)', () => {
  const database = `control_api_mcpconnectors_${randomUUID().replace(/-/g, '')}`
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
      'hosts',
      { metadata: { name: 'agent-a', namespace: HOSTS_NS }, spec: { contextRef: 'ctx-1' } },
      HOSTS_NS
    )
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
            oauth: {
              id: `${CLIENT_PREFIX}-${s.name}`,
              provider: 'google',
              clientIdRef: { name: `${s.name}-secret`, key: 'client-id' },
              clientSecretRef: { name: `${s.name}-secret`, key: 'client-secret' },
              grantScope: s.grantScope,
            },
          },
        },
        NS
      )
    }
    return g
  }

  const statusOf = async (g: MockGateway, userId: string, serverName: string) => {
    const agents = await resolveConnectorsForAgents(
      g,
      { mcpServersNamespace: NS, hostsNamespace: HOSTS_NS, agentNames: ['agent-a'], userId },
      db
    )
    return agents[0]?.connectors.find(c => c.name === serverName)?.status
  }

  it('user-flavor: requires_setup without a grant, authorized after the caller upserts one', async () => {
    const g = gatewayWith([{ name: 'gdrive-u', grantScope: 'user', contextRef: 'ctx-1' }])
    expect(await statusOf(g, 'alice', 'gdrive-u')).toBe('requires_setup')

    await upsertOAuthGrant(db, KEY, {
      grantKind: 'user',
      ownerKind: 'mcpserver',
      recipeNamespace: NS,
      recipeName: 'gdrive-u',
      userId: 'alice',
      oauthClientId: 'client-gdrive-u',
      provider: 'google',
      accessToken: 'A',
    })
    expect(await statusOf(g, 'alice', 'gdrive-u')).toBe('authorized')
    // Another user without their own grant still sees requires_setup (never dropped).
    expect(await statusOf(g, 'bob', 'gdrive-u')).toBe('requires_setup')
  })

  it('context-flavor: authorized for EVERY member once the shared grant is bootstrapped', async () => {
    const g = gatewayWith([{ name: 'gdrive-s', grantScope: 'context', contextRef: 'ctx-1' }])
    expect(await statusOf(g, 'alice', 'gdrive-s')).toBe('requires_setup')

    await bootstrapSharedOAuthGrant(db, KEY, {
      ownerKind: 'mcpserver',
      recipeNamespace: NS,
      recipeName: 'gdrive-s',
      contextId: 'ctx-1',
      oauthClientId: 'client-gdrive-s',
      bootstrappedByUserId: 'bob',
      provider: 'google',
      accessToken: 'S',
    })
    expect(await statusOf(g, 'alice', 'gdrive-s')).toBe('authorized')
    expect(await statusOf(g, 'bob', 'gdrive-s')).toBe('authorized')
  })

  it('a user grant does NOT authorize a context-flavor server (disjoint keyspaces)', async () => {
    const g = gatewayWith([{ name: 'gdrive-x', grantScope: 'context', contextRef: 'ctx-1' }])
    await upsertOAuthGrant(db, KEY, {
      grantKind: 'user',
      ownerKind: 'mcpserver',
      recipeNamespace: NS,
      recipeName: 'gdrive-x',
      userId: 'carol',
      oauthClientId: 'client-gdrive-x',
      provider: 'google',
      accessToken: 'A',
    })
    expect(await statusOf(g, 'carol', 'gdrive-x')).toBe('requires_setup')
  })
})
