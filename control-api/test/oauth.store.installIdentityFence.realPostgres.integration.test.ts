/**
 * Installation-identity fence on the grant READERS, on a real Postgres.
 *
 * A same-name reinstall of an OAuth McpServer gets a new `metadata.uid`. Grants
 * SEALED against the previous installation must be invisible to the readers of
 * the new one (`getOAuthGrant` / `oauthGrantExists`), even if the uninstall never
 * purged them — otherwise a reinstall that reuses the same `oauth.id` silently
 * re-authorizes every previous user. An unsealed (legacy) grant, written by a pod
 * without install identity, is visible only to a baked installation of the same
 * provider; other lanes and providers are covered by
 * `oauth.legacyGrantLaneFence.realPostgres.integration.test.ts`.
 *
 * Fixtures come from the real producers (T1): the two installations are created
 * in the gateway (which assigns each its uid, as the apiserver does), the reader
 * keys are derived with `resolveServerOAuth` + `buildMcpServerGrantKey` from the
 * CR the gateway returns, and the grants are written by the real store writers
 * sealed with the uid the consent callback would carry.
 *
 *   CONTROL_API_REAL_PG_ADMIN_URL=postgres://<user>:<pass>@<host>:5432 npm test -- \
 *     test/oauth.store.installIdentityFence.realPostgres.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { config } from '../src/config.js'
import type { DbClient } from '../src/db.js'
import { initDb } from '../src/db.js'
import { deriveOAuthEncryptionKey } from '../src/oauth/encryption.js'
import { buildMcpServerGrantKey, resolveServerOAuth } from '../src/oauth/mcpServerOAuthSpec.js'
import {
  type OAuthGrantKey,
  bootstrapSharedOAuthGrant,
  getOAuthGrant,
  oauthGrantExists,
  upsertOAuthGrant,
} from '../src/oauth/store.js'
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
const OAUTH_ID = 'google-drive'

type ServerCR = Parameters<typeof resolveServerOAuth>[0] & { metadata: { uid: string } }

async function createServer(
  gateway: MockGateway,
  name: string,
  grantScope: 'user' | 'context'
): Promise<ServerCR> {
  await gateway.createResource(
    'mcpservers',
    {
      metadata: { name },
      spec: {
        contextRef: 'ctx-1',
        auth: { type: 'oauth' },
        oauth: { id: OAUTH_ID, provider: 'google', grantScope },
      },
    },
    NS
  )
  return (await gateway.getResource('mcpservers', name, NS)) as ServerCR
}

/**
 * Install `name`, uninstall it, and install it again under the same name: the
 * gateway gives each installation its own uid, exactly the reinstall shape.
 */
async function installThenReinstall(
  name: string,
  grantScope: 'user' | 'context'
): Promise<{ old: ServerCR; live: ServerCR }> {
  const gateway = new MockGateway(NS)
  const old = await createServer(gateway, name, grantScope)
  await gateway.deleteResource('mcpservers', name, NS)
  const live = await createServer(gateway, name, grantScope)
  expect(live.metadata.uid).not.toBe(old.metadata.uid)
  return { old, live }
}

/** The reader key exactly as the token broker / grant gate / sweep derive it. */
function readerKey(server: ServerCR, name: string, userId?: string): OAuthGrantKey {
  const resolved = resolveServerOAuth(server)
  if (!resolved) throw new Error('fixture: server did not resolve as OAuth')
  const key = buildMcpServerGrantKey(resolved, {
    mcpServerName: name,
    mcpServersNamespace: NS,
    userId,
  })
  if (!key) throw new Error('fixture: no grant key')
  return key
}

