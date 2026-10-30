import { afterEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import request from 'supertest'
import {
  canonicalResourceIdentity,
  hashActionTarget,
  validateActionOperationTarget,
} from '@clerum/action-context-contracts'
import { authorizeActionV2 } from '../actionAuthorityV2.js'
import { config } from '../config.js'
import { createMcpOauthRouter } from '../routes/mcpOauth.js'
import { createSandboxUiSessionRouter } from '../routes/sandboxUi.js'
import {
  fetchHostConnectionFromControlApi,
  fetchUserAllowedServersFromControlApi,
  fetchUserConnectorsFromControlApi,
  requestHostWakeFromControlApi,
} from '../services/controlApiRestService.js'
import { startPr2ReadinessReporter } from '../services/pr2ReadinessReporter.js'
import {
  _clearSandboxUiRegistryCache,
  listSandboxUiApps,
  lookupSandboxUiRegistry,
} from '../services/sandboxUiRegistry.js'
import { createSandboxUiSession } from '../services/sandboxUiSession.js'
import type { UserDelegationV2Claims } from '../userDelegationV2.js'

// rpc-proxy reaches control-api only through control-api-rpc-gateway, whose
// nginx config ends in a default `return 403`. Every request this service
// emits must therefore select a proxying location that allows its method.
// The requests come from the real emitters (service functions and route
// handlers), not from a hand-written list. A source inventory below fails when
// a new control-api URL is built somewhere this test does not exercise.

const authTokenMock = vi.hoisted(() => ({ verifyRpcToken: vi.fn() }))
vi.mock('../authToken.js', () => authTokenMock)

const USER = '00000000-0000-4000-8000-000000000001'
const HOST = 'host-a'
const RPC_CLAIMS = {
  sub: USER,
  typ: 'user' as const,
  accessScope: 'team' as const,
  teamId: 'team-1',
  scopes: ['mcp:server:invoke', 'sandbox:ui:view'],
  hostRefs: [HOST],
  jti: 'j1',
  iat: 1,
  exp: 9999999999,
}

// Every source file outside config.ts that mentions controlApiBaseUrl, with
// the number of mentions. The two services count their local
// controlApiBaseUrl() helper's definition and body; every other mention is a
// URL construction site. Any new use of the base URL, in any form, changes a
// count: add its emitter to emittedRequests() and update this inventory.
const CONTROL_API_BASE_URL_MENTIONS: Record<string, number> = {
  'actionAuthorityV2.ts': 1,
  'routes/mcpOauth.ts': 2,
  'routes/sandboxUi.ts': 3,
  'services/controlApiRestService.ts': 7,
  'services/pr2ReadinessReporter.ts': 1,
  'services/sandboxUiRegistry.ts': 4,
}

function productionSources(): Array<{ rel: string; source: string }> {
  const srcDir = fileURLToPath(new URL('..', import.meta.url))
  const files: Array<{ rel: string; source: string }> = []
  const visit = (dir: string, relative: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (entry.name !== '__tests__') visit(join(dir, entry.name), rel)
        continue
      }
      if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue
      files.push({ rel, source: readFileSync(join(dir, entry.name), 'utf-8') })
    }
  }
  visit(srcDir, '')
  if (files.length === 0) throw new Error('no rpc-proxy production sources found')
  return files
}

function controlApiBaseUrlMentions(): Record<string, number> {
  const mentions: Record<string, number> = {}
  for (const { rel, source } of productionSources()) {
    if (rel === 'config.ts') continue
    const count = source.split('controlApiBaseUrl').length - 1
    if (count > 0) mentions[rel] = count
  }
  return mentions
}

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

const PR2_CHECKPOINT_PATH = '/api/v1/internal/action-authority/checkpoint'
const PR2_RUNTIME_EVIDENCE_PATH = '/api/v1/internal/pr2-readiness/runtime-evidence'

