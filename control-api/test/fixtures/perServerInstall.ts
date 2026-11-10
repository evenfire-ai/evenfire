/**
 * Remote MCP servers installed through the REAL admin install route, for the consent
 * (authorize-url + callback) suites of the per-server callback variant.
 *
 * Everything the consent path reads is produced by its real producer (T1): discovery
 * by `discoverRemoteOAuth` over the probe fixtures, the CR and its `metadata.uid` by
 * the install saga on a `MockGateway`, the `dynamic_clients` row — install nonce and
 * `cr_uid` binding included — by the saga's own store calls on whatever `DbClient` the
 * suite passes (the in-memory harness or a real Postgres). The RFC 7591 registration
 * response is the only external fixture (a live DCR POST would create a client at a
 * third party); the AS echoes the `redirect_uris` actually POSTed.
 */
import express from 'express'
import request from 'supertest'
import { config } from '../../src/config.js'
import type { DbClient } from '../../src/db.js'
import type { PinnedTransport } from '../../src/http/pinnedFetch.js'
import type { K8sGateway } from '../../src/k8s.js'
import { type DiscoveryResult, discoverRemoteOAuth } from '../../src/oauth/discovery.js'
import { probeMcpTransport } from '../../src/oauth/mcpTransportProbe.js'
import { createAdminRemoteMcpRouter } from '../../src/routes/admin/remoteMcp.js'
import { createAdminResourcesRouter } from '../../src/routes/admin/resources.js'
import { MockGateway } from '../mockGateway.js'
import {
  DCR_PUBLIC_REGISTRATION_RESPONSE,
  ENTRA_TENANT_AUTHORITY,
  ENTRA_WORKIQ_PILOT,
  type RecordedDcrCall,
  makeDcrTransport,
  makeDiscoveryTransport,
  makeInMemoryDynamicClientsDb,
} from './remoteOAuthDiscovery.js'

export const PUBLIC_IP = '93.184.216.34'
const resolvePublic = async () => [PUBLIC_IP]

/** Run the real discovery client over a probe fixture. */
export async function discoverPilot(
  pilot: Parameters<typeof makeDiscoveryTransport>[0],
  opts: Parameters<typeof discoverRemoteOAuth>[2] = {}
): Promise<DiscoveryResult> {
  const outcome = await discoverRemoteOAuth(
    pilot.mcpUrl,
    { transport: makeDiscoveryTransport(pilot), resolveDns: resolvePublic },
    opts
  )
  if (!outcome.ok) throw new Error(`fixture discovery failed: ${outcome.error.kind}`)
  return outcome.result
}

/** Documented T1 substitution: add RFC 9207 to a pilot's AS metadata. */
export function withRfc9207<T extends { as: { json: string } }>(pilot: T): T {
  const as = JSON.parse(pilot.as.json)
  as.authorization_response_iss_parameter_supported = true
  return { ...pilot, as: { ...pilot.as, json: JSON.stringify(as) } }
}

// A tokenless POST `initialize` answered with a Bearer challenge: transport alive.
const ALIVE_TRANSPORT: PinnedTransport = async ({ method }) =>
  method === 'POST'
    ? { status: 401, headers: { 'www-authenticate': 'Bearer realm="OAuth"' }, bodyText: '' }
    : { status: 404, headers: {}, bodyText: '' }

const aliveProbe: typeof probeMcpTransport = (baseUrl, deps, opts) =>
  probeMcpTransport(
    baseUrl,
    { ...deps, transport: ALIVE_TRANSPORT, resolveDns: resolvePublic },
    opts
  )

export interface InstallOutcome {
  status: number
  body: Record<string, unknown>
  /** Every call the DCR transport received (empty for a pre-registered install). */
  dcrCalls: RecordedDcrCall[]
}

const NO_GRANTS_DB: DbClient = { query: async () => ({ rows: [], rowCount: 0 }) } as DbClient

/** Seed an empty Context that a suite later enables servers in. */
export async function seedContext(gateway: MockGateway, namespace: string, name: string) {
  await gateway.createResource(
    'contexts',
    { metadata: { name }, spec: { contextId: name } },
    namespace
  )
}

/**
 * Enable an installed server in a Context the way the console does once an install has
 * finished: the real `PUT /admin/contexts/:name`, carrying the resourceVersion it read
 * and the allowlist plus the server. An install never touches an allowlist itself.
 */
export async function enableServerInContext(
  gateway: MockGateway,
  contextName: string,
  serverName: string,
  /**
   * Where the route's shared-grant purge runs. The default answers no rows, so a suite
   * without grants never reaches the network; a suite that holds grants passes its DB.
   */
  oauthDb: DbClient = NO_GRANTS_DB
): Promise<void> {
  const current = (await gateway.getResource(
    'contexts',
    contextName,
    config.contextsNamespace
  )) as { metadata: { resourceVersion?: string }; spec: Record<string, unknown> }
  const allowlist = Array.isArray(current.spec.mcpServers)
    ? (current.spec.mcpServers as string[])
    : []
  const app = express()
  app.use(express.json())
  app.use(createAdminResourcesRouter(gateway as unknown as K8sGateway, { oauthDb }))
  const res = await request(app)
    .put(`/admin/contexts/${contextName}`)
    .send({
      metadata: { resourceVersion: current.metadata.resourceVersion },
      spec: { ...current.spec, mcpServers: [...new Set([...allowlist, serverName])] },
    })
  if (res.status !== 200) {
    throw new Error(`enabling ${serverName} in ${contextName} failed: ${JSON.stringify(res.body)}`)
  }
}