describeRealPostgres('grant readers fenced by the live installation uid (real Postgres)', () => {
  const database = `control_api_install_fence_${randomUUID().replace(/-/g, '')}`
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

  async function consentUser(name: string, userId: string, crUid: string | undefined) {
    await upsertOAuthGrant(db, KEY, {
      grantKind: 'user',
      ownerKind: 'mcpserver',
      recipeNamespace: NS,
      recipeName: name,
      userId,
      oauthClientId: OAUTH_ID,
      provider: 'google',
      accessToken: `at-${userId}`,
      refreshToken: `rt-${userId}`,
      accessTokenExpiresInSec: 3600,
      crUid,
    })
  }

  it('a user grant of a previous installation is invisible to the reinstall', async () => {
    const name = `fence-user-${randomUUID().slice(0, 8)}`
    const { old, live } = await installThenReinstall(name, 'user')
    await consentUser(name, 'user-1', old.metadata.uid)

    expect(await getOAuthGrant(db, KEY, readerKey(live, name, 'user-1'))).toBeNull()
    expect(await oauthGrantExists(db, readerKey(live, name, 'user-1'))).toBe(false)
    // Control: the row is really there — the installation it was sealed with sees it.
    expect((await getOAuthGrant(db, KEY, readerKey(old, name, 'user-1')))?.accessToken).toBe(
      'at-user-1'
    )
  })

  it('a shared grant of a previous installation is invisible to the reinstall', async () => {
    const name = `fence-shared-${randomUUID().slice(0, 8)}`
    const { old, live } = await installThenReinstall(name, 'context')
    const { inserted } = await bootstrapSharedOAuthGrant(db, KEY, {
      ownerKind: 'mcpserver',
      recipeNamespace: NS,
      recipeName: name,
      contextId: 'ctx-1',
      oauthClientId: OAUTH_ID,
      bootstrappedByUserId: 'user-1',
      provider: 'google',
      accessToken: 'at-shared',
      refreshToken: 'rt-shared',
      crUid: old.metadata.uid,
    })
    expect(inserted).toBe(true)

    expect(await getOAuthGrant(db, KEY, readerKey(live, name))).toBeNull()
    expect(await oauthGrantExists(db, readerKey(live, name))).toBe(false)
    expect((await getOAuthGrant(db, KEY, readerKey(old, name)))?.accessToken).toBe('at-shared')
  })

  it('an unsealed (legacy) grant stays visible to a baked installation of the same provider', async () => {
    const name = `fence-legacy-${randomUUID().slice(0, 8)}`
    const { live } = await installThenReinstall(name, 'user')
    await consentUser(name, 'user-1', undefined)

    const row = await getOAuthGrant(db, KEY, readerKey(live, name, 'user-1'))
    expect(row?.accessToken).toBe('at-user-1')
    expect(row?.crUid).toBeUndefined()
    expect(await oauthGrantExists(db, readerKey(live, name, 'user-1'))).toBe(true)
  })

  it('a grant of the live installation is visible and reports its uid', async () => {
    const name = `fence-live-${randomUUID().slice(0, 8)}`
    const { live } = await installThenReinstall(name, 'user')
    await consentUser(name, 'user-1', live.metadata.uid)

    const row = await getOAuthGrant(db, KEY, readerKey(live, name, 'user-1'))
    expect(row?.accessToken).toBe('at-user-1')
    expect(row?.crUid).toBe(live.metadata.uid)
  })

  it('an mcp-server reader key without a uid matches no row, sealed or legacy', async () => {
    const name = `fence-nouid-${randomUUID().slice(0, 8)}`
    const { live } = await installThenReinstall(name, 'user')
    await consentUser(name, 'user-sealed', live.metadata.uid)
    await consentUser(name, 'user-legacy', undefined)

    // The same CR as the gateway returned it, minus its uid.
    const uidless = { ...live, metadata: {} } as unknown as ServerCR
    for (const userId of ['user-sealed', 'user-legacy']) {
      const key = readerKey(uidless, name, userId)
      expect(await getOAuthGrant(db, KEY, key)).toBeNull()
      expect(await oauthGrantExists(db, key)).toBe(false)
    }
  })
})
