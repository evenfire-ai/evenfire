import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  fetchArtifactReadHostConnectionFromControlApi,
  fetchHostConnectionFromControlApi,
  fetchUserAllowedServersFromControlApi,
  fetchUserConnectorsFromControlApi,
  requestHostWakeFromControlApi,
} from '../services/controlApiRestService.js'

// rpc-proxy reaches control-api only through control-api-rpc-gateway, whose
// nginx config ends in a default `return 403`. Every request this service
// emits must therefore select a proxying location that allows its method.
// The requests come from the real emitter functions, not from a hand-written
// list, so a new control-api call without a gateway location fails here.

const USER = '00000000-0000-4000-8000-000000000001'
const HOST = 'host-a'

interface GatewayLocation {
  modifier: '=' | '~' | 'prefix'
  path: string
  methods: string[] | null
  proxies: boolean
}

function gatewayNginxConf(): string {
  const configmaps = readFileSync(
    new URL('../../../deploy/base/control-plane/configmaps.yaml', import.meta.url),
    'utf-8'
  )
  const docs = configmaps
    .split(/\n---\n/)
    .filter(doc => /^kind: ConfigMap$/m.test(doc) && /^  name: control-api-rpc-gateway$/m.test(doc))
  if (docs.length !== 1) {
    throw new Error(`expected one control-api-rpc-gateway ConfigMap, found ${docs.length}`)
  }
  return docs[0]
}

function blockBody(conf: string, openBrace: number): string {
  let depth = 0
  for (let i = openBrace; i < conf.length; i += 1) {
    if (conf[i] === '{') depth += 1
    if (conf[i] === '}') {
      depth -= 1
      if (depth === 0) return conf.slice(openBrace + 1, i)
    }
  }
  throw new Error('unterminated nginx location block')
}

function gatewayLocations(conf: string): GatewayLocation[] {
  const locations: GatewayLocation[] = []
  const re = /location\s+(?:(=|~)\s+)?([^\s{@][^\s{]*)\s*\{/g
  let m: RegExpExecArray | null
  while ((m = re.exec(conf)) !== null) {
    const body = blockBody(conf, m.index + m[0].length - 1)
    const limit = body.match(/limit_except\s+([A-Z ]+?)\s*\{/)
    locations.push({
      modifier: (m[1] as '=' | '~' | undefined) ?? 'prefix',
      path: m[2],
      methods: limit ? limit[1].trim().split(/\s+/) : null,
      proxies: /proxy_pass\s+http:\/\/control_api_upstream;/.test(body),
    })
  }
  return locations
}

// nginx selection for the shapes this config uses: an exact match wins, then
// the first matching regex in file order, then the longest prefix.
function selectLocation(locations: GatewayLocation[], path: string): GatewayLocation {
  const exact = locations.find(l => l.modifier === '=' && l.path === path)
  if (exact) return exact
  const regex = locations.find(l => l.modifier === '~' && new RegExp(l.path).test(path))
  if (regex) return regex
  const prefixes = locations
    .filter(l => l.modifier === 'prefix' && path.startsWith(l.path))
    .sort((a, b) => b.path.length - a.path.length)
  if (prefixes.length === 0) throw new Error(`no gateway location selects ${path}`)
  return prefixes[0]
}

function gatewayAdmits(locations: GatewayLocation[], method: string, path: string): boolean {
  const location = selectLocation(locations, path)
  if (!location.proxies) return false
  if (!location.methods) return true
  // limit_except GET also admits HEAD.
  return (
    location.methods.includes(method) || (method === 'HEAD' && location.methods.includes('GET'))
  )
}

function hostConnectionBody(): Response {
  return Response.json({
    userId: USER,
    hostRef: HOST,
    url: 'http://host-a.mcp-host.svc.cluster.local:8080',
    bindingStatus: 'recorded',
  })
}

async function emittedRequests(): Promise<Array<{ method: string; path: string }>> {
  const fetchMock = vi.fn(async (url: string | URL) => {
    const { pathname } = new URL(String(url))
    if (pathname.includes('/mcp-hosts/')) return hostConnectionBody()
    if (pathname.endsWith('/wake')) return Response.json({ status: 'active', wakeGeneration: 1 })
    return Response.json({ userId: USER, contextIds: [], servers: [], agents: [] })
  })
  vi.stubGlobal('fetch', fetchMock)
  const fetchImpl = fetchMock as unknown as typeof fetch

  await fetchUserAllowedServersFromControlApi(USER, 'jwt')
  await fetchUserConnectorsFromControlApi(USER, 'jwt')
  await fetchHostConnectionFromControlApi(USER, HOST, 'jwt', { fetchImpl })
  await fetchHostConnectionFromControlApi(USER, HOST, 'jwt', {
    directRunBinding: {
      runId: '00000000-0000-4000-8000-000000000123',
      sessionId: 'session-a',
      origin: 'direct_chat',
    },
    fetchImpl,
  })
  await fetchHostConnectionFromControlApi(USER, HOST, 'jwt', { messageResolution: true, fetchImpl })
  await fetchArtifactReadHostConnectionFromControlApi(USER, HOST, 'jwt', { fetchImpl })
  await requestHostWakeFromControlApi(HOST, 'jwt')

  return fetchMock.mock.calls.map(([url, init]) => ({
    method: String((init as RequestInit | undefined)?.method ?? 'GET'),
    path: new URL(String(url)).pathname,
  }))
}

describe('control-api-rpc-gateway parity with the rpc-proxy emitter', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('admits every request rpc-proxy sends to control-api', async () => {
    const requests = await emittedRequests()
    // Liveness witness: every emitter ran and produced its request.
    expect(requests).toEqual([
      { method: 'GET', path: `/api/v1/rpc/access/users/${USER}/mcp-servers` },
      { method: 'GET', path: `/api/v1/rpc/access/users/${USER}/mcp-connectors` },
      { method: 'GET', path: `/api/v1/rpc/access/users/${USER}/mcp-hosts/${HOST}` },
      { method: 'POST', path: `/api/v1/rpc/access/users/${USER}/mcp-hosts/${HOST}` },
      {
        method: 'POST',
        path: `/api/v1/rpc/access/users/${USER}/mcp-hosts/${HOST}/message-resolution`,
      },
      { method: 'GET', path: `/api/v1/rpc/access/users/${USER}/mcp-hosts/${HOST}/artifact-read` },
      { method: 'POST', path: `/api/v1/rpc/hosts/${HOST}/wake` },
    ])

    const locations = gatewayLocations(gatewayNginxConf())
    const denied = requests.filter(r => !gatewayAdmits(locations, r.method, r.path))
    expect(denied).toEqual([])
  })

  it('keeps the default deny for paths and methods rpc-proxy does not emit', () => {
    const locations = gatewayLocations(gatewayNginxConf())
    // Witness that the matcher can deny: these would pass a matcher that
    // admits everything.
    expect(gatewayAdmits(locations, 'GET', `/api/v1/rpc/access/users/${USER}/contexts`)).toBe(false)
    expect(
      gatewayAdmits(
        locations,
        'POST',
        `/api/v1/rpc/access/users/${USER}/mcp-hosts/${HOST}/artifact-read`
      )
    ).toBe(false)
    expect(
      gatewayAdmits(
        locations,
        'GET',
        `/api/v1/rpc/access/users/${USER}/mcp-hosts/${HOST}/message-resolution`
      )
    ).toBe(false)
    expect(
      gatewayAdmits(locations, 'GET', `/api/v1/rpc/access/users/${USER}/mcp-hosts/${HOST}/other`)
    ).toBe(false)
  })
})
