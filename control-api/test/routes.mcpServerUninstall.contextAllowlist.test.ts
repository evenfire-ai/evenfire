import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import type { PinnedTransport } from '../src/http/pinnedFetch.js'
import type { K8sGateway } from '../src/k8s.js'
import {
  type DiscoveryOutcome,
  type DiscoveryResult,
  discoverRemoteOAuth,
} from '../src/oauth/discovery.js'
import { probeMcpTransport } from '../src/oauth/mcpTransportProbe.js'
import { PILOTS, makeDiscoveryTransport } from './fixtures/remoteOAuthDiscovery.js'
import { MockGateway } from './mockGateway.js'

/**
 * The McpServer uninstall vs. the Context allowlist writers of the install routes
 * (R3-H5b + R3-S6), observed as the FINAL allowlist (T4).
 *
 * Both concurrent actors are the real routes mounted on one app over one stateful
 * MockGateway: the generic uninstall (`DELETE /admin/mcp-servers/:name`) and the
 * remote install saga (`POST /admin/mcp-servers/remote`, CIMD mode). The race is
 * forced from a gateway hook that runs one route inside the other's K8s call — no
 * allowlist write is hand-emulated (T1).
 *
 * The OAuth teardown's DB is a benign empty stub: these tests are about K8s order.
 */

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
}))

vi.mock('../src/oauth/discovery.js', async importActual => {
  const actual = await importActual<typeof import('../src/oauth/discovery.js')>()
  return { ...actual, discoverRemoteOAuth: vi.fn() }
})

vi.mock('../src/db.js', async importActual => {
  const actual = await importActual<typeof import('../src/db.js')>()
  return { ...actual, pool: { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) } }
})

const { config } = await import('../src/config.js')
const { createAdminResourcesRouter } = await import('../src/routes/admin/resources.js')
const { createAdminRemoteMcpRouter } = await import('../src/routes/admin/remoteMcp.js')

const NS = config.mcpServersNamespace

const PROBE_DNS = async () => ['93.184.216.34']
const ALIVE_TRANSPORT: PinnedTransport = async ({ method }) =>
  method === 'POST'
    ? { status: 401, headers: { 'www-authenticate': 'Bearer realm="OAuth"' }, bodyText: '' }
    : { status: 404, headers: {}, bodyText: '' }
const probe: typeof probeMcpTransport = (baseUrl, deps, opts) =>
  probeMcpTransport(baseUrl, { ...deps, transport: ALIVE_TRANSPORT, resolveDns: PROBE_DNS }, opts)

// Real Notion discovery with RFC 9207 advertised, derived from the real producer (T1)
// by the same documented substitution the remote-install route tests use.
let rfc9207Result: DiscoveryResult
beforeAll(async () => {
  const actual = await vi.importActual<typeof import('../src/oauth/discovery.js')>(
    '../src/oauth/discovery.js'
  )
  const as = JSON.parse(PILOTS.notion.as.json)
  as.authorization_response_iss_parameter_supported = true
  const pilot = { ...PILOTS.notion, as: { ...PILOTS.notion.as, json: JSON.stringify(as) } }
  const outcome = await actual.discoverRemoteOAuth(pilot.mcpUrl, {
    transport: makeDiscoveryTransport(pilot),
    resolveDns: PROBE_DNS,
  })
  if (!outcome.ok) throw new Error(`fixture discovery failed: ${outcome.error.kind}`)
  rfc9207Result = outcome.result
})

let prevContextsNs = ''
let prevCallbackBaseUrl = ''
beforeEach(() => {
  vi.mocked(discoverRemoteOAuth).mockResolvedValue({
    ok: true,
    result: rfc9207Result,
  } as DiscoveryOutcome)
  // The saga reads the Context in the gateway default namespace and the uninstall
  // in `contextsNamespace`; pinning them together makes both address one object, as
  // they do in production.
  prevContextsNs = config.contextsNamespace
  config.contextsNamespace = NS
  prevCallbackBaseUrl = config.oauthCallbackBaseUrl
  config.oauthCallbackBaseUrl = 'https://control.example.com'
})
afterEach(() => {
  config.contextsNamespace = prevContextsNs
  config.oauthCallbackBaseUrl = prevCallbackBaseUrl
  vi.restoreAllMocks()
})

