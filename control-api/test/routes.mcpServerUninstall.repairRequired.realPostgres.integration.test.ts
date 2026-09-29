import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import request from 'supertest'
import type { DbClient } from '../src/db.js'
import type { K8sGateway } from '../src/k8s.js'
import { MockGateway } from './mockGateway.js'

/**
 * R3-H7 (§7 row 5, T1/T3/T4) — a failed grants purge on the generic McpServer
 * uninstall answers 503 repair_required with the CR still present, and repeating the
 * DELETE once the DB is healthy completes it: 200, CR gone, and the installation's
 * grant no longer readable.
 *
 * The grant is written by the REAL producer (`upsertOAuthGrant`, sealed with the CR
 * uid) and read back by the REAL fenced reader (`getOAuthGrant`) on a real Postgres.
 * The route's module-global `pool` is pointed at the test database; the only fault is
 * the purge statement throwing on the first request.
 *
 *   CONTROL_API_REAL_PG_ADMIN_URL=postgres://<u>:<p>@<host>:5432/<db> npm test -- \
 *     test/routes.mcpServerUninstall.repairRequired.realPostgres.integration.test.ts
 */

const dbHolder = vi.hoisted(() => ({
  target: null as null | { query: (text: string, values?: unknown[]) => Promise<unknown> },
  failGrantsPurge: false,
  // Evaluated per purge statement; lets a test fail only the post-delete purge.
  failGrantsPurgeWhen: null as null | (() => Promise<boolean>),
}))
vi.mock('../src/db.js', async importActual => {
  const actual = await importActual<typeof import('../src/db.js')>()
  return {
    ...actual,
    pool: {
      query: async (text: string, values?: unknown[]) => {
        if (/DELETE\s+FROM\s+oauth_grants/i.test(text)) {
          if (dbHolder.failGrantsPurge || (await dbHolder.failGrantsPurgeWhen?.())) {
            throw new Error('simulated oauth_grants purge failure')
          }
        }
        if (!dbHolder.target) throw new Error('test database not ready')
        return dbHolder.target.query(text, values)
      },
    },
  }
})

const { config } = await import('../src/config.js')
const { initDb } = await import('../src/db.js')
const { deriveOAuthEncryptionKey } = await import('../src/oauth/encryption.js')
const { getOAuthGrant, upsertOAuthGrant } = await import('../src/oauth/store.js')
const { createAdminResourcesRouter } = await import('../src/routes/admin/resources.js')

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip

function databaseUrl(baseUrl: string, database: string): string {
  const url = new URL(baseUrl)
  url.pathname = `/${database}`
  return url.toString()
}

const KEY = deriveOAuthEncryptionKey(config.oauthEncryptionKey)
const NS = config.mcpServersNamespace

describeRealPostgres('generic McpServer uninstall — repair_required (real Postgres)', () => {
  const database = `control_api_uninstall_${randomUUID().replace(/-/g, '')}`
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
    dbHolder.target = db
  })

  afterAll(async () => {
    dbHolder.target = null
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

  it('a failed purge keeps the CR (503); the repeated DELETE completes and no grant is visible', async () => {
    const name = `srv-rr-${randomUUID().slice(0, 8)}`
    const gw = new MockGateway(NS)
    const cr = (await gw.createResource('mcpservers', { metadata: { name }, spec: {} }, NS)) as {
      metadata: { uid: string }
    }
    const U = cr.metadata.uid
    const grantKey = {
      grantKind: 'user' as const,
      ownerKind: 'mcpserver' as const,
      recipeNamespace: NS,
      recipeName: name,
      userId: 'user-a',
      oauthClientId: 'client',
    }
    await upsertOAuthGrant(db, KEY, {
      ...grantKey,
      provider: 'google',
      accessToken: 'at-a',
      crUid: U,
    })
    const app = express()
    app.use(express.json())
    app.use(createAdminResourcesRouter(gw as unknown as K8sGateway))

    dbHolder.failGrantsPurge = true
    let first: request.Response
    try {
      first = await request(app).delete(`/admin/mcp-servers/${name}`)
    } finally {
      dbHolder.failGrantsPurge = false
    }

    expect(first.status).toBe(503)
    expect(first.body).toMatchObject({
      error: 'mcp_server_uninstall_incomplete',
      outcome: 'repair_required',
      pending: ['oauth_grants'],
    })
    // Same installation, still there: the retry has the uid it needs.
    await expect(gw.getResource('mcpservers', name, NS)).resolves.toMatchObject({
      metadata: { uid: U },
    })

    // Only the post-delete purge (issued once the CR is gone) fails on the retry: the
    // grant must already be gone from the pre-delete teardown, and the post-delete
    // purge is hygiene that never changes the 200.
    const crGone = async () => {
      try {
        await gw.getResource('mcpservers', name, NS)
        return false
      } catch {
        return true
      }
    }
    dbHolder.failGrantsPurgeWhen = crGone
    let retry: request.Response
    try {
      retry = await request(app).delete(`/admin/mcp-servers/${name}`)
    } finally {
      dbHolder.failGrantsPurgeWhen = null
    }

    expect(retry.status).toBe(200)
    await expect(gw.getResource('mcpservers', name, NS)).rejects.toThrow()
    expect(await getOAuthGrant(db, KEY, { ...grantKey, crUid: U })).toBeNull()
  })
})