/**
 * POST /admin/mcp-servers/remote through the real router. `discovery` is what the
 * install's server-side discovery resolves; for DCR the AS assigns `registration`.
 */
export async function installRemoteServer(opts: {
  gateway: MockGateway
  db: DbClient
  discovery: DiscoveryResult
  body: Record<string, unknown>
  registration?: Record<string, unknown>
  /** Stands in for the correlation middleware's `req.log`, for suites that assert logs. */
  reqLog?: unknown
}): Promise<InstallOutcome> {
  const { transport, calls } = makeDcrTransport({
    registrationEndpoint: opts.discovery.endpoints.registration,
    responseJson: JSON.stringify(opts.registration ?? DCR_PUBLIC_REGISTRATION_RESPONSE),
    redirectUris: 'requested',
  })
  const app = express()
  app.use(express.json())
  if (opts.reqLog) {
    app.use((req, _res, next) => {
      ;(req as { log?: unknown }).log = opts.reqLog
      next()
    })
  }
  app.use(
    createAdminRemoteMcpRouter(opts.gateway as unknown as K8sGateway, {
      db: opts.db,
      discover: async () => ({ ok: true, result: opts.discovery }),
      probe: aliveProbe,
      dcr: { transport, resolveDns: resolvePublic },
    })
  )
  const res = await request(app).post('/admin/mcp-servers/remote').send(opts.body)
  return { status: res.status, body: res.body as Record<string, unknown>, dcrCalls: calls }
}

/** The two scope forms Work IQ accepts: the GUID its PRM advertises and its App ID URI. */
export const WORKIQ_GUID_SCOPE = 'fdcc1f02-fc51-4226-8753-f668596af7f7/WorkIQAgent.Ask'
export const WORKIQ_URL_SCOPE = 'api://workiq.svc.cloud.microsoft/WorkIQAgent.Ask'

/** The McpServer CR as the install persists it, read back from the gateway. */
export interface InstalledMcpServer {
  metadata: { name: string; uid: string }
  spec: {
    auth: { type: string }
    remote: { baseUrl: string }
    oauth: Record<string, unknown>
  } & Record<string, unknown>
}

/**
 * Install Work IQ through the real route — discovery with the tenant authority, the
 * `entra-v2` profile, pre-registered client — then enable it in `enableInContext` through
 * the real Context route, and return the CR the saga wrote. This is the only producer of
 * a CR carrying `asProfile`, so runtime suites start from it and any edit they make on
 * top is the direct write (API or kubectl) they model.
 */
export async function installWorkIqServer(
  opts: {
    scopes?: string[]
    serverName?: string
    enableInContext?: string
    /** A gateway the suite already seeded with `enableInContext`; a fresh one otherwise. */
    gateway?: MockGateway
    db?: DbClient
  } = {}
): Promise<InstalledMcpServer> {
  const serverName = opts.serverName ?? 'workiq'
  const contextName = opts.enableInContext ?? 'ctx-a'
  const namespace = config.mcpServersNamespace
  const gateway = opts.gateway ?? new MockGateway(namespace)
  if (!opts.gateway) await seedContext(gateway, config.contextsNamespace, contextName)
  const discovery = await discoverPilot(ENTRA_WORKIQ_PILOT, {
    hasPreRegisteredClient: true,
    authorizationServer: ENTRA_TENANT_AUTHORITY,
  })
  const savedCallbackBaseUrl = config.oauthCallbackBaseUrl
  config.oauthCallbackBaseUrl = 'https://control.example.com'
  try {
    const res = await installRemoteServer({
      gateway,
      db: opts.db ?? makeInMemoryDynamicClientsDb().db,
      discovery,
      body: {
        serverName,
        baseUrl: ENTRA_WORKIQ_PILOT.mcpUrl,
        mode: 'pre-registered',
        clientId: '11111111-2222-3333-4444-555555555555',
        clientSecret: 'entra-client-secret',
        authorizationServer: ENTRA_TENANT_AUTHORITY,
        scopes: opts.scopes ?? [WORKIQ_GUID_SCOPE],
      },
    })
    if (res.status !== 201) throw new Error(`Work IQ install failed: ${JSON.stringify(res.body)}`)
  } finally {
    config.oauthCallbackBaseUrl = savedCallbackBaseUrl
  }
  await enableServerInContext(gateway, contextName, serverName)
  return (await gateway.getResource('mcpservers', serverName, namespace)) as InstalledMcpServer
}
