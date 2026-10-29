import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createApp } from '../src/app.js'
import { config } from '../src/config.js'
import { clerumErrorHandler } from '../src/http/errorHandler.js'
import { requireInternalToken } from '../src/middleware/internalServiceAuth.js'
import { verifyOAuthStateSignature } from '../src/oauth/state.js'
import { createExternalRouter } from '../src/routes/external/index.js'
import { createOAuthCallbackRouter } from '../src/routes/external/oauthCallback.js'
import { createRpcAccessRouter } from '../src/routes/rpc-access/index.js'
import { signExternalSessionToken } from '../src/utils/auth/externalSessionAuthToken.js'
import { signRpcAccessToken } from '../src/utils/auth/rpcAuthToken.js'
import {
  membershipResult,
  seedAgentHost,
  seedAllowlistedContext,
} from './fixtures/contextAllowlist.js'
import { MockGateway } from './mockGateway.js'

/**
 * Every route that reads Context allowlists reads them from the configured
 * contexts namespace, which a deployment may set apart from the mcp-servers
 * namespace. Here the two differ and the Contexts exist ONLY in the contexts
 * namespace, so a route wired to the mcp-servers namespace finds no Context and
 * its observable answer changes: the invocable list, the connectors panel, both
 * session catalogs, the per-user consent mint, the context-scope callback and
 * the context-scope grant disconnect.
 *
 * Real middleware and routers; membership, session currency and grants answer
 * from the mocked pool.
 */

const mockPoolQuery = vi.fn()
vi.mock('../src/db.js', async importActual => {
  const actual = await importActual<typeof import('../src/db.js')>()
  return { ...actual, pool: { query: (...args: unknown[]) => mockPoolQuery(...args) } }
})

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
const CONTEXTS_NS = 'contexts-apart'
const USER = '66666666-6666-4666-8666-666666666666'
const TEAM = '77777777-7777-4777-8777-777777777777'
const HOST = 'agent-h1'
const CONTEXT = 'ctx-1'
const PLAIN = 'plain-tools'
const PERSONAL = 'personal-drive'
const SHARED = 'shared-drive'

async function seedServer(
  gateway: MockGateway,
  name: string,
  auth: 'none' | 'user' | 'context'
): Promise<void> {
  await gateway.createResource(
    'mcpservers',
    {
      metadata: { name },
      spec: {
        enabled: true,
        transport: { type: 'streamableHttp', url: `https://${name}.example.com/mcp` },
        ...(auth === 'none'
          ? { auth: { type: 'none' } }
          : {
              auth: { type: 'oauth' },
              oauth: {
                id: `${name}-client`,
                provider: 'google',
                clientIdRef: { name: 'google-creds', key: 'client-id' },
                clientSecretRef: { name: 'google-creds', key: 'client-secret' },
                grantScope: auth,
              },
            }),
      },
    },
    MCP_NS
  )
}

function answerPool(): void {
  mockPoolQuery.mockImplementation((sql: unknown, values: unknown) => {
    const text = typeof sql === 'string' ? sql : ''
    const membership = membershipResult(sql, values, {
      contexts: { [USER]: [CONTEXT] },
      agents: { [USER]: [HOST] },
    })
    if (membership) return Promise.resolve(membership)
    if (text.includes('FROM team_agents')) {
      return Promise.resolve({ rows: [{ agent_name: HOST }], rowCount: 1 })
    }
    if (text.includes('lifecycle_version')) {
      return Promise.resolve({
        rows: [{ lifecycle_state: 'active', lifecycle_version: 1 }],
        rowCount: 1,
      })
    }
    return Promise.resolve({ rows: [], rowCount: 0 })
  })
}