const PR2_RESOURCE = canonicalResourceIdentity({
  environmentId: 'test',
  type: 'host',
  logicalId: 'mcp-host/chatllm',
  displayName: 'Chat LLM',
})
const PR2_TARGET = validateActionOperationTarget({
  operationId: 'host.status.read',
  resource: PR2_RESOURCE,
  operationTarget: { hostRef: 'mcp-host/chatllm' },
})
const PR2_BOUND = {
  operationId: 'host.status.read' as const,
  target: PR2_TARGET,
  targetHash: hashActionTarget(PR2_TARGET),
}
const PR2_DELEGATION: UserDelegationV2Claims = {
  typ: 'user_delegation',
  ver: 2,
  sub: USER,
  sid: '00000000-0000-4000-8000-000000000002',
  sv: 2,
  jti: 'j1',
  iat: 1,
  exp: 9999999999,
  operationIds: ['host.status.read'],
  scopes: ['action:host.status.read'],
  resource: PR2_RESOURCE,
  targets: { 'host.status.read': PR2_TARGET },
  targetHashes: { 'host.status.read': PR2_BOUND.targetHash },
  accessPathId: `ap1_${'A'.repeat(43)}`,
  authorizationRevision: `ar1_${'B'.repeat(43)}`,
  behaviorBindingHash: `bh2_${'C'.repeat(43)}`,
  pathKind: 'team',
  effectiveTeamId: '00000000-0000-4000-8000-000000000003',
}
const PR2_BEHAVIOR = {
  budget: { state: 'unknown' as const },
  credentialPolicy: { state: 'unknown' as const },
  approvalPolicy: { state: 'unknown' as const },
  filesystemScope: { state: 'unknown' as const },
  runtime: { state: 'unknown' as const },
  providerModelPolicy: { state: 'unknown' as const },
  audit: { state: 'unknown' as const },
}

function allowedCheckpointBody(): Response {
  const checkedAt = new Date()
  return Response.json({
    version: 2,
    status: 'allowed',
    authorizationRevision: PR2_DELEGATION.authorizationRevision,
    behaviorBindingHash: PR2_DELEGATION.behaviorBindingHash,
    behavior: PR2_BEHAVIOR,
    checkedAt: checkedAt.toISOString(),
    validUntil: new Date(checkedAt.getTime() + 30_000).toISOString(),
    attribution: {
      userId: PR2_DELEGATION.sub,
      sid: PR2_DELEGATION.sid,
      sessionVersion: PR2_DELEGATION.sv,
      accessPathId: PR2_DELEGATION.accessPathId,
      pathKind: PR2_DELEGATION.pathKind,
      effectiveTeamId: PR2_DELEGATION.effectiveTeamId,
    },
    destination: {
      kind: 'host',
      ref: 'mcp-host/chatllm',
      url: 'http://chatllm.mcp-host.svc.cluster.local:3000',
    },
  })
}

const PR2_READINESS_ENVIRONMENT = {
  EVENFIRE_SOURCE_REVISION: 'a'.repeat(40),
  PR2_READINESS_ENVIRONMENT_ID: 'test.cluster',
  EVENFIRE_SERVICE_VERSION: '0.1.0',
  EVENFIRE_DEPLOYMENT_REVISION: 'deployment-a',
  EVENFIRE_IMAGE_REVISION: 'a'.repeat(40),
  PR2_READINESS_REPORT_INTERVAL_MS: '60000',
} as const

type EmittedRequest = { method: string; path: string }

