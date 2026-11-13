/**
 * A catalog slot reinstalled under its canonical name must not inherit anything from
 * the previous installation, on a real Postgres.
 *
 * Both installations go through the real catalog-mode install route (DCR), so the CRs,
 * their uids and the `dynamic_clients` row come from their real producers. The CR of the
 * first installation is then deleted out of band (no uninstall teardown), which leaves
 * its grant and its dynamic client behind; the grant is written by the real store writer
 * sealed with the uid the consent callback would carry. The reader key of the new
 * installation is derived with `resolveServerOAuth` + `buildMcpServerGrantKey` from the
 * CR the gateway returns, exactly as the broker derives it.
 *
 *   CONTROL_API_REAL_PG_ADMIN_URL=postgres://<user>:<pass>@<host>:5432 npm test -- \
 *     test/routes.adminRemoteMcp.catalogMode.realPostgres.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import request from 'supertest'
import { config } from '../src/config.js'
import type { DbClient, DbTransactionClient } from '../src/db.js'
import { initDb, withTransaction } from '../src/db.js'
import type { K8sGateway } from '../src/k8s.js'
import type { DiscoveryResult } from '../src/oauth/discovery.js'
import { getDynamicClient } from '../src/oauth/dynamicClientStore.js'
import { deriveOAuthEncryptionKey } from '../src/oauth/encryption.js'
import { buildMcpServerGrantKey, resolveServerOAuth } from '../src/oauth/mcpServerOAuthSpec.js'
import { probeMcpTransport } from '../src/oauth/mcpTransportProbe.js'
import { type OAuthGrantKey, getOAuthGrant, upsertOAuthGrant } from '../src/oauth/store.js'
import { deriveCatalogRemoteServerName } from '../src/routes/admin/catalogRemoteOAuth.js'
import { createAdminRemoteMcpRouter } from '../src/routes/admin/remoteMcp.js'
import { type RegistryEntry, getEntryVersion } from '../src/services/registryClient.js'
import { discoverPilot, withRfc9207 } from './fixtures/perServerInstall.js'
import { registryEntryRow } from './fixtures/registryEntryRow.js'
import {
  DCR_CONFIDENTIAL_REGISTRATION_RESPONSE,
  dcrPilot,
  makeDcrTransport,
} from './fixtures/remoteOAuthDiscovery.js'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'
import { MockGateway } from './mockGateway.js'

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
}))

vi.mock('../src/services/registryClient.js', async importActual => {
  const actual = await importActual<typeof import('../src/services/registryClient.js')>()
  return {
    ...actual,
    getEntryVersion: vi.fn(),
    reportInstall: vi.fn(async () => ({ acknowledged: true, stored: true })),
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
const ENTRY = '@evenfire/notion-remote'
const PUBLIC_IP = async () => ['93.184.216.34']

type ServerCR = Parameters<typeof resolveServerOAuth>[0] & {
  metadata: { uid: string }
  spec: { oauth: { id: string } }
}

function readerKey(server: ServerCR, name: string, userId: string): OAuthGrantKey {
  const resolved = resolveServerOAuth(server)
  if (!resolved) throw new Error('fixture: server did not resolve as OAuth')
  const key = buildMcpServerGrantKey(resolved, {
    mcpServerName: name,
    mcpServersNamespace: NS,
    userId,
    contextId: 'ctx-1',
  })
  if (!key) throw new Error('fixture: no grant key')
  return key
}

describeRealPostgres(
  'catalog slot reinstall inherits no grant or dynamic client (real Postgres)',
  () => {
    const database = `control_api_catalog_slot_${randomUUID().replace(/-/g, '')}`
    let adminPool: Pool
    let dbPool: Pool
    let db: DbClient
    let dcrResult: DiscoveryResult

    beforeAll(async () => {
      if (!adminUrl) throw new Error('CONTROL_API_REAL_PG_ADMIN_URL is required')
      adminPool = new Pool({ connectionString: adminUrl })
      await adminPool.query(`CREATE DATABASE "${database.replace(/"/g, '""')}"`)
      dbPool = new Pool({ connectionString: databaseUrl(adminUrl, database) })
      await initDb({ connect: () => dbPool.connect() })
      db = { query: (text, values) => dbPool.query(text, values) }
      dcrResult = await discoverPilot(withRfc9207(dcrPilot('confidential')))
      vi.mocked(getEntryVersion).mockResolvedValue(
        registryEntryRow(
          {
            name: ENTRY,
            mcpServer: {
              serverMode: 'remote',
              remoteEndpoints: [{ url: 'https://mcp.notion.com/mcp' }],
              oauth: {
                source: 'remote',
                allowedGrantScopes: ['user'],
                expectedRegistration: 'dcr',
              },
            },
          },
          { kind: 'curator-machine' }
        ) as unknown as RegistryEntry
      )
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

    async function catalogInstall(gw: MockGateway, clientId: string) {
      const { transport } = makeDcrTransport({
        responseJson: JSON.stringify({
          ...DCR_CONFIDENTIAL_REGISTRATION_RESPONSE,
          client_id: clientId,
          registration_client_uri: `https://mcp.notion.com/register/${clientId}`,
        }),
      })
      const app = express()
      app.use(express.json())
      app.use(
        createAdminRemoteMcpRouter(gw as unknown as K8sGateway, {
          db,
          discover: async () => ({ ok: true, result: dcrResult }),
          probe: (url, deps, opts) =>
            probeMcpTransport(
              url,
              {
                ...deps,
                resolveDns: PUBLIC_IP,
                transport: async ({ method }) =>
                  method === 'POST'
                    ? { status: 401, headers: { 'www-authenticate': 'Bearer' }, bodyText: '' }
                    : { status: 404, headers: {}, bodyText: '' },
              },
              opts
            ),
          dcr: { transport, resolveDns: PUBLIC_IP },
          runInTransaction: <T>(work: (tx: DbTransactionClient) => Promise<T>) =>
            withTransaction(work, dbPool),
        })
      )
      // DCR registers a redirect URI on the public callback origin.
      const savedCallbackBaseUrl = config.oauthCallbackBaseUrl
      config.oauthCallbackBaseUrl = 'https://control.example.com'
      try {
        return await request(app)
          .post('/admin/mcp-servers/remote')
          .send({
            catalogEntry: { name: ENTRY, version: '1.0.0' },
            grantScope: 'user',
            mode: 'dcr',
          })
      } finally {
        config.oauthCallbackBaseUrl = savedCallbackBaseUrl
      }
    }

    it('the old grant stays invisible and the dynamic client row belongs to the new install', async () => {
      const gw = new MockGateway(NS)
      const name = deriveCatalogRemoteServerName(ENTRY, 'user')

      expect((await catalogInstall(gw, 'dyn-first')).status).toBe(201)
      const oldCr = (await gw.getResource('mcpservers', name, NS)) as ServerCR
      await upsertOAuthGrant(db, KEY, {
        ...readerKey(oldCr, name, 'user-1'),
        provider: 'remote',
        accessToken: 'at-old',
        refreshToken: 'rt-old',
        accessTokenExpiresInSec: 3600,
        crUid: oldCr.metadata.uid,
      } as Parameters<typeof upsertOAuthGrant>[2])
      await gw.deleteResource('mcpservers', name, NS) // out of band: no teardown ran

      expect((await catalogInstall(gw, 'dyn-second')).status).toBe(201)
      const newCr = (await gw.getResource('mcpservers', name, NS)) as ServerCR
      expect(newCr.metadata.uid).not.toBe(oldCr.metadata.uid)

      expect(await getOAuthGrant(db, KEY, readerKey(newCr, name, 'user-1'))).toBeNull()
      // Control: the old row is really there, sealed to the dead installation.
      expect((await getOAuthGrant(db, KEY, readerKey(oldCr, name, 'user-1')))?.accessToken).toBe(
        'at-old'
      )

      const row = await getDynamicClient(db, KEY, { serverNamespace: NS, serverName: name })
      expect(row?.crUid).toBe(newCr.metadata.uid)
      expect(row?.clientId).toBe('dyn-second')
      expect(newCr.spec.oauth.id).toBe('dyn-second')
    })
  }
)
