/**
 * The reactive broker builds its grant key from the CR it read (uid U1). If the
 * server is uninstalled and reinstalled under the same name (uid U2) before the
 * refresh runs, the fenced reader still finds the U1 grant — the key says U1 —
 * but the owner the engine reads is now U2. The engine must treat the grant as
 * inert: no refresh POST with the old refresh token against the new
 * installation, and no `invalid_client` misread as the new client being broken.
 *
 * Real producers (T1): the CR and both uids come from the gateway, the key from
 * `resolveServerOAuth` + `buildMcpServerGrantKey`, the owner from
 * `normalizeMcpServerOwnerDecl`, the grant from `upsertOAuthGrant` on a real
 * Postgres (the reactive slow path takes a real row lock).
 *
 *   CONTROL_API_REAL_PG_ADMIN_URL=postgres://<user>:<pass>@<host>:5432 npm test -- \
 *     test/oauth.reactiveRefresh.installIdentity.realPostgres.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { config } from '../src/config.js'
import type { DbClient, DbTransactionClient } from '../src/db.js'
import { initDb } from '../src/db.js'
import { deriveOAuthEncryptionKey } from '../src/oauth/encryption.js'
import { buildMcpServerGrantKey, resolveServerOAuth } from '../src/oauth/mcpServerOAuthSpec.js'
import { resultToOutcome } from '../src/oauth/proactiveRefreshPolicy.js'
import { getAccessTokenReactive } from '../src/oauth/reactiveTokenHelper.js'
import { getOAuthGrant, upsertOAuthGrant } from '../src/oauth/store.js'
import { type McpServerResource, normalizeMcpServerOwnerDecl } from '../src/routes/mcpOauth.js'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'
import { MockGateway } from './mockGateway.js'

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip

function databaseUrl(baseUrl: string, database: string): string {
  const url = new URL(baseUrl)
  url.pathname = `/${database}`
  return url.toString()
}

const KEY = deriveOAuthEncryptionKey(config.oauthEncryptionKey)
const NS = config.mcpServersNamespace
const NAME = 'gdrive-toctou'

async function createCr(
  gateway: MockGateway
): Promise<McpServerResource & { metadata: { uid: string } }> {
  await gateway.createResource(
    'mcpservers',
    {
      metadata: { name: NAME },
      spec: {
        contextRef: 'ctx-1',
        auth: { type: 'oauth' },
        oauth: {
          id: 'google-drive',
          provider: 'google',
          clientIdRef: { name: 'google-creds', key: 'client-id' },
          clientSecretRef: { name: 'google-creds', key: 'client-secret' },
          grantScope: 'user',
        },
      },
    },
    NS
  )
  return (await gateway.getResource('mcpservers', NAME, NS)) as McpServerResource & {
    metadata: { uid: string }
  }
}

describeRealPostgres(
  'reactive refresh — CR replaced after the key was built (real Postgres)',
  () => {
    const database = `control_api_reactive_identity_${randomUUID().replace(/-/g, '')}`
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

    it('returns no_grant without a refresh POST when the owner was reinstalled mid-request', async () => {
      const gateway = new MockGateway(NS)
      const u1 = await createCr(gateway)

      // Consent against U1; the access token is due for refresh.
      await upsertOAuthGrant(db, KEY, {
        grantKind: 'user',
        ownerKind: 'mcpserver',
        recipeNamespace: NS,
        recipeName: NAME,
        userId: 'alice',
        oauthClientId: 'google-drive',
        provider: 'google',
        accessToken: 'AT-U1',
        refreshToken: 'RT-U1',
        accessTokenExpiresInSec: 10,
        crUid: u1.metadata.uid,
      })

      // The broker derives the key from the CR it read (U1).
      const resolved = resolveServerOAuth(u1)
      if (!resolved) throw new Error('fixture: not an OAuth server')
      const key = buildMcpServerGrantKey(resolved, {
        mcpServerName: NAME,
        mcpServersNamespace: NS,
        userId: 'alice',
      })
      if (!key) throw new Error('fixture: no key')

      // The AS rejects the U1 refresh token, as it would against a new installation.
      const fetchFn = vi.fn(
        async () =>
          ({
            ok: false,
            status: 401,
            text: async () => '{"error":"invalid_client"}',
            json: async () => ({ error: 'invalid_client' }),
          }) as Response
      )

      let u2Uid: string | undefined
      const result = await getAccessTokenReactive(
        { ...key, requireBackground: false },
        {
          db,
          recipeReader: {
            read: async name =>
              normalizeMcpServerOwnerDecl(
                (await gateway.getResource('mcpservers', name, NS)) as McpServerResource
              ),
          },
          secretReader: {
            read: async () => ({ 'client-id': 'CID', 'client-secret': 'CSEC' }),
          },
          fetchFn: fetchFn as unknown as typeof fetch,
          encryptionKey: KEY,
          // Between the fast-path read and the locked engine: uninstall + reinstall.
          runInTransaction: async <T>(
            work: (txDb: DbTransactionClient) => Promise<T>
          ): Promise<T> => {
            await gateway.deleteResource('mcpservers', NAME, NS)
            u2Uid = (await createCr(gateway)).metadata.uid
            const client = await dbPool.connect()
            try {
              await client.query('BEGIN')
              const txDb = {
                query: (t: string, v?: unknown[]) => client.query(t, v),
              } as unknown as DbTransactionClient
              const out = await work(txDb)
              await client.query('COMMIT')
              return out
            } catch (err) {
              await client.query('ROLLBACK')
              throw err
            } finally {
              client.release()
            }
          },
        }
      )

      expect(u2Uid).toBeDefined()
      expect(u2Uid).not.toBe(u1.metadata.uid)
      expect(result).toEqual({ kind: 'no_grant' })
      expect(resultToOutcome(result)).not.toBe('client_invalid')
      expect(fetchFn).not.toHaveBeenCalled()
      // The U1 grant is left as it was: inert, not refreshed.
      const row = await getOAuthGrant(db, KEY, key)
      expect(row?.accessToken).toBe('AT-U1')
      expect(row?.refreshToken).toBe('RT-U1')
    })
  }
)
