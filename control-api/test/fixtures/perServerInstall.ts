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
import type { DbClient } from '../../src/db.js'
import type { PinnedTransport } from '../../src/http/pinnedFetch.js'
import type { K8sGateway } from '../../src/k8s.js'
import { type DiscoveryResult, discoverRemoteOAuth } from '../../src/oauth/discovery.js'
import { probeMcpTransport } from '../../src/oauth/mcpTransportProbe.js'
import { createAdminRemoteMcpRouter } from '../../src/routes/admin/remoteMcp.js'
import type { MockGateway } from '../mockGateway.js'
import {
  DCR_PUBLIC_REGISTRATION_RESPONSE,
  type RecordedDcrCall,
  makeDcrTransport,
  makeDiscoveryTransport,
} from './remoteOAuthDiscovery.js'

export const PUBLIC_IP = '93.184.216.34'
const resolvePublic = async () => [PUBLIC_IP]

/** Run the real discovery client over a probe fixture. */
export async function discoverPilot(
  pilot: Parameters<typeof makeDiscoveryTransport>[0]
): Promise<DiscoveryResult> {
  const outcome = await discoverRemoteOAuth(pilot.mcpUrl, {
    transport: makeDiscoveryTransport(pilot),
    resolveDns: resolvePublic,
  })
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

/** Seed the Context the install attaches the server to. */
export async function seedContext(gateway: MockGateway, namespace: string, name: string) {
  await gateway.createResource(
    'contexts',
    { metadata: { name }, spec: { contextId: name } },
    namespace
  )
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
}): Promise<InstallOutcome> {
  const { transport, calls } = makeDcrTransport({
    registrationEndpoint: opts.discovery.endpoints.registration,
    responseJson: JSON.stringify(opts.registration ?? DCR_PUBLIC_REGISTRATION_RESPONSE),
    redirectUris: 'requested',
  })
  const app = express()
  app.use(express.json())
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
