import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { config } from '../src/config.js'
import type { DbClient } from '../src/db.js'
import { initDb } from '../src/db.js'
import { deriveOAuthEncryptionKey } from '../src/oauth/encryption.js'
import { buildMcpServerGrantKey, resolveServerOAuth } from '../src/oauth/mcpServerOAuthSpec.js'
import {
  bootstrapSharedOAuthGrant,
  deleteOAuthGrant,
  oauthGrantExists,
  upsertOAuthGrant,
} from '../src/oauth/store.js'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'
import { MockGateway } from './mockGateway.js'

// T1/T4 — the disconnect composition (buildMcpServerGrantKey → deleteOAuthGrant)
// exercised against grant rows built by the REAL producers (`upsertOAuthGrant` /
// `bootstrapSharedOAuthGrant`) and observed through the REAL `oauthGrantExists`.
// No hand-built oauth_grants rows. This is the exact key derivation + delete the
// DELETE /internal/mcp-oauth/grant endpoint composes; the endpoint's authz gates
// are covered by the route test (routes.internal.mcpOauthDisconnect.test.ts).
// Gated on a real Postgres, like the U1 connectors integration test:
//   CONTROL_API_REAL_PG_ADMIN_URL=postgres://<user>:<pass>@<host>:5432 npm test -- \
//     test/oauth.mcpDisconnect.realPostgres.integration.test.ts
const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip

function databaseUrl(baseUrl: string, database: string): string {
  const url = new URL(baseUrl)
  url.pathname = `/${database}`
  return url.toString()
}

const KEY = deriveOAuthEncryptionKey(config.oauthEncryptionKey)
const NS = config.mcpServersNamespace

/**
 * A minimal McpServer CR created in the gateway (which assigns its `metadata.uid`,
 * as the apiserver does) and resolved through the REAL resolver the endpoint uses.
 */
async function resolvedFor(name: string, grantScope: 'user' | 'context', contextRef: string) {
  const gateway = new MockGateway(NS)
  await gateway.createResource(
    'mcpservers',
    {
      metadata: { name },
      spec: { contextRef, oauth: { id: 'google-drive', provider: 'google', grantScope } },
    },
    NS
  )
  const resolved = resolveServerOAuth(
    (await gateway.getResource('mcpservers', name, NS)) as Parameters<typeof resolveServerOAuth>[0]
  )
  if (!resolved?.crUid) throw new Error('fixture server did not resolve to OAuth with a uid')
  return resolved
}

describeRealPostgres('mcp-server grant disconnect composition (real Postgres)', () => {
  const database = `control_api_mcpdisconnect_${randomUUID().replace(/-/g, '')}`
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
    await endPoolAndWaitForClients(dbPool)
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

  it('user flavor: deletes ONLY the caller-owned grant (a peer on the same server survives)', async () => {
    const resolved = await resolvedFor('gdrive', 'user', 'ctx-9')
    // Two members each connect the SAME user-scope server (real producer), sealed
    // with the installation uid as the consent callback does.
    for (const userId of ['user-a', 'user-b']) {
      await upsertOAuthGrant(db, KEY, {
        grantKind: 'user',
        ownerKind: 'mcpserver',
        recipeNamespace: NS,
        recipeName: 'gdrive',
        userId,
        oauthClientId: 'google-drive',
        provider: 'google',
        accessToken: `at-${userId}`,
        refreshToken: `rt-${userId}`,
        crUid: resolved.crUid,
      })
    }

    const keyA = buildMcpServerGrantKey(resolved, {
      mcpServersNamespace: NS,
      mcpServerName: 'gdrive',
      userId: 'user-a',
    })
    expect(keyA).not.toBeNull()
    await deleteOAuthGrant(db, keyA!)

    // Observable state (T4), read with the same key derivation the readers use:
    // user-a's grant is gone, user-b's is untouched.
    const readKey = (userId: string) =>
      buildMcpServerGrantKey(resolved, {
        mcpServersNamespace: NS,
        mcpServerName: 'gdrive',
        userId,
      })!
    expect(await oauthGrantExists(db, readKey('user-a'))).toBe(false)
    expect(await oauthGrantExists(db, readKey('user-b'))).toBe(true)
  })

  it('context flavor: deletes ONLY the target Context grant (a sibling shared grant survives)', async () => {
    const resolved = await resolvedFor('teamdrive', 'context', 'ctx-A')
    // Two DIFFERENT Contexts each bootstrap a shared identity on the SAME server
    // (real producer). ctx-B is the sibling that must survive — the mirror of
    // the user-flavor case's user-b, so a shared DELETE that lost its
    // `context_id` predicate (blast-radius bug) would be caught here.
    for (const contextId of ['ctx-A', 'ctx-B']) {
      const { inserted } = await bootstrapSharedOAuthGrant(db, KEY, {
        ownerKind: 'mcpserver',
        recipeNamespace: NS,
        recipeName: 'teamdrive',
        contextId,
        oauthClientId: 'google-drive',
        bootstrappedByUserId: 'user-a',
        provider: 'google',
        accessToken: `shared-at-${contextId}`,
        refreshToken: `shared-rt-${contextId}`,
        crUid: resolved.crUid,
      })
      expect(inserted).toBe(true)
    }

    // A DIFFERENT member revokes ctx-A: the key is decoupled from the caller's
    // userId but MUST stay scoped to ctx-A's Context.
    const key = buildMcpServerGrantKey(resolved, {
      mcpServersNamespace: NS,
      mcpServerName: 'teamdrive',
      userId: 'user-b',
    })
    expect(key).not.toBeNull()
    await deleteOAuthGrant(db, key!)

    // ctx-A's shared grant is gone …
    expect(
      await oauthGrantExists(db, {
        grantKind: 'shared',
        ownerKind: 'mcpserver',
        recipeNamespace: NS,
        recipeName: 'teamdrive',
        contextId: 'ctx-A',
        oauthClientId: 'google-drive',
        crUid: resolved.crUid,
      })
    ).toBe(false)
    // … but the sibling ctx-B shared grant on the SAME server SURVIVES. Drop the
    // `context_id` predicate from the shared DELETE and this flips to false.
    expect(
      await oauthGrantExists(db, {
        grantKind: 'shared',
        ownerKind: 'mcpserver',
        recipeNamespace: NS,
        recipeName: 'teamdrive',
        contextId: 'ctx-B',
        oauthClientId: 'google-drive',
        crUid: resolved.crUid,
      })
    ).toBe(true)
  })

  it('context flavor without contextRef: key is null (fail-closed, never a blind delete)', () => {
    const resolved = resolveServerOAuth({
      spec: { oauth: { id: 'google-drive', provider: 'google', grantScope: 'context' } },
    })
    expect(resolved).not.toBeNull()
    const key = buildMcpServerGrantKey(resolved!, {
      mcpServersNamespace: NS,
      mcpServerName: 'gdrive',
      userId: 'user-a',
    })
    expect(key).toBeNull()
  })
})