async function emittedRequests(): Promise<{
  requests: EmittedRequest[]
  gatewayRequests: EmittedRequest[]
  readinessHops: string[]
}> {
  const readinessHops: string[] = []
  const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const { pathname } = new URL(String(url))
    // PR2 routes come first: the Host-RPC admission path also contains
    // /mcp-hosts/, and the mock must not answer it with a Host binding.
    if (pathname === PR2_RUNTIME_EVIDENCE_PATH) {
      readinessHops.push(JSON.parse(String(init?.body)).hop)
      return new Response(null, { status: 201 })
    }
    // The fake answers the checkpoint by prefix so a path mutation reaches the
    // expected-list assertion instead of failing inside the response parser.
    if (pathname.startsWith(PR2_CHECKPOINT_PATH)) return allowedCheckpointBody()
    if (pathname.includes('/mcp-hosts/')) return hostConnectionBody()
    if (pathname.endsWith('/wake')) return Response.json({ status: 'active', wakeGeneration: 1 })
    if (pathname.includes('/internal/sandbox-ui/registry/')) {
      return Response.json({
        appRef: 'sandbox-recipes/r1',
        service: { name: 'web', namespace: config.sandboxUiNamespace, port: 8080 },
        ready: true,
        defaultPath: '/',
      })
    }
    if (pathname.endsWith('/internal/sandbox-ui/apps')) return Response.json({ apps: [] })
    if (pathname.includes('/oauth/') || pathname.includes('/mcp-oauth/')) {
      return Response.json({ authorizeUrl: 'https://login.invalid/authorize' })
    }
    return Response.json({ userId: USER, contextIds: [], servers: [], agents: [] })
  })
  vi.stubGlobal('fetch', fetchMock)
  authTokenMock.verifyRpcToken.mockReturnValue({ ...RPC_CLAIMS })
  _clearSandboxUiRegistryCache()
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
  await requestHostWakeFromControlApi(HOST, 'jwt')
  await lookupSandboxUiRegistry('sandbox-recipes', 'r1', USER, 'team-1')
  await listSandboxUiApps(USER, 'team-1')

  const app = express()
  app.use(express.json())
  app.use('/api/v1', createMcpOauthRouter())
  app.use('/api/v1', createSandboxUiSessionRouter())
  const bearer = 'Bearer rpc-token'
  await request(app).post('/api/v1/mcp-oauth/gdrive/authorize-url').set('Authorization', bearer)
  await request(app).delete('/api/v1/mcp-oauth/gdrive/grant').set('Authorization', bearer)
  _clearSandboxUiRegistryCache()
  await request(app)
    .post('/api/v1/sandbox-ui/sandbox-recipes/r1/oauth/authorize-url')
    .set('Authorization', bearer)
    .send({ oauthClientId: 'client-a' })
  const sandboxCookie = `${config.sandboxUiCookieName}=${createSandboxUiSession(USER, 'sandbox-recipes', 'r1')}`
  await request(app)
    .post('/api/v1/sandbox-ui/sandbox-recipes/r1/oauth/token')
    .set('Cookie', sandboxCookie)
    .send({ oauthClientId: 'client-a' })
  await request(app)
    .delete('/api/v1/sandbox-ui/sandbox-recipes/r1/oauth/grant')
    .set('Cookie', sandboxCookie)
    .send({ oauthClientId: 'client-a' })

  // PR2 producers. The wake reuses the checked-in delegation so the V2 wake
  // branch and the action-authority checkpoint run through their real paths.
  const authorized = await authorizeActionV2(PR2_DELEGATION, PR2_BOUND)
  const previousReadinessEnvironment = new Map(
    Object.keys(PR2_READINESS_ENVIRONMENT).map(key => [key, process.env[key]])
  )
  let stopReadinessReporter: (() => void) | undefined
  try {
    Object.assign(process.env, PR2_READINESS_ENVIRONMENT)
    stopReadinessReporter = startPr2ReadinessReporter(fetchImpl)
    await vi.waitFor(() => expect(readinessHops).toHaveLength(2))
  } finally {
    stopReadinessReporter?.()
    for (const [key, value] of previousReadinessEnvironment) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
  await requestHostWakeFromControlApi(HOST, 'jwt', { authorizedActionV2: authorized })

  const gatewayRequests = fetchMock.mock.calls.map(([url, init]) => ({
    method: String((init as RequestInit | undefined)?.method ?? 'GET'),
    path: new URL(String(url)).pathname,
  }))
  // The readiness reporter posts both of its owned hops to one endpoint: it is
  // one gateway site, so one entry represents it below while readinessHops
  // proves both hops ran. Every request still goes through the matcher.
  const runtimeEvidenceIndexes = gatewayRequests
    .map((request, index) => (request.path === PR2_RUNTIME_EVIDENCE_PATH ? index : -1))
    .filter(index => index >= 0)
  if (runtimeEvidenceIndexes.length !== 2) {
    throw new Error(`expected two PR2 runtime-evidence hops, saw ${runtimeEvidenceIndexes.length}`)
  }
  const requests = gatewayRequests.filter((_request, index) => index !== runtimeEvidenceIndexes[1])
  return { requests, gatewayRequests, readinessHops }
}