function makeApp(gw: MockGateway) {
  const app = express()
  app.use(express.json())
  app.use(createAdminResourcesRouter(gw as unknown as K8sGateway))
  app.use(createAdminRemoteMcpRouter(gw as unknown as K8sGateway, { probe }))
  return app
}

async function seed(gw: MockGateway, servers: string[]): Promise<void> {
  await gw.createResource(
    'contexts',
    { metadata: { name: 'ctx-a' }, spec: { contextId: 'ctx-a', mcpServers: servers } },
    NS
  )
  for (const name of servers) {
    await gw.createResource('mcpservers', { metadata: { name }, spec: {} }, NS)
  }
}

const installBody = (serverName: string) => ({
  serverName,
  contextRef: 'ctx-a',
  baseUrl: 'https://mcp.notion.com/mcp',
  mode: 'cimd',
})

async function allowlist(gw: MockGateway): Promise<string[]> {
  const ctx = (await gw.getResource('contexts', 'ctx-a', NS)) as {
    spec: { mcpServers?: string[] }
  }
  return ctx.spec.mcpServers ?? []
}

describe('McpServer uninstall vs. Context allowlist writers', () => {
  // §7 row 7 (R3-H5b): a same-name reinstall can only create its CR once the old one
  // is gone. Stripping the allowlist AFTER that delete removed the reinstall's entry.
  it('a same-name reinstall that attaches right after the CR delete keeps its allowlist entry', async () => {
    const gw = new MockGateway(NS)
    await seed(gw, ['srv', 'other'])
    const app = makeApp(gw)

    let reinstallStatus: number | undefined
    let armed = true
    vi.spyOn(gw, 'deleteResource').mockImplementation(async (plural, name, ns, pre) => {
      const result = await MockGateway.prototype.deleteResource.call(gw, plural, name, ns, pre)
      if (armed && plural === 'mcpservers' && name === 'srv') {
        armed = false
        const reinstall = await request(app)
          .post('/admin/mcp-servers/remote')
          .send(installBody('srv'))
        reinstallStatus = reinstall.status
      }
      return result
    })

    const res = await request(app).delete('/admin/mcp-servers/srv')

    expect(res.status).toBe(200)
    expect(reinstallStatus).toBe(201)
    // The reinstalled server is live AND reachable through the Context.
    await expect(gw.getResource('mcpservers', 'srv', NS)).resolves.toBeTruthy()
    expect(await allowlist(gw)).toEqual(['other', 'srv'])
  })

  // §6.7 (R3-S6): an install of ANOTHER name read the Context before the uninstall's
  // strip and writes after it. Without a resourceVersion fence its write replays the
  // stale list and puts the uninstalled name back.
  it('an install of another name racing the strip does not reintroduce the uninstalled name', async () => {
    const gw = new MockGateway(NS)
    await seed(gw, ['old-srv'])
    const app = makeApp(gw)

    let uninstallStatus: number | undefined
    let armed = true
    vi.spyOn(gw, 'getResource').mockImplementation(async (plural, name, ns) => {
      const current = await MockGateway.prototype.getResource.call(gw, plural, name, ns)
      if (armed && plural === 'contexts' && name === 'ctx-a') {
        armed = false
        // The install's read is taken; the uninstall of old-srv then runs to
        // completion before the install gets to write.
        const stale = structuredClone(current)
        const uninstall = await request(app).delete('/admin/mcp-servers/old-srv')
        uninstallStatus = uninstall.status
        return stale
      }
      return current
    })

    const res = await request(app).post('/admin/mcp-servers/remote').send(installBody('new-srv'))

    expect(uninstallStatus).toBe(200)
    expect(res.status).toBe(201)
    await expect(gw.getResource('mcpservers', 'old-srv', NS)).rejects.toThrow()
    expect(await allowlist(gw)).toEqual(['new-srv'])
  })
})
