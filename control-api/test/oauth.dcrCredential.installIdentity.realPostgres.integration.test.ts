/**
 * The DCR credential reader (`resolveRemoteClientCredential`, shared by the
 * consent exchange and the refresh) only uses a `dynamic_clients` row that is not
 * yet bound to a CR — the consent can land between the CR create and the bind —
 * or is bound to the live CR's uid. A row bound to another uid belongs to a
 * previous installation of the same name and must never be presented to the AS.
 *
 * Real producers throughout (T1): the discovery result comes from running the
 * real `discoverRemoteOAuth` over the DCR-confidential pilot, the CR `spec.oauth`
 * from the install's `buildRemoteOAuthSpec`, the CR uid from the gateway, and the
 * `dynamic_clients` rows from the saga's own store calls on a real Postgres. The
 * RFC 7591 registration response is the only external fixture (a live DCR POST
 * would create a client at a third party).
 *
 *   CONTROL_API_REAL_PG_ADMIN_URL=postgres://<user>:<pass>@<host>:5432 npm test -- \
 *     test/oauth.dcrCredential.installIdentity.realPostgres.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { config } from '../src/config.js'
import type { DbClient } from '../src/db.js'
import { initDb } from '../src/db.js'
import type { PinnedRawResponse, PinnedTransportInput } from '../src/http/pinnedFetch.js'
import {
  type CallbackDeps,
  type CallbackInput,
  type McpServerOAuthReader,
  handleOAuthCallback,
} from '../src/oauth/callback.js'
import { type DiscoveryResult, discoverRemoteOAuth } from '../src/oauth/discovery.js'
import {
  bindDynamicClientToResource,
  insertDynamicClientPending,
} from '../src/oauth/dynamicClientStore.js'
import { deriveOAuthEncryptionKey } from '../src/oauth/encryption.js'
import { resolveServerOAuthSubject } from '../src/oauth/mcpServerOAuthSpec.js'
import { signOAuthState } from '../src/oauth/state.js'
import { upsertOAuthGrant } from '../src/oauth/store.js'
import { getAccessToken } from '../src/oauth/tokenHelper.js'
import { buildRemoteOAuthSpec } from '../src/routes/admin/remoteMcp.js'
import { type McpServerResource, normalizeMcpServerOwnerDecl } from '../src/routes/mcpOauth.js'
import {
  DCR_CONFIDENTIAL_REGISTRATION_RESPONSE,
  dcrPilot,
  makeDiscoveryTransport,
} from './fixtures/remoteOAuthDiscovery.js'
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
const STATE_SECRET = 'test-state-hmac-secret-32-bytes-padding'
const VALIDATED_IP = '93.184.216.34'
const REG = DCR_CONFIDENTIAL_REGISTRATION_RESPONSE

/** DCR-confidential pilot whose AS also advertises RFC 9207 (the remote callback requires it). */
function dcrConfidentialWithIss() {
  const pilot = dcrPilot('confidential')
  const as = JSON.parse(pilot.as.json)
  as.authorization_response_iss_parameter_supported = true
  return { ...pilot, as: { ...pilot.as, json: JSON.stringify(as) } }
}

/** Token endpoint that records every POST and always issues tokens. */
function recordingAs() {
  const posts: { url: string; body: string }[] = []
  const transport = async (input: PinnedTransportInput): Promise<PinnedRawResponse> => {
    posts.push({ url: input.url, body: input.body ?? '' })
    return {
      status: 200,
      headers: { 'content-type': 'application/json' },
      bodyText: JSON.stringify({
        access_token: 'NEW-AT',
        refresh_token: 'NEW-RT',
        expires_in: 3600,
      }),
    }
  }
  return { transport, posts }
}

