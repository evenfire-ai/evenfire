/**
 * The proactive refresh sweep must never spend the refresh token of a grant
 * consented against a previous installation of a same-name McpServer. The sweep
 * enumerates grants straight from `oauth_grants`, so the row reader alone cannot
 * tell a dead installation from the live one; the engine compares the grant's
 * sealed uid with the owner CR it reads before refreshing.
 *
 * Observable (T4): POSTs reaching the token endpoint, the sweep summary, and the
 * persisted rows. Without the check the dead grant's refresh is POSTed, the AS
 * rejects it, and the sweep reports `client_invalid` against a healthy server.
 *
 * Real producers (T1): the sweep runs end-to-end on a real Postgres against the
 * gateway (which assigns each installation its uid); the CR `spec.oauth` comes
 * from the install's `buildRemoteOAuthSpec` over a real `discoverRemoteOAuth`
 * result; grants are written by the store writers sealed as the consent callback
 * seals them. Only the network edge of `pinnedFetch` (DNS + socket) is replaced.
 *
 *   CONTROL_API_REAL_PG_ADMIN_URL=postgres://<user>:<pass>@<host>:5432 npm test -- \
 *     test/services.oauthProactiveRefreshCron.installIdentity.realPostgres.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { config } from '../src/config.js'
import type { DbClient, DbTransactionClient } from '../src/db.js'
import { initDb } from '../src/db.js'
import type { K8sGateway } from '../src/k8s.js'
import { buildCimdDocument } from '../src/oauth/cimd.js'
import { type DiscoveryResult, discoverRemoteOAuth } from '../src/oauth/discovery.js'
import { deriveOAuthEncryptionKey } from '../src/oauth/encryption.js'
import { resolveServerOAuthSubject } from '../src/oauth/mcpServerOAuthSpec.js'
import { bootstrapSharedOAuthGrant, getOAuthGrant } from '../src/oauth/store.js'
import { buildRemoteOAuthSpec } from '../src/routes/admin/remoteMcp.js'
import { runProactiveRefreshSweep } from '../src/services/oauthProactiveRefreshCron.js'
import {
  DROPBOX_PILOT,
  PILOTS,
  type PilotFixture,
  makeDiscoveryTransport,
} from './fixtures/remoteOAuthDiscovery.js'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'
import { MockGateway } from './mockGateway.js'

const VALIDATED_IP = '93.184.216.34'

// Token endpoint behind the pinned transport. A dead installation's refresh token
// is rejected the way an AS rejects credentials it no longer recognises.
const tokenEndpoint = vi.hoisted(() => ({ posts: [] as { url: string; body: string }[] }))

vi.mock('../src/http/pinnedFetch.js', async () => {
  const actual = await vi.importActual<typeof import('../src/http/pinnedFetch.js')>(
    '../src/http/pinnedFetch.js'
  )
  return {
    ...actual,
    // Only calls that would reach the real network (the sweep injects no transport)
    // are redirected; callers that bring their own transport keep it.
    pinnedFetch: (url: string, field: string, options: Parameters<typeof actual.pinnedFetch>[2]) =>
      options?.transport
        ? actual.pinnedFetch(url, field, options)
        : actual.pinnedFetch(url, field, {
            ...options,
            resolveDns: async () => ['93.184.216.34'],
            transport: async input => {
              const body = input.body ?? ''
              tokenEndpoint.posts.push({ url: input.url, body })
              if (new URLSearchParams(body).get('refresh_token') === 'RT-DEAD') {
                return {
                  status: 401,
                  headers: { 'content-type': 'application/json' },
                  bodyText: JSON.stringify({ error: 'invalid_client' }),
                }
              }
              return {
                status: 200,
                headers: { 'content-type': 'application/json' },
                bodyText: JSON.stringify({
                  access_token: 'NEW-AT',
                  refresh_token: 'NEW-RT',
                  expires_in: 3600,
                }),
              }
            },
          }),
  }
})

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip

function databaseUrl(baseUrl: string, database: string): string {
  const url = new URL(baseUrl)
  url.pathname = `/${database}`
  return url.toString()
}

const KEY = deriveOAuthEncryptionKey(config.oauthEncryptionKey)
const NS = config.mcpServersNamespace
const CONTEXT = 'ctx-cron'
const OPTS = { proactiveBufferMs: 300_000, reactiveBufferMs: 60_000, dcrWarnMs: 604_800_000 }
const IN_WINDOW_SEC = 200 // Br < 200s ≤ Bp

describeRealPostgres('proactive refresh sweep — installation identity (real Postgres)', () => {
  const database = `control_api_cron_identity_${randomUUID().replace(/-/g, '')}`
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

    const outcome = await discoverRemoteOAuth(PILOTS.notion.mcpUrl, {
      transport: makeDiscoveryTransport(PILOTS.notion),
      resolveDns: async () => [VALIDATED_IP],
    })
    if (!outcome.ok) throw new Error(`fixture discovery failed: ${outcome.error.kind}`)
    discovery = outcome.result
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

  const oauthId = () => buildCimdDocument('https://control.example.com').client_id

  async function createCr(gateway: MockGateway, name: string): Promise<string> {
    await gateway.createResource(
      'mcpservers',
      {
        metadata: { name },
        spec: {
          contextRef: CONTEXT,
          auth: { type: 'oauth' },
          oauth: buildRemoteOAuthSpec(discovery, {
            clientMode: 'public',
            grantScope: 'context',
            cimdClientId: oauthId(),
          }),
        },
      },
      NS
    )
    const cr = (await gateway.getResource('mcpservers', name, NS)) as { metadata: { uid: string } }
    return cr.metadata.uid
  }

  async function consentShared(name: string, crUid: string | undefined, refreshToken: string) {
    const { inserted } = await bootstrapSharedOAuthGrant(db, KEY, {
      ownerKind: 'mcpserver',
      recipeNamespace: NS,
      recipeName: name,
      contextId: CONTEXT,
      oauthClientId: oauthId(),
      bootstrappedByUserId: 'user-1',
      provider: 'remote',
      accessToken: `AT-${refreshToken}`,
      refreshToken,
      accessTokenExpiresInSec: IN_WINDOW_SEC,
      crUid,
    })
    expect(inserted).toBe(true)
  }

  const sharedKey = (name: string, crUid: string) => ({
    grantKind: 'shared' as const,
    ownerKind: 'mcpserver' as const,
    recipeNamespace: NS,
    recipeName: name,
    contextId: CONTEXT,
    oauthClientId: oauthId(),
    crUid,
  })

  function sweep(gateway: MockGateway) {
    return runProactiveRefreshSweep(gateway as unknown as K8sGateway, OPTS, {
      db,
      runInTransaction: async <T>(work: (txDb: DbTransactionClient) => Promise<T>): Promise<T> => {
        const client = await dbPool.connect()
        try {
          await client.query('BEGIN')
          const txDb = {
            query: (t: string, v?: unknown[]) => client.query(t, v),
          } as unknown as DbTransactionClient
          const result = await work(txDb)
          await client.query('COMMIT')
          return result
        } catch (err) {
          await client.query('ROLLBACK')
          throw err
        } finally {
          client.release()
        }
      },
      encryptionKey: KEY,
      fetchFn: (async () => {
        throw new Error('remote refresh must not use fetchFn')
      }) as unknown as typeof fetch,
    })
  }

  it('refreshes the live installation grant and never POSTs the dead installation one', async () => {
    const gateway = new MockGateway(NS)

    // `cron-dead`: consented, then uninstalled without purging the grant and
    // reinstalled under the same name.
    const deadUid = await createCr(gateway, 'cron-dead')
    await consentShared('cron-dead', deadUid, 'RT-DEAD')
    await gateway.deleteResource('mcpservers', 'cron-dead', NS)
    const reinstalledUid = await createCr(gateway, 'cron-dead')
    expect(reinstalledUid).not.toBe(deadUid)

    // `cron-live`: a healthy installation whose grant is due.
    const liveUid = await createCr(gateway, 'cron-live')
    await consentShared('cron-live', liveUid, 'RT-LIVE')

    tokenEndpoint.posts.length = 0
    const summary = await sweep(gateway)

    expect(summary.candidates).toBe(2)
    expect(summary.outcomes.ok).toBe(1)
    expect(summary.outcomes.no_grant).toBe(1)
    expect(summary.outcomes.client_invalid).toBe(0)
    expect(summary.dcrClientInvalidServers).toEqual([])

    expect(tokenEndpoint.posts).toHaveLength(1)
    expect(tokenEndpoint.posts[0].body).toContain('refresh_token=RT-LIVE')

    // The live grant was renewed; the dead one is untouched (inert, not refreshed).
    expect((await getOAuthGrant(db, KEY, sharedKey('cron-live', liveUid)))?.accessToken).toBe(
      'NEW-AT'
    )
    const dead = await getOAuthGrant(db, KEY, sharedKey('cron-dead', deadUid))
    expect(dead?.accessToken).toBe('AT-RT-DEAD')
    expect(dead?.refreshToken).toBe('RT-DEAD')
  })

  it('never touches an unsealed (legacy) remote grant: not enumerated, not POSTed', async () => {
    await dbPool.query('DELETE FROM oauth_grants')
    const gateway = new MockGateway(NS)
    await createCr(gateway, 'cron-legacy')
    await consentShared('cron-legacy', undefined, 'RT-LEGACY')

    tokenEndpoint.posts.length = 0
    const summary = await sweep(gateway)

    expect(summary.candidates).toBe(0)
    expect(summary.outcomes.no_grant).toBe(0)
    expect(summary.outcomes.ok).toBe(0)
    expect(tokenEndpoint.posts).toHaveLength(0)
    const { rows } = await dbPool.query(
      `SELECT refresh_token_encrypted IS NOT NULL AS has_rt, cr_uid FROM oauth_grants
        WHERE recipe_name = 'cron-legacy'`
    )
    expect(rows).toEqual([{ has_rt: true, cr_uid: null }])
  })

  // A per-server CR (no RFC 9207) holding the platform CIMD client, or with AS endpoints
  // off the issuer's site, is refused at consent. A grant it already holds is sealed to
  // its uid and its endpoints are immutable, so the refresh returns to the token
  // endpoint that issued it: the sweep keeps refreshing it instead of stranding it.
  it('keeps refreshing grants of per-server CRs that consent refuses (CIMD without iss, cross-site)', async () => {
    await dbPool.query('DELETE FROM oauth_grants')
    const gateway = new MockGateway(NS)

    // Notion (real): CIMD without RFC 9207 — `discovery` of this suite.
    expect(discovery.issForCallback).toBeUndefined()
    const cimdNoIss = buildRemoteOAuthSpec(discovery, {
      clientMode: 'public',
      grantScope: 'context',
      cimdClientId: oauthId(),
    })
    // Dropbox (real): discovery accepts its cross-site AS only with RFC 9207, so the
    // per-server shape is that output without `issForCallback` (a direct write).
    const dropbox9207: PilotFixture = {
      ...DROPBOX_PILOT,
      as: {
        ...DROPBOX_PILOT.as,
        json: JSON.stringify({
          ...JSON.parse(DROPBOX_PILOT.as.json),
          authorization_response_iss_parameter_supported: true,
        }),
      },
    }
    const dropboxOutcome = await discoverRemoteOAuth(dropbox9207.mcpUrl, {
      transport: makeDiscoveryTransport(dropbox9207),
      resolveDns: async () => [VALIDATED_IP],
    })
    if (!dropboxOutcome.ok)
      throw new Error(`fixture discovery failed: ${dropboxOutcome.error.kind}`)
    const crossSite = buildRemoteOAuthSpec(dropboxOutcome.result, {
      clientMode: 'public',
      grantScope: 'context',
      dynamicClientId: 'dyn-dropbox-public',
    })
    delete crossSite.issForCallback

    const cases = [
      { name: 'cron-cimd-noiss', oauth: cimdNoIss, reason: 'cimd_without_issuer_binding' },
      { name: 'cron-cross-site', oauth: crossSite, reason: 'as_endpoints_cross_site' },
    ]
    for (const c of cases) {
      await gateway.createResource(
        'mcpservers',
        {
          metadata: { name: c.name },
          spec: { contextRef: CONTEXT, auth: { type: 'oauth' }, oauth: c.oauth },
        },
        NS
      )
      const cr = (await gateway.getResource('mcpservers', c.name, NS)) as {
        metadata: { uid: string }
        spec: Record<string, unknown>
      }
      // Consent refuses it (the other half of the invariant).
      let consentError: { reason?: unknown } | undefined
      try {
        resolveServerOAuthSubject(cr, 'consent')
      } catch (err) {
        consentError = err as { reason?: unknown }
      }
      expect(consentError?.reason).toBe(c.reason)
      const { inserted } = await bootstrapSharedOAuthGrant(db, KEY, {
        ownerKind: 'mcpserver',
        recipeNamespace: NS,
        recipeName: c.name,
        contextId: CONTEXT,
        oauthClientId: c.oauth.id as string,
        bootstrappedByUserId: 'user-1',
        provider: 'remote',
        accessToken: `AT-${c.name}`,
        refreshToken: `RT-${c.name}`,
        accessTokenExpiresInSec: IN_WINDOW_SEC,
        crUid: cr.metadata.uid,
      })
      expect(inserted).toBe(true)
    }

    tokenEndpoint.posts.length = 0
    const summary = await sweep(gateway)

    expect(summary.candidates).toBe(2)
    expect(summary.outcomes.ok).toBe(2)
    expect(summary.outcomes.error).toBe(0)
    expect(tokenEndpoint.posts.map(p => p.url).sort()).toEqual(
      [cimdNoIss.tokenEndpoint, crossSite.tokenEndpoint].sort()
    )
  })

  // Invariant 8: a remote CR the CRD now rejects (public + secret refs, or
  // bearerInBody: true) may still exist from a write that bypassed the install
  // route. The sweep must not spend its refresh token; the row counts as `error`.
  it('never POSTs the refresh of an incoherent remote server; the row counts as error', async () => {
    await dbPool.query('DELETE FROM oauth_grants')
    const gateway = new MockGateway(NS)
    const PRE_REGISTERED_ID = 'client-abc'

    // public + refs has no producer: the pre-registered-confidential output with
    // clientMode flipped, as an in-place edit would leave it. The Secret exists so
    // the only thing that can stop the POST is the coherence check.
    const preRegistered = buildRemoteOAuthSpec(discovery, {
      clientMode: 'confidential',
      grantScope: 'context',
      clientSecretName: 'srv-oauth-client',
      preRegisteredClientId: PRE_REGISTERED_ID,
    })
    gateway.seedSecret('srv-oauth-client', NS, {
      data: {
        client_id: Buffer.from(PRE_REGISTERED_ID).toString('base64'),
        client_secret: Buffer.from('pre-registered-secret').toString('base64'),
      },
    })

    // bearerInBody: true is what the real builder emits for a body-only resource;
    // the install route rejects it, so only a bypassing write can persist it.
    const bodyOnly: PilotFixture = {
      ...PILOTS.notion,
      prm: {
        ...PILOTS.notion.prm,
        json: JSON.stringify({
          ...JSON.parse(PILOTS.notion.prm.json),
          bearer_methods_supported: ['body'],
        }),
      },
    }
    const bodyOutcome = await discoverRemoteOAuth(bodyOnly.mcpUrl, {
      transport: makeDiscoveryTransport(bodyOnly),
      resolveDns: async () => [VALIDATED_IP],
    })
    if (!bodyOutcome.ok) throw new Error(`fixture discovery failed: ${bodyOutcome.error.kind}`)
    const bearerInBody = buildRemoteOAuthSpec(bodyOutcome.result, {
      clientMode: 'public',
      grantScope: 'context',
      cimdClientId: oauthId(),
    })
    expect(bearerInBody.bearerInBody).toBe(true)

    const cases = [
      { name: 'cron-pubrefs', oauth: { ...preRegistered, clientMode: 'public' as const } },
      { name: 'cron-bib', oauth: bearerInBody },
    ]
    for (const c of cases) {
      await gateway.createResource(
        'mcpservers',
        {
          metadata: { name: c.name },
          spec: { contextRef: CONTEXT, auth: { type: 'oauth' }, oauth: c.oauth },
        },
        NS
      )
      const cr = (await gateway.getResource('mcpservers', c.name, NS)) as {
        metadata: { uid: string }
      }
      const { inserted } = await bootstrapSharedOAuthGrant(db, KEY, {
        ownerKind: 'mcpserver',
        recipeNamespace: NS,
        recipeName: c.name,
        contextId: CONTEXT,
        oauthClientId: c.oauth.id as string,
        bootstrappedByUserId: 'user-1',
        provider: 'remote',
        accessToken: `AT-${c.name}`,
        refreshToken: `RT-${c.name}`,
        accessTokenExpiresInSec: IN_WINDOW_SEC,
        crUid: cr.metadata.uid,
      })
      expect(inserted).toBe(true)
    }

    tokenEndpoint.posts.length = 0
    const summary = await sweep(gateway)

    expect(summary.candidates).toBe(2)
    expect(summary.outcomes.error).toBe(2)
    expect(summary.outcomes.ok).toBe(0)
    expect(tokenEndpoint.posts).toHaveLength(0)
    const { rows } = await dbPool.query(
      `SELECT recipe_name FROM oauth_grants
        WHERE refresh_token_encrypted IS NOT NULL ORDER BY recipe_name`
    )
    expect(rows).toEqual([{ recipe_name: 'cron-bib' }, { recipe_name: 'cron-pubrefs' }])
  })
})
