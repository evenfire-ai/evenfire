import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../src/app.js'
import { config } from '../src/config.js'
import { discoverRemoteOAuth } from '../src/oauth/discovery.js'
import { buildRemoteOAuthSpec } from '../src/routes/admin/remoteMcp.js'
import { attachServerToContext } from '../src/services/contextAllowlist.js'
import { membership, seedAgentHost, seedAllowlistedContext } from './fixtures/contextAllowlist.js'
import { mintHccControlToken } from './fixtures/hccControlToken.js'
import { PILOTS, makeDiscoveryTransport } from './fixtures/remoteOAuthDiscovery.js'
import { MockGateway } from './mockGateway.js'

/**
 * P-I5: seen from a Host, "does not exist", "outside my Context's allowlist",
 * "being deleted" and "disabled" are indistinguishable: same status, same
 * bytes, and no grant or Secret is read. (A server has no owning Context: one
 * enabled in another Context as well is simply outside or inside this Host's
 * allowlist.) The server's shape (OAuth, incoherent remote spec, not OAuth,
 * unsupported provider) must not leak through either, which pins the
 * allowlist/state checks before the OAuth and coherence checks.
 */

const mockPoolQuery = vi.fn()
vi.mock('../src/db.js', () => ({
  pool: { query: (...args: unknown[]) => mockPoolQuery(...args) },
}))
vi.mock('../src/services/rateLimiterService.js', () => ({
  checkAndIncrement: vi.fn().mockResolvedValue({
    allowed: true,
    backendAvailable: true,
    remaining: 59,
    resetMs: Date.now() + 60_000,
    windowStartMs: Date.now(),
    count: 1,
  }),
}))

const MCP_NS = config.mcpServersNamespace
const HOST = 'agent-host'
const HOST_CONTEXT = 'ctx-host'
const OTHER_CONTEXT = 'ctx-other'
const SERVER = 'probe'
const USER = '5e1d7a3c-9b2f-4c8e-a6d0-3f7b1e9c2a58'

type State = 'missing' | 'outside_allowlist' | 'deleting' | 'disabled'
type Shape = 'oauth' | 'remote_incoherent' | 'not_oauth' | 'unsupported_provider'

let remoteIncoherent: (grantScope: 'user' | 'context') => Record<string, unknown>

beforeAll(async () => {
  const outcome = await discoverRemoteOAuth(PILOTS.sentry.mcpUrl, {
    transport: makeDiscoveryTransport(PILOTS.sentry),
    resolveDns: async () => ['93.184.216.34'],
  })
  if (!outcome.ok) throw new Error(`fixture discovery failed: ${outcome.error.kind}`)
  // The builder's confidential output with clientMode flipped to public: the
  // in-place edit a direct write would make, which the CRD now rejects.
  remoteIncoherent = grantScope => ({
    ...(buildRemoteOAuthSpec(outcome.result, {
      clientMode: 'confidential',
      grantScope,
      clientSecretName: 'probe-oauth-client',
      preRegisteredClientId: 'client-abc',
    }) as unknown as Record<string, unknown>),
    clientMode: 'public',
  })
})

function serverSpec(shape: Shape, grantScope: 'user' | 'context'): Record<string, unknown> {
  const base = {}
  if (shape === 'not_oauth') return { ...base, auth: { type: 'none' } }
  if (shape === 'remote_incoherent') {
    return { ...base, auth: { type: 'oauth' }, oauth: remoteIncoherent(grantScope) }
  }
  return {
    ...base,
    auth: { type: 'oauth' },
    oauth: {
      id: 'probe-client',
      provider: shape === 'unsupported_provider' ? 'no-such-provider' : 'google',
      clientIdRef: { name: 'probe-creds', key: 'client-id' },
      clientSecretRef: { name: 'probe-creds', key: 'client-secret' },
      grantScope,
    },
  }
}

interface Case {
  state: State
  shape: Shape
  grantScope: 'user' | 'context'
  withUserId: boolean
  withContextId: boolean
}

// The full cartesian product (128 cases) instead of a random sample, so an
// ordering regression is caught on every run rather than only on a lucky seed.
const BOOLS = [false, true] as const
function enumerate(states: State[], shapes: Shape[], scopes: Array<'user' | 'context'>): Case[] {
  return states.flatMap(state =>
    shapes.flatMap(shape =>
      scopes.flatMap(grantScope =>
        BOOLS.flatMap(withUserId =>
          BOOLS.map(withContextId => ({ state, shape, grantScope, withUserId, withContextId }))
        )
      )
    )
  )
}
const CASES: Case[] = [
  ...enumerate(
    ['missing', 'outside_allowlist', 'deleting', 'disabled'],
    ['oauth', 'remote_incoherent', 'not_oauth', 'unsupported_provider'],
    ['user', 'context']
  ),
]

describe('P-I5: uniform server_not_found across the Context boundary', () => {
  const originalBrokerEnabled = config.mcpOauthBrokerEnabled

  beforeEach(() => {
    config.mcpOauthBrokerEnabled = true
  })

  afterEach(() => {
    config.mcpOauthBrokerEnabled = originalBrokerEnabled
  })

  it('every hidden state answers 404 {"error":"server_not_found"} without reading grants or Secrets', async () => {
    expect(CASES).toHaveLength(128)
    for (const c of CASES) {
      mockPoolQuery.mockReset()
      membership(mockPoolQuery, { agents: { [USER]: [HOST] } })
      const gateway = new MockGateway(MCP_NS)
      const app = createApp(gateway as never)
      await seedAgentHost(gateway, HOST, HOST_CONTEXT)
      await seedAllowlistedContext(gateway, HOST_CONTEXT, [], config.contextsNamespace)
      await seedAllowlistedContext(gateway, OTHER_CONTEXT, [SERVER], config.contextsNamespace)
      const token = await mintHccControlToken(app, gateway, HOST)

      if (c.state !== 'missing') {
        const spec = serverSpec(c.shape, c.grantScope)
        if (c.state === 'disabled') spec.enabled = false
        await gateway.createResource('mcpservers', { metadata: { name: SERVER }, spec }, MCP_NS)
        if (c.state === 'deleting') gateway.markDeleting('mcpservers', SERVER, MCP_NS)
      }
      if (c.state !== 'outside_allowlist') {
        await attachServerToContext(
          gateway as never,
          { name: HOST_CONTEXT, namespace: config.contextsNamespace },
          SERVER
        )
      }
      const secretReads = vi.spyOn(gateway, 'getSecret')

      const res = await request(app)
        .post('/api/v1/mcp-oauth/user-token')
        .set('Authorization', `Bearer ${token}`)
        .send({
          mcpServerName: SERVER,
          ...(c.withUserId ? { userId: USER } : {}),
          ...(c.withContextId ? { contextId: HOST_CONTEXT } : {}),
        })

      const label = JSON.stringify(c)
      expect(res.status, label).toBe(404)
      expect(res.text, label).toBe('{"error":"server_not_found"}')
      const grantReads = mockPoolQuery.mock.calls.filter(
        ([sql]) => typeof sql === 'string' && sql.includes('oauth_grants')
      )
      expect(grantReads, label).toHaveLength(0)
      expect(secretReads, label).not.toHaveBeenCalled()
    }
  })
})
