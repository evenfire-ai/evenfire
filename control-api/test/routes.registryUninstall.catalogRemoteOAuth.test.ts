import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import express from 'express'
import request from 'supertest'
import { config } from '../src/config.js'
import type { DbClient } from '../src/db.js'
import type { K8sGateway } from '../src/k8s.js'
import { deriveCatalogRemoteServerName } from '../src/routes/admin/catalogRemoteOAuth.js'
import { createAdminRegistryRouter } from '../src/routes/admin/registry.js'
import { createAdminResourcesRouter } from '../src/routes/admin/resources.js'
import { remoteOAuthMcpServer } from './fixtures/remoteOAuthMcpServer.js'
import { MockGateway } from './mockGateway.js'

/**
 * Uninstalling a remote-OAuth catalog instance through the registry route frees its
 * slot exactly like the generic McpServer DELETE: no CR, no grants, no dynamic
 * client row, no `-oauth-client` Secret, and the name out of every allowlist. Both
 * routes run the real `uninstallMcpServer`; the doubles are K8s (stateful
 * MockGateway) and the two OAuth tables the teardown deletes from.
 *
 * Regression only: the registry route already delegates to the shared uninstall.
 */

const NS = 'mcp-server'
const CATALOG_ID = '@evenfire/notion'
const SERVER = deriveCatalogRemoteServerName(CATALOG_ID, 'user')

interface GrantRow {
  owner_kind: string
  recipe_namespace: string
  recipe_name: string
  cr_uid: string | null
}
interface DynamicClientRow {
  owner_kind: string
  server_namespace: string
  server_name: string
  cr_uid: string | null
  install_id: string | null
}

/**
 * The two OAuth tables, with the WHERE clauses of the teardown's DELETE statements
 * (`deleteOAuthGrantsForServer`, `claimDeleteDynamicClientForResource`). Any other
 * statement is unexpected for an uninstall and fails the test.
 */
function oauthTables() {
  const grants: GrantRow[] = []
  const dynamicClients: DynamicClientRow[] = []
  const db: DbClient = {
    query: async (text: string, values: unknown[] = []) => {
      if (/DELETE FROM oauth_grants/.test(text)) {
        const [ns, name, uid] = values as string[]
        const removed = grants.filter(
          g =>
            g.owner_kind === 'mcpserver' &&
            g.recipe_namespace === ns &&
            g.recipe_name === name &&
            (g.cr_uid === uid || g.cr_uid === null)
        )
        grants.splice(0, grants.length, ...grants.filter(g => !removed.includes(g)))
        return { rows: [], rowCount: removed.length } as never
      }
      if (/DELETE FROM dynamic_clients/.test(text)) {
        const [kind, ns, name, uid] = values as string[]
        const removed = dynamicClients.filter(
          d =>
            d.owner_kind === kind &&
            d.server_namespace === ns &&
            d.server_name === name &&
            (d.cr_uid === uid || (d.install_id === null && d.cr_uid === null))
        )
        dynamicClients.splice(
          0,
          dynamicClients.length,
          ...dynamicClients.filter(d => !removed.includes(d))
        )
        const rows = removed.map(() => ({
          registration_client_uri: null,
          registration_access_token_encrypted: null,
        }))
        return { rows, rowCount: rows.length } as never
      }
      throw new Error(`unexpected statement: ${text}`)
    },
  }
  return { db, grants, dynamicClients }
}

let prev: { mcp: string; contexts: string }
beforeEach(() => {
  prev = { mcp: config.mcpServersNamespace, contexts: config.contextsNamespace }
  config.mcpServersNamespace = NS
  config.contextsNamespace = NS
})
afterEach(() => {
  config.mcpServersNamespace = prev.mcp
  config.contextsNamespace = prev.contexts
})

/** One installed catalog slot, with everything an install and a consent leave behind. */
async function installedSlot() {
  const gw = new MockGateway(NS)
  const tables = oauthTables()
  const cr = (await gw.createResource(
    'mcpservers',
    await remoteOAuthMcpServer({
      serverName: SERVER,
      namespace: NS,
      grantScope: 'user',
      catalog: { id: CATALOG_ID, version: '1.0.0' },
    }),
    NS
  )) as { metadata: { uid: string } }
  const uid = cr.metadata.uid
  gw.seedSecret(`${SERVER}-oauth-client`, NS, {
    labels: { 'clerum.io/managed-by': 'control-api', 'clerum.io/server-mode': 'remote' },
    stringData: { client_id: 'cid', client_secret: 'csec' },
  })
  for (const ctx of ['ctx-a', 'ctx-b']) {
    await gw.createResource(
      'contexts',
      { metadata: { name: ctx }, spec: { contextId: ctx, mcpServers: [SERVER, 'other'] } },
      NS
    )
  }
  tables.grants.push({
    owner_kind: 'mcpserver',
    recipe_namespace: NS,
    recipe_name: SERVER,
    cr_uid: uid,
  })
  tables.dynamicClients.push({
    owner_kind: 'mcpserver',
    server_namespace: NS,
    server_name: SERVER,
    cr_uid: uid,
    install_id: 'install-1',
  })
  return { gw, ...tables }
}

async function slotState(gw: MockGateway, tables: ReturnType<typeof oauthTables>) {
  const exists = async (read: () => Promise<unknown>) =>
    read().then(
      () => true,
      () => false
    )
  const allowlists = await Promise.all(
    ['ctx-a', 'ctx-b'].map(
      async ctx =>
        ((await gw.getResource('contexts', ctx, NS)) as { spec: { mcpServers?: string[] } }).spec
          .mcpServers ?? []
    )
  )
  return {
    cr: await exists(() => gw.getResource('mcpservers', SERVER, NS)),
    oauthClientSecret: await exists(() => gw.getSecret(`${SERVER}-oauth-client`, NS)),
    grants: tables.grants.length,
    dynamicClients: tables.dynamicClients.length,
    allowlists,
  }
}

const FREED = {
  cr: false,
  oauthClientSecret: false,
  grants: 0,
  dynamicClients: 0,
  allowlists: [['other'], ['other']],
}

describe('uninstall of a remote-OAuth catalog instance', () => {
  it('the registry route and the generic DELETE both leave the slot free', async () => {
    const viaRegistry = await installedSlot()
    // Precondition: everything the teardown must remove is there.
    expect(await slotState(viaRegistry.gw, viaRegistry)).toEqual({
      cr: true,
      oauthClientSecret: true,
      grants: 1,
      dynamicClients: 1,
      allowlists: [
        [SERVER, 'other'],
        [SERVER, 'other'],
      ],
    })
    const registryApp = express()
    registryApp.use(
      createAdminRegistryRouter(viaRegistry.gw as unknown as K8sGateway, {
        uninstallDb: viaRegistry.db,
      })
    )
    const registryRes = await request(registryApp).delete(`/admin/registry/uninstall/${SERVER}`)
    expect(registryRes.status).toBe(200)

    const viaGeneric = await installedSlot()
    const genericApp = express()
    genericApp.use(
      createAdminResourcesRouter(viaGeneric.gw as unknown as K8sGateway, {
        oauthDb: viaGeneric.db,
      })
    )
    const genericRes = await request(genericApp).delete(`/admin/mcp-servers/${SERVER}`)
    expect(genericRes.status).toBe(200)

    const registryState = await slotState(viaRegistry.gw, viaRegistry)
    expect(registryState).toEqual(FREED)
    expect(registryState).toEqual(await slotState(viaGeneric.gw, viaGeneric))
  })
})