describe('Context allowlists are read from the configured contexts namespace', () => {
  const originalContextsNamespace = config.contextsNamespace
  let gateway: MockGateway

  beforeEach(async () => {
    config.contextsNamespace = CONTEXTS_NS
    gateway = new MockGateway(MCP_NS)
    mockPoolQuery.mockReset()
    answerPool()
    gateway.seedSecret('google-creds', MCP_NS, {
      data: {
        'client-id': Buffer.from('GOOGLE_CLIENT_ID').toString('base64'),
        'client-secret': Buffer.from('GOOGLE_CLIENT_SECRET').toString('base64'),
      },
    })
    await seedServer(gateway, PLAIN, 'none')
    await seedServer(gateway, PERSONAL, 'user')
    await seedServer(gateway, SHARED, 'context')
    await seedAllowlistedContext(gateway, CONTEXT, [PLAIN, PERSONAL, SHARED], CONTEXTS_NS)
    await seedAgentHost(gateway, HOST, CONTEXT)
  })

  afterEach(() => {
    config.contextsNamespace = originalContextsNamespace
  })

  describe('rpc access and session catalogs', () => {
    let app: express.Express
    const internal = (req: request.Test) =>
      req
        .set('authorization', 'Bearer dev-external-rest-api-token')
        .set('x-service-token', 'external-rest-api')
    const rpcToken = signRpcAccessToken({
      sub: USER,
      typ: 'user',
      teamId: TEAM,
      role: 'member',
      scopes: ['mcp:servers:list'],
      hostRefs: [HOST],
      jti: 'rpc-jti-contexts-ns',
    })
    const sessionToken = signExternalSessionToken({
      userId: USER,
      email: 'member@example.test',
      teamId: TEAM,
      role: 'member',
      authGeneration: 1,
    })

    beforeEach(() => {
      app = express()
      app.use(express.json())
      app.use(requireInternalToken)
      app.use(createExternalRouter(gateway as never))
      app.use(createRpcAccessRouter(gateway as never, { bind: vi.fn() }))
    })

    it('invocable list (/mcp-servers) lists the servers of the user Context', async () => {
      const res = await internal(request(app).get(`/rpc/access/users/${USER}/mcp-servers`)).set(
        'x-rpc-access-token',
        rpcToken
      )
      expect(res.status, res.text).toBe(200)
      expect(res.body.servers.map((s: { name: string }) => s.name)).toEqual([PLAIN])
    })

    it('connectors panel (/mcp-connectors) classifies the agent Context allowlist', async () => {
      const res = await internal(request(app).get(`/rpc/access/users/${USER}/mcp-connectors`)).set(
        'x-rpc-access-token',
        rpcToken
      )
      expect(res.status, res.text).toBe(200)
      const names = res.body.agents[0].connectors.map((c: { name: string }) => c.name)
      expect(names).toEqual([PERSONAL, PLAIN, SHARED])
    })

    it('user session catalog lists the tools of the agent Context', async () => {
      const res = await internal(request(app).get(`/external/users/${USER}/agents`)).set(
        'x-user-session-token',
        sessionToken
      )
      expect(res.status, res.text).toBe(200)
      expect(res.body.agents[0].mcpServers.map((s: { name: string }) => s.name)).toEqual([
        PERSONAL,
        PLAIN,
        SHARED,
      ])
    })

    it('team session catalog lists the tools of the agent Context', async () => {
      const res = await internal(request(app).get(`/external/teams/${TEAM}/agents`)).set(
        'x-user-session-token',
        sessionToken
      )
      expect(res.status, res.text).toBe(200)
      expect(res.body.agents[0].mcpServers.map((s: { name: string }) => s.name)).toEqual([
        PERSONAL,
        PLAIN,
        SHARED,
      ])
    })
  })

  it('per-user consent mint admits a user whose Context enables the server', async () => {
    const res = await request(createApp(gateway as never))
      .post('/api/v1/internal/mcp-oauth/authorize-url')
      .set('Authorization', 'Bearer dev-rpc-proxy-token')
      .set('x-service-token', 'rpc-proxy')
      .send({ mcpServerName: PERSONAL, userId: USER })
    expect(res.status, res.text).toBe(200)
  })

  it('context-scope grant disconnect admits a member of the named Context', async () => {
    const res = await request(createApp(gateway as never))
      .delete('/api/v1/internal/mcp-oauth/grant')
      .set('Authorization', 'Bearer dev-rpc-proxy-token')
      .set('x-service-token', 'rpc-proxy')
      .send({ mcpServerName: SHARED, userId: USER, contextId: CONTEXT })
    expect(res.status, res.text).toBe(204)
  })

  describe('consent callback wiring', () => {
    let fetchSpy: ReturnType<typeof vi.spyOn>
    beforeEach(() => {
      fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementation(async () => Response.json({ access_token: 'AT', expires_in: 3600 }))
    })
    afterEach(() => fetchSpy.mockRestore())

    async function stateFromMint(mcpServerName: string, contextId?: string): Promise<string> {
      const res = await request(createApp(gateway as never))
        .post('/api/v1/internal/mcp-oauth/authorize-url')
        .set('Authorization', 'Bearer dev-rpc-proxy-token')
        .set('x-service-token', 'rpc-proxy')
        .send({ mcpServerName, userId: USER, ...(contextId ? { contextId } : {}) })
      if (res.status !== 200) throw new Error(`mint ${res.status} ${res.text}`)
      const state = new URL(res.body.authorizeUrl as string).searchParams.get('state') ?? ''
      expect(verifyOAuthStateSignature(config.oauthStateHmacSecret, state).kind).toBe('ok')
      return state
    }

    async function callback(mcpServerName: string, state: string) {
      const app = express()
      app.use('/api/v1', createOAuthCallbackRouter(gateway as never))
      app.use(clerumErrorHandler)
      return request(app)
        .get(`/api/v1/oauth-callback/${mcpServerName}-client`)
        .query({ code: 'CODE', state })
    }

    it('context-scope callback admits the signed Context and exchanges the code', async () => {
      const state = await stateFromMint(SHARED, CONTEXT)
      const res = await callback(SHARED, state)
      expect(res.status, res.text).toBe(200)
      expect(fetchSpy).toHaveBeenCalledTimes(1)
    })

    it('per-user callback admits a user whose Context enables the server', async () => {
      const state = await stateFromMint(PERSONAL)
      const res = await callback(PERSONAL, state)
      expect(res.status, res.text).toBe(200)
      expect(fetchSpy).toHaveBeenCalledTimes(1)
    })
  })
})