describe('control-api-rpc-gateway parity with the rpc-proxy emitter', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('admits every request rpc-proxy sends to control-api', async () => {
    const { requests, gatewayRequests, readinessHops } = await emittedRequests()
    // Liveness witness: every emitter ran and produced its request. The
    // registry lookup appears twice: once called directly and once from the
    // sandbox OAuth authorize-url route, which resolves the app first. The 13
    // dev sites are followed by one entry per PR2 URL site.
    expect(requests).toEqual([
      { method: 'GET', path: `/api/v1/rpc/access/users/${USER}/mcp-servers` },
      { method: 'GET', path: `/api/v1/rpc/access/users/${USER}/mcp-connectors` },
      { method: 'GET', path: `/api/v1/rpc/access/users/${USER}/mcp-hosts/${HOST}` },
      { method: 'POST', path: `/api/v1/rpc/access/users/${USER}/mcp-hosts/${HOST}` },
      { method: 'POST', path: `/api/v1/rpc/hosts/${HOST}/wake` },
      { method: 'GET', path: '/api/v1/internal/sandbox-ui/registry/sandbox-recipes/r1' },
      { method: 'GET', path: '/api/v1/internal/sandbox-ui/apps' },
      { method: 'POST', path: '/api/v1/internal/mcp-oauth/authorize-url' },
      { method: 'DELETE', path: '/api/v1/internal/mcp-oauth/grant' },
      { method: 'GET', path: '/api/v1/internal/sandbox-ui/registry/sandbox-recipes/r1' },
      { method: 'POST', path: '/api/v1/internal/sandbox-ui/oauth/authorize-url' },
      { method: 'POST', path: '/api/v1/internal/sandbox-ui/oauth/token' },
      { method: 'DELETE', path: '/api/v1/internal/sandbox-ui/oauth/grant' },
      { method: 'POST', path: PR2_CHECKPOINT_PATH },
      { method: 'POST', path: PR2_RUNTIME_EVIDENCE_PATH },
      { method: 'POST', path: `/api/v1/internal/action-authority/hosts/${HOST}/wake` },
    ])
    // The readiness reporter reports both of its owned hops; the expected
    // list above carries their shared endpoint once.
    expect([...readinessHops].sort()).toEqual(['oauth_exact_target', 'rpc_proxy_trusted_edge'])
    expect(gatewayRequests).toHaveLength(requests.length + 1)

    const locations = gatewayLocations(gatewayNginxConf())
    const denied = gatewayRequests.filter(r => !gatewayAdmits(locations, r.method, r.path))
    expect(denied).toEqual([])
  })

  it('exercises every control-api URL construction site in rpc-proxy', () => {
    expect(controlApiBaseUrlMentions()).toEqual(CONTROL_API_BASE_URL_MENTIONS)
  })

  it('keeps the default deny for paths and methods rpc-proxy does not emit', () => {
    const locations = gatewayLocations(gatewayNginxConf())
    // Witness that the matcher can deny: these would pass a matcher that
    // admits everything. The parent Host path stays admitted (GET and POST)
    // in the emitter test above. Both methods of the removed sub-paths are
    // denied, so restoring either location block turns this red. Reintroducing
    // a messageResolution emission would request /message-resolution, which
    // selects no location and fails the emitter test.
    const admits = (method: string, path: string): boolean => {
      try {
        return gatewayAdmits(locations, method, path)
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('no gateway location selects ')) {
          return false
        }
        throw error
      }
    }
    expect(admits('GET', `/api/v1/rpc/access/users/${USER}/contexts`)).toBe(false)
    const removed = `/api/v1/rpc/access/users/${USER}/mcp-hosts/${HOST}`
    for (const method of ['GET', 'POST']) {
      expect(admits(method, `${removed}/artifact-read`)).toBe(false)
      expect(admits(method, `${removed}/message-resolution`)).toBe(false)
    }
    expect(gatewayAdmits(locations, 'GET', removed)).toBe(true)
    expect(gatewayAdmits(locations, 'POST', removed)).toBe(true)
    // Method gate on the proxying parent location itself.
    expect(admits('DELETE', removed)).toBe(false)
    expect(admits('GET', `${removed}/other`)).toBe(false)
  })
})
