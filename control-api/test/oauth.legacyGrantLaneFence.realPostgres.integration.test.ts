/**
 * An unsealed (legacy, `cr_uid IS NULL`) mcp-server grant was written by a pod
 * without install identity, and such pods only spoke the baked lane. A same-name
 * reinstall that keeps the `oauth.id` but changes lane (remote / generic) or
 * baked provider must never be served that row — neither its still-valid access
 * token nor a refresh that sends its refresh token to the new installation's
 * endpoint. A baked reinstall of the SAME provider keeps being served (the rollout
 * path the unsealed rows exist for).
 *
 * Two control points, both covered here:
 *   - the store reader fence (`getOAuthGrant` / `oauthGrantExists`), keyed by the
 *     CR the caller read;
 *   - the refresh engine, which re-reads the CR right before refreshing, so a CR
 *     replaced after the key was built is judged as it is now.
 *
 * Observable (T4): reader results, the `getAccessTokenReactive` result, every POST
 * reaching a token endpoint (the pinned transport for remote/generic, `fetchFn`
 * for baked adapters), and the persisted rows.
 *
 * Real producers (T1): see `fixtures/legacyOAuthGrant.ts`.
 *
 *   CONTROL_API_REAL_PG_ADMIN_URL=postgres://<user>:<pass>@<host>:5432 npm test -- \
 *     test/oauth.legacyGrantLaneFence.realPostgres.integration.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { config } from '../src/config.js'
import type { DbClient, DbTransactionClient } from '../src/db.js'
import { initDb } from '../src/db.js'
import type { DiscoveryResult } from '../src/oauth/discovery.js'
import { decryptOAuthSecret, deriveOAuthEncryptionKey } from '../src/oauth/encryption.js'
import { getAccessTokenReactive } from '../src/oauth/reactiveTokenHelper.js'
import {
  type OAuthGrantKey,
  getOAuthGrant,
  listRemoteGrantsInProactiveWindow,
  oauthGrantExists,
} from '../src/oauth/store.js'
import { type McpServerResource, normalizeMcpServerOwnerDecl } from '../src/routes/mcpOauth.js'
import {
  NS,
  type OAuthSpec,
  VALIDATED_IP,
  bakedOAuth,
  currentConsent,
  genericOAuth,
  installServer,
  legacyConsent,
  readerKey,
  recordingTokenTransport,
  reinstallServer,
  remoteDiscovery,
  remoteOAuth,
} from './fixtures/legacyOAuthGrant.js'
import { MockGateway } from './mockGateway.js'

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip

function databaseUrl(baseUrl: string, database: string): string {
  const url = new URL(baseUrl)
  url.pathname = `/${database}`
  return url.toString()
}

const KEY = deriveOAuthEncryptionKey(config.oauthEncryptionKey)
const LEGACY_PROVIDER = 'google'
const LEGACY_AT = 'LEGACY-AT-google'
const LEGACY_RT = 'LEGACY-RT-google'
const USER = 'alice'
type Flavor = 'user' | 'context'
const FLAVORS: Flavor[] = ['user', 'context']

describeRealPostgres(
  'unsealed legacy grants fenced to the same baked provider (real Postgres)',
  () => {
    const database = `control_api_legacy_lane_${randomUUID().replace(/-/g, '')}`
    let adminPool: Pool
    let dbPool: Pool
    let db: DbClient
    let discovery: DiscoveryResult

    beforeAll(async () => {
      if (!adminUrl) throw new Error('CONTROL_API_REAL_PG_ADMIN_URL is required')
      adminPool = new Pool({ connectionString: adminUrl })
      await adminPool.query(`CREATE DATABASE "${database.replace(/"/g, '""')}"`)
      dbPool = new Pool({ connectionString: databaseUrl(adminUrl, database) })
      await initDb({ connect: () => dbPool.connect() })
      db = { query: (text, values) => dbPool.query(text, values) }
      discovery = await remoteDiscovery()
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
    })

    const lanes: Record<string, (flavor: Flavor) => OAuthSpec> = {
      generic: flavor => genericOAuth(flavor),
      remote: flavor => remoteOAuth(discovery, flavor),
      'baked slack': flavor => bakedOAuth('slack', flavor),
    }

    const serverName = (label: string) =>
      `legacy-${label.replace(/[^a-z]/g, '')}-${randomUUID().slice(0, 8)}`

    /** Baked `google` installation consented by a pre-identity pod. */
    async function seedLegacyGrant(
      name: string,
      flavor: Flavor,
      expiresIn: number
    ): Promise<MockGateway> {
      const gateway = new MockGateway(NS)
      await installServer(gateway, name, bakedOAuth(LEGACY_PROVIDER, flavor))
      await legacyConsent(db, KEY, gateway, name, USER, {
        accessToken: LEGACY_AT,
        refreshToken: LEGACY_RT,
        expiresIn,
      })
      const rows = await rowsOf(name)
      expect(rows).toEqual([{ provider: LEGACY_PROVIDER, crUid: null, refreshToken: LEGACY_RT }])
      return gateway
    }

    /** The table as it is, bypassing every reader fence. */
    async function rowsOf(name: string) {
      const { rows } = await dbPool.query(
        `SELECT provider, cr_uid, refresh_token_encrypted FROM oauth_grants
        WHERE owner_kind = 'mcpserver' AND recipe_name = $1`,
        [name]
      )
      return rows.map(r => ({
        provider: r.provider as string,
        crUid: r.cr_uid as string | null,
        refreshToken: r.refresh_token_encrypted
          ? decryptOAuthSecret(KEY, r.refresh_token_encrypted as string)
          : null,
      }))
    }

    /**
     * The broker's refresh wiring (`routes/mcpOauth.ts`): the owner re-read from the
     * gateway at refresh time, a real row-locking transaction, and both token-endpoint
     * edges recorded. `beforeEngine` runs after the fast-path read and before the
     * locked engine — where a concurrent reinstall would land.
     */
    function reactive(
      gateway: MockGateway,
      key: OAuthGrantKey,
      beforeEngine?: () => Promise<void>
    ) {
      const { transport, posts } = recordingTokenTransport({
        accessToken: 'NEW-AT',
        refreshToken: 'NEW-RT',
      })
      const fetchFn = vi.fn(
        async () =>
          ({
            ok: true,
            status: 200,
            json: async () => ({ access_token: 'NEW-AT', expires_in: 3600 }),
            text: async () => '{"access_token":"NEW-AT","expires_in":3600}',
          }) as Response
      )
      const run = () =>
        getAccessTokenReactive(
          { ...key, requireBackground: false },
          {
            db,
            recipeReader: {
              read: async name =>
                normalizeMcpServerOwnerDecl(
                  (await gateway.getResource('mcpservers', name, NS)) as McpServerResource
                ),
            },
            secretReader: { read: async () => ({ 'client-id': 'CID', 'client-secret': 'CSEC' }) },
            fetchFn: fetchFn as unknown as typeof fetch,
            encryptionKey: KEY,
            resolveDns: async () => [VALIDATED_IP],
            pinnedTransport: transport,
            runInTransaction: async <T>(
              work: (txDb: DbTransactionClient) => Promise<T>
            ): Promise<T> => {
              await beforeEngine?.()
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
      return { run, posts, fetchFn }
    }

    /** Every refresh-token exchange that left the process, on either edge. */
    function spentRefreshTokens(
      posts: { body: string }[],
      fetchFn: ReturnType<typeof vi.fn>
    ): string[] {
      const fromTransport = posts.map(p => new URLSearchParams(p.body).get('refresh_token') ?? '')
      const fromFetch = fetchFn.mock.calls.map(call => {
        const init = call[1] as { body?: unknown } | undefined
        return new URLSearchParams(String(init?.body ?? '')).get('refresh_token') ?? ''
      })
      return [...fromTransport, ...fromFetch]
    }

    describe.each(FLAVORS)('store reader fence (%s flavor)', flavor => {
      it.each(Object.keys(lanes))(
        'a %s reinstall with the same oauth.id does not see the legacy row',
        async lane => {
          const name = serverName(lane)
          const gateway = await seedLegacyGrant(name, flavor, 3600)
          const live = await reinstallServer(gateway, name, lanes[lane](flavor))
          const key = readerKey(live, flavor === 'user' ? USER : undefined)

          expect(await getOAuthGrant(db, KEY, key)).toBeNull()
          expect(await oauthGrantExists(db, key)).toBe(false)
          // The row is still there: invisible, not destroyed.
          expect(await rowsOf(name)).toHaveLength(1)
        }
      )

      it('a baked reinstall of the same provider keeps seeing the legacy row', async () => {
        const name = serverName('same')
        const gateway = await seedLegacyGrant(name, flavor, 3600)
        const live = await reinstallServer(gateway, name, bakedOAuth(LEGACY_PROVIDER, flavor))
        const key = readerKey(live, flavor === 'user' ? USER : undefined)

        const row = await getOAuthGrant(db, KEY, key)
        expect(row?.accessToken).toBe(LEGACY_AT)
        expect(row?.crUid).toBeUndefined()
        expect(await oauthGrantExists(db, key)).toBe(true)
      })
    })

    describe.each(FLAVORS)('reactive refresh of a legacy row (%s flavor)', flavor => {
      it.each(['generic', 'remote'])(
        'a %s reinstall gets no_grant and the legacy refresh token never leaves',
        async lane => {
          const name = serverName(lane)
          // Access token already due: the broker would go straight to a refresh.
          const gateway = await seedLegacyGrant(name, flavor, 1)
          const live = await reinstallServer(gateway, name, lanes[lane](flavor))
          const { run, posts, fetchFn } = reactive(
            gateway,
            readerKey(live, flavor === 'user' ? USER : undefined)
          )

          const result = await run()
          expect(spentRefreshTokens(posts, fetchFn)).toEqual([])
          expect(result).toEqual({ kind: 'no_grant' })
          expect(await rowsOf(name)).toEqual([
            { provider: LEGACY_PROVIDER, crUid: null, refreshToken: LEGACY_RT },
          ])
        }
      )
    })

    describe('CR replaced after the key was built (engine re-read)', () => {
      it.each(['generic', 'remote', 'baked slack'])(
        'a key from a baked google CR, refreshed after the CR became %s: no_grant, nothing POSTed',
        async lane => {
          const name = serverName(lane)
          const gateway = await seedLegacyGrant(name, 'user', 1)
          // The caller read a baked google CR (a same-provider reinstall), so its key
          // legitimately sees the legacy row …
          const read = await reinstallServer(gateway, name, bakedOAuth(LEGACY_PROVIDER, 'user'))
          const key = readerKey(read, USER)
          expect(await oauthGrantExists(db, key)).toBe(true)
          // … and the server is reinstalled in another lane before the refresh runs.
          const { run, posts, fetchFn } = reactive(gateway, key, async () => {
            await reinstallServer(gateway, name, lanes[lane]('user'))
          })

          const result = await run()
          expect(spentRefreshTokens(posts, fetchFn)).toEqual([])
          expect(result).toEqual({ kind: 'no_grant' })
          expect(await rowsOf(name)).toEqual([
            { provider: LEGACY_PROVIDER, crUid: null, refreshToken: LEGACY_RT },
          ])
        }
      )

      it('a same-provider baked CR still refreshes the legacy row (rollout path intact)', async () => {
        const name = serverName('rollout')
        const gateway = await seedLegacyGrant(name, 'user', 1)
        const live = await reinstallServer(gateway, name, bakedOAuth(LEGACY_PROVIDER, 'user'))
        const { run, posts, fetchFn } = reactive(gateway, readerKey(live, USER))

        expect(await run()).toMatchObject({ kind: 'ok', accessToken: 'NEW-AT' })
        expect(spentRefreshTokens(posts, fetchFn)).toEqual([LEGACY_RT])
        expect(posts).toEqual([])
        const rows = await rowsOf(name)
        expect(rows).toEqual([{ provider: LEGACY_PROVIDER, crUid: null, refreshToken: LEGACY_RT }])
      })
    })

    describe('unrecognised spec.oauth.source', () => {
      it.each(['foo', ''])(
        "source=%j never sees nor refreshes a legacy row, even carrying the row's provider",
        async source => {
          const name = serverName(`unknown${source}`)
          const gateway = await seedLegacyGrant(name, 'user', 1)
          const live = await reinstallServer(gateway, name, {
            ...bakedOAuth(LEGACY_PROVIDER, 'user'),
            source,
          })
          const key = readerKey(live, USER)

          expect(await getOAuthGrant(db, KEY, key)).toBeNull()
          expect(await oauthGrantExists(db, key)).toBe(false)
          const { run, posts, fetchFn } = reactive(gateway, key)
          const result = await run()
          expect(spentRefreshTokens(posts, fetchFn)).toEqual([])
          expect(result).toEqual({ kind: 'no_grant' })
        }
      )
    })

    it('reconnecting on the new lane replaces the legacy row and seals it', async () => {
      const name = serverName('reconnect')
      const gateway = await seedLegacyGrant(name, 'user', 3600)
      const live = await reinstallServer(gateway, name, genericOAuth('user'))
      const { transport, posts } = recordingTokenTransport({
        accessToken: 'GENERIC-AT',
        refreshToken: 'GENERIC-RT',
      })

      await currentConsent(db, KEY, gateway, name, USER, transport)

      expect(posts).toHaveLength(1)
      expect(await rowsOf(name)).toEqual([
        { provider: 'generic', crUid: live.metadata.uid, refreshToken: 'GENERIC-RT' },
      ])
      const row = await getOAuthGrant(db, KEY, readerKey(live, USER))
      expect(row?.accessToken).toBe('GENERIC-AT')
      expect(row?.refreshToken).toBe('GENERIC-RT')
      expect(row?.crUid).toBe(live.metadata.uid)
    })

    it('the proactive sweep keys (no legacyProvider) still read sealed remote/generic rows', async () => {
      const gateway = new MockGateway(NS)
      const genericName = serverName('sealedgeneric')
      const remoteName = serverName('sealedremote')
      const genericCr = await installServer(gateway, genericName, genericOAuth('context'))
      const remoteCr = await installServer(gateway, remoteName, remoteOAuth(discovery, 'context'))
      const { transport } = recordingTokenTransport({ accessToken: 'AT', refreshToken: 'RT' })
      await currentConsent(db, KEY, gateway, genericName, USER, transport)
      await currentConsent(db, KEY, gateway, remoteName, USER, transport, discovery.issForCallback)

      const keys = await listRemoteGrantsInProactiveWindow(db, {
        reactiveBufferMs: 0,
        proactiveBufferMs: 7_200_000,
      })
      expect(keys.map(k => [k.recipeName, k.crUid]).sort()).toEqual(
        [
          [genericName, genericCr.metadata.uid],
          [remoteName, remoteCr.metadata.uid],
        ].sort()
      )
      for (const key of keys) {
        expect(key).not.toHaveProperty('legacyProvider')
        expect((await getOAuthGrant(db, KEY, key))?.accessToken).toBe('AT')
      }
    })
  }
)