describeRealPostgres(
  'DCR credential reader fenced by the live installation (real Postgres)',
  () => {
    const database = `control_api_dcr_identity_${randomUUID().replace(/-/g, '')}`
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

      const pilot = dcrConfidentialWithIss()
      const outcome = await discoverRemoteOAuth(pilot.mcpUrl, {
        transport: makeDiscoveryTransport(pilot),
        resolveDns: async () => [VALIDATED_IP],
      })
      if (!outcome.ok) throw new Error(`fixture discovery failed: ${outcome.error.kind}`)
      discovery = outcome.result
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

    /** Create the DCR CR the install saga would create; returns its gateway-assigned uid. */
    async function createCr(gateway: MockGateway, name: string): Promise<string> {
      await gateway.createResource(
        'mcpservers',
        {
          metadata: { name },
          spec: {
            contextRef: 'ctx-A',
            auth: { type: 'oauth' },
            oauth: buildRemoteOAuthSpec(discovery, {
              clientMode: 'confidential',
              grantScope: 'user',
              dynamicClientId: REG.client_id,
            }),
          },
        },
        NS
      )
      const cr = (await gateway.getResource('mcpservers', name, NS)) as {
        metadata: { uid: string }
      }
      return cr.metadata.uid
    }

    /** The saga's step 0: claim the name with a pending row carrying the registered client. */
    async function insertPending(name: string): Promise<string> {
      const installId = randomUUID()
      const { inserted } = await insertDynamicClientPending(db, KEY, {
        serverNamespace: NS,
        serverName: name,
        issuer: discovery.issuer,
        clientId: REG.client_id,
        clientMode: 'confidential',
        clientSecret: REG.client_secret,
        registrationAccessToken: REG.registration_access_token,
        registrationClientUri: REG.registration_client_uri,
        installId,
      })
      expect(inserted).toBe(true)
      return installId
    }

    async function bind(name: string, installId: string, crUid: string): Promise<void> {
      const { bound } = await bindDynamicClientToResource(
        db,
        { ownerKind: 'mcpserver', serverNamespace: NS, serverName: name },
        installId,
        crUid
      )
      expect(bound).toBe(true)
    }

    /** Install, bind, uninstall WITHOUT teardown, reinstall under the same name. */
    async function reinstallLeavingOldRow(gateway: MockGateway, name: string) {
      const oldUid = await createCr(gateway, name)
      await bind(name, await insertPending(name), oldUid)
      await gateway.deleteResource('mcpservers', name, NS)
      const liveUid = await createCr(gateway, name)
      expect(liveUid).not.toBe(oldUid)
      return { oldUid, liveUid }
    }

    /** The production subject reader (`external/oauthCallback.ts`) over the gateway. */
    function subjectReader(gateway: MockGateway): McpServerOAuthReader {
      return {
        async read(name) {
          const cr = (await gateway.getResource('mcpservers', name, NS)) as Parameters<
            typeof resolveServerOAuthSubject
          >[0]
          const resolved = resolveServerOAuthSubject(cr, 'consent')
          return resolved ? { namespace: NS, ...resolved } : null
        },
      }
    }

    function consent(
      gateway: MockGateway,
      name: string,
      transport: ReturnType<typeof recordingAs>['transport']
    ) {
      const input: CallbackInput = {
        target: { kind: 'remote-shared', origin: 'https://control.example.com' },
        code: 'AUTH_CODE',
        state: signOAuthState(STATE_SECRET, {
          subjectKind: 'mcp',
          mcpServerName: name,
          userId: 'user-9',
          oauthClientId: REG.client_id,
          grantKind: 'user',
          background: false,
        } as Parameters<typeof signOAuthState>[1]),
        iss: discovery.issuer,
      }
      const deps: CallbackDeps = {
        db,
        recipeReader: { read: async () => null },
        mcpServerReader: subjectReader(gateway),
        userContextsReader: async () => ({ contextIds: ['ctx-A'] }),
        secretReader: { read: async () => ({}) },
        fetchFn: (async () => {
          throw new Error('remote lane must not use fetchFn')
        }) as unknown as typeof fetch,
        stateSecret: STATE_SECRET,
        encryptionKey: KEY,
        resolveDns: async () => [VALIDATED_IP],
        pinnedTransport: transport,
      }
      return handleOAuthCallback(input, deps)
    }

    it('consent with a PENDING row (between CR create and bind) and a live CR exchanges normally', async () => {
      const gateway = new MockGateway(NS)
      const name = `dcr-pending-${randomUUID().slice(0, 8)}`
      await insertPending(name)
      await createCr(gateway, name)
      const as = recordingAs()

      const result = await consent(gateway, name, as.transport)

      expect(result.kind).toBe('ok')
      expect(as.posts).toHaveLength(1)
      expect(as.posts[0].body).toContain(`client_id=${REG.client_id}`)
      expect(as.posts[0].body).toContain('client_secret=')
    })

    it('consent with a row bound to the live CR exchanges normally', async () => {
      const gateway = new MockGateway(NS)
      const name = `dcr-live-${randomUUID().slice(0, 8)}`
      const installId = await insertPending(name)
      await bind(name, installId, await createCr(gateway, name))
      const as = recordingAs()

      const result = await consent(gateway, name, as.transport)

      expect(result.kind).toBe('ok')
      expect(as.posts).toHaveLength(1)
    })

    it('consent never presents the client of a previous installation of the same name', async () => {
      const gateway = new MockGateway(NS)
      const name = `dcr-stale-${randomUUID().slice(0, 8)}`
      await reinstallLeavingOldRow(gateway, name)
      const as = recordingAs()

      const result = await consent(gateway, name, as.transport)

      expect(result.kind).toBe('secret_missing')
      expect(as.posts).toHaveLength(0)
    })

    it('refresh never presents the client of a previous installation of the same name', async () => {
      const gateway = new MockGateway(NS)
      const name = `dcr-stale-refresh-${randomUUID().slice(0, 8)}`
      const { liveUid } = await reinstallLeavingOldRow(gateway, name)
      // A grant of the live installation, due for refresh.
      await upsertOAuthGrant(db, KEY, {
        grantKind: 'user',
        ownerKind: 'mcpserver',
        recipeNamespace: NS,
        recipeName: name,
        userId: 'user-9',
        oauthClientId: REG.client_id,
        provider: 'remote',
        accessToken: 'OLD-AT',
        refreshToken: 'OLD-RT',
        accessTokenExpiresInSec: 10,
        crUid: liveUid,
      })
      const as = recordingAs()

      const result = await getAccessToken(
        {
          grantKind: 'user',
          ownerKind: 'mcpserver',
          recipeNamespace: NS,
          recipeName: name,
          userId: 'user-9',
          oauthClientId: REG.client_id,
          crUid: liveUid,
        },
        {
          db,
          recipeReader: {
            read: async n =>
              normalizeMcpServerOwnerDecl(
                (await gateway.getResource('mcpservers', n, NS)) as McpServerResource
              ),
          },
          secretReader: { read: async () => ({}) },
          fetchFn: (async () => {
            throw new Error('remote lane must not use fetchFn')
          }) as unknown as typeof fetch,
          encryptionKey: KEY,
          resolveDns: async () => [VALIDATED_IP],
          pinnedTransport: as.transport,
        }
      )

      expect(result.kind).toBe('secret_missing')
      expect(as.posts).toHaveLength(0)
    })
  }
)
