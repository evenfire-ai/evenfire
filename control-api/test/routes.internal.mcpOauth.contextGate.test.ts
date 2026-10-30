import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../src/app.js'
import { config } from '../src/config.js'
import { verifyOAuthStateSignature } from '../src/oauth/state.js'
import { membership, seedAgentHost, seedAllowlistedContext } from './fixtures/contextAllowlist.js'
import { captureRequestLogs } from './helpers/requestLogCapture.js'
import { MockGateway } from './mockGateway.js'

/**
 * Error contract and access rule of the `context` branch of the consent mint
 * (`POST /internal/mcp-oauth/authorize-url`) and of the disconnect
 * (`DELETE /internal/mcp-oauth/grant`), plus the `user` branch's tolerance of
 * any `contextId`.
 *
 * A `context` server has no owning Context: the caller names one in the body
 * and the gate admits it only when the Context exists by name in the contexts
 * namespace, is not being deleted, allowlists the server exactly (the mint
 * only), and the user reaches it directly or through an assigned agent's Host.
 * Every one of those denials is the same 403, so the mint cannot be used to map
 * which Contexts exist or what they enable.
 *
 * Contexts go through the real allowlist writer, membership through the
 * user_contexts / user_agents reads on the mocked pool. The McpServer is the
 * shape an install writes once it no longer stamps a Context on the CR.
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
const SHARED = 'shared-drive'
const PERSONAL = 'personal-drive'
const MEMBER = '11111111-1111-4111-8111-111111111111'
const AGENT_USER = '22222222-2222-4222-8222-222222222222'
const STRANGER = '33333333-3333-4333-8333-333333333333'

async function seedServer(
  gateway: MockGateway,
  name: string,
  grantScope: 'user' | 'context',
  extraOauth: Record<string, unknown> = {}
): Promise<void> {
  await gateway.createResource(
    'mcpservers',
    {
      metadata: { name },
      spec: {
        image: 'example/gdrive-mcp:1',
        transport: { type: 'streamableHttp', url: `https://${name}.example.com/mcp` },
        auth: { type: 'oauth' },
        oauth: {
          id: `${name}-client`,
          provider: 'google',
          clientIdRef: { name: 'google-creds', key: 'client-id' },
          clientSecretRef: { name: 'google-creds', key: 'client-secret' },
          scopes: ['https://www.googleapis.com/auth/drive.readonly'],
          grantScope,
          ...extraOauth,
        },
      },
    },
    MCP_NS
  )
}

/** A remote, per-server server whose spec the consent phase refuses (409). */
async function seedIncoherentContextServer(gateway: MockGateway, name: string): Promise<void> {
  await gateway.createResource(
    'mcpservers',
    {
      metadata: { name },
      spec: {
        transport: { type: 'streamableHttp', url: `https://${name}.example.com/mcp` },
        remote: { baseUrl: `https://${name}.example.com/mcp` },
        auth: { type: 'oauth' },
        oauth: {
          id: `${name}-client`,
          source: 'remote',
          clientMode: 'public',
          authorizationEndpoint: 'https://as.example.com/authorize',
          tokenEndpoint: 'https://as.example.com/token',
          issuer: 'https://as.example.com',
          bearerInBody: true,
          grantScope: 'context',
        },
      },
    },
    MCP_NS
  )
}

function mint(app: ReturnType<typeof createApp>, body: Record<string, unknown>) {
  return request(app)
    .post('/api/v1/internal/mcp-oauth/authorize-url')
    .set('Authorization', 'Bearer dev-rpc-proxy-token')
    .set('x-service-token', 'rpc-proxy')
    .send(body)
}

function disconnect(app: ReturnType<typeof createApp>, body: Record<string, unknown>) {
  return request(app)
    .delete('/api/v1/internal/mcp-oauth/grant')
    .set('Authorization', 'Bearer dev-rpc-proxy-token')
    .set('x-service-token', 'rpc-proxy')
    .send(body)
}

function signedContextIdOf(authorizeUrl: string): string | undefined {
  const state = new URL(authorizeUrl).searchParams.get('state') ?? ''
  const verified = verifyOAuthStateSignature(config.oauthStateHmacSecret, state)
  if (verified.kind !== 'ok' || verified.claims.subjectKind !== 'mcp') {
    throw new Error(`unexpected state: ${verified.kind}`)
  }
  return verified.claims.contextId
}

function membershipReads(): unknown[][] {
  return mockPoolQuery.mock.calls.filter(
    ([sql]) =>
      typeof sql === 'string' && (sql.includes('FROM user_contexts') || sql.includes('user_agents'))
  )
}

function grantDeletes(): Array<[string, unknown[]]> {
  return mockPoolQuery.mock.calls.filter(
    ([sql]) => typeof sql === 'string' && sql.includes('DELETE FROM oauth_grants')
  ) as Array<[string, unknown[]]>
}

describe('context-scope consent and disconnect gate', () => {
  let gateway: MockGateway
  let app: ReturnType<typeof createApp>
  const originalContextsNamespace = config.contextsNamespace

  beforeEach(async () => {
    gateway = new MockGateway(MCP_NS)
    app = createApp(gateway as never)
    mockPoolQuery.mockReset()
    gateway.seedSecret('google-creds', MCP_NS, {
      data: {
        'client-id': Buffer.from('GOOGLE_CLIENT_ID').toString('base64'),
        'client-secret': Buffer.from('GOOGLE_CLIENT_SECRET').toString('base64'),
      },
    })
    await seedServer(gateway, SHARED, 'context')
    await seedServer(gateway, PERSONAL, 'user')
    await seedAllowlistedContext(gateway, 'c1', [SHARED, PERSONAL], config.contextsNamespace)
    await seedAllowlistedContext(gateway, 'c2', [], config.contextsNamespace)
    await seedAgentHost(gateway, 'h1', 'c1')
    membership(mockPoolQuery, {
      contexts: { [MEMBER]: ['c1', 'c2'] },
      agents: { [AGENT_USER]: ['h1'] },
    })
  })

  afterEach(() => {
    config.contextsNamespace = originalContextsNamespace
  })

  describe('mint, context branch', () => {
    it.each([
      ['absent', {}],
      ['empty', { contextId: '' }],
    ])('400 context_required when contextId is %s', async (_label, extra) => {
      const res = await mint(app, { mcpServerName: SHARED, userId: MEMBER, ...extra })
      expect(res.status).toBe(400)
      expect(res.body).toEqual({ error: 'context_required' })
      expect(membershipReads()).toHaveLength(0)
    })

    it.each([['Not_A_Name'], [' c1'], ['c1 '], ['a'.repeat(254)]])(
      '400 invalid_request for a contextId that is not a resource name (%j)',
      async contextId => {
        const res = await mint(app, { mcpServerName: SHARED, userId: MEMBER, contextId })
        expect(res.status).toBe(400)
        expect(res.body).toEqual({ error: 'invalid_request' })
        expect(membershipReads()).toHaveLength(0)
      }
    )

    it('400 invalid_request for a non-string contextId', async () => {
      const res = await mint(app, { mcpServerName: SHARED, userId: MEMBER, contextId: 7 })
      expect(res.status).toBe(400)
      expect(res.body).toEqual({ error: 'invalid_request' })
    })

    it('200 for a direct member of an allowlisting Context; the state carries that Context', async () => {
      const res = await mint(app, { mcpServerName: SHARED, userId: MEMBER, contextId: 'c1' })
      expect(res.status).toBe(200)
      expect(signedContextIdOf(res.body.authorizeUrl)).toBe('c1')
    })

    it('200 for a user who reaches the Context only through an assigned agent', async () => {
      const res = await mint(app, { mcpServerName: SHARED, userId: AGENT_USER, contextId: 'c1' })
      expect(res.status).toBe(200)
      expect(signedContextIdOf(res.body.authorizeUrl)).toBe('c1')
    })

    const denials: Array<[string, () => Promise<Record<string, unknown>>]> = [
      ['the Context does not exist', async () => ({ userId: MEMBER, contextId: 'c-missing' })],
      [
        'the Context is being deleted',
        async () => {
          gateway.markDeleting('contexts', 'c1', config.contextsNamespace)
          return { userId: MEMBER, contextId: 'c1' }
        },
      ],
      ['the user does not reach the Context', async () => ({ userId: STRANGER, contextId: 'c1' })],
      [
        'the Context does not allowlist the server',
        async () => ({ userId: MEMBER, contextId: 'c2' }),
      ],
      [
        'the allowlist names the server only with surrounding whitespace',
        async () => {
          await gateway.createResource(
            'contexts',
            { metadata: { name: 'c3' }, spec: { contextId: 'c3', mcpServers: [` ${SHARED} `] } },
            config.contextsNamespace
          )
          membership(mockPoolQuery, { contexts: { [MEMBER]: ['c3'] } })
          return { userId: MEMBER, contextId: 'c3' }
        },
      ],
      [
        'the userId is not a canonical UUID',
        async () => {
          membership(mockPoolQuery, { contexts: { 'user-7': ['c1'] } })
          return { userId: 'user-7', contextId: 'c1' }
        },
      ],
      [
        'the only Context lives outside the configured contexts namespace',
        async () => {
          config.contextsNamespace = 'contexts-elsewhere'
          return { userId: MEMBER, contextId: 'c1' }
        },
      ],
    ]

    it.each(denials)('403 context_membership_denied when %s', async (_label, arrange) => {
      const body = await arrange()
      const res = await mint(app, { mcpServerName: SHARED, ...body })
      expect(res.status).toBe(403)
      expect(res.body).toEqual({ error: 'context_membership_denied' })
      expect(res.body.authorizeUrl).toBeUndefined()
    })

    it('a non-canonical userId never reaches the membership tables', async () => {
      membership(mockPoolQuery, { contexts: { 'user-7': ['c1'] } })
      await mint(app, { mcpServerName: SHARED, userId: 'user-7', contextId: 'c1' })
      expect(membershipReads()).toHaveLength(0)
    })

    it('reads the Context from the configured contexts namespace', async () => {
      config.contextsNamespace = 'contexts-elsewhere'
      await seedAllowlistedContext(gateway, 'c1', [SHARED], 'contexts-elsewhere')
      const res = await mint(app, { mcpServerName: SHARED, userId: MEMBER, contextId: 'c1' })
      expect(res.status).toBe(200)
    })

    it('500 when the Context read fails', async () => {
      gateway.failGetResource('contexts', Object.assign(new Error('boom'), { statusCode: 503 }))
      const res = await mint(app, { mcpServerName: SHARED, userId: MEMBER, contextId: 'c1' })
      expect(res.status).toBe(500)
      expect(res.body.authorizeUrl).toBeUndefined()
    })

    it('500 when the membership read fails', async () => {
      mockPoolQuery.mockRejectedValue(new Error('db down'))
      const res = await mint(app, { mcpServerName: SHARED, userId: MEMBER, contextId: 'c1' })
      expect(res.status).toBe(500)
    })

    it('an incoherent remote server answers 403, not 409, to a caller the gate denies', async () => {
      await seedIncoherentContextServer(gateway, 'remote-shared')
      await seedAllowlistedContext(gateway, 'c4', ['remote-shared'], config.contextsNamespace)
      const res = await mint(app, {
        mcpServerName: 'remote-shared',
        userId: STRANGER,
        contextId: 'c4',
      })
      expect(res.status).toBe(403)
      expect(res.body).toEqual({ error: 'context_membership_denied' })
    })

    it('an incoherent remote server answers 409 to a caller the gate admits', async () => {
      await seedIncoherentContextServer(gateway, 'remote-shared')
      await seedAllowlistedContext(gateway, 'c4', ['remote-shared'], config.contextsNamespace)
      membership(mockPoolQuery, { contexts: { [MEMBER]: ['c4'] } })
      const res = await mint(app, {
        mcpServerName: 'remote-shared',
        userId: MEMBER,
        contextId: 'c4',
      })
      expect(res.status).toBe(409)
      expect(res.body.error).toBe('remote_oauth_spec_incoherent')
    })
  })

  describe('mint, user branch: contextId is type-checked and otherwise ignored', () => {
    it.each([
      ['absent', {}],
      ['an arbitrary Context', { contextId: 'c2' }],
      ['a Context that does not exist', { contextId: 'nowhere' }],
      ['a value that is not a resource name', { contextId: 'Not A Name!' }],
      ['empty', { contextId: '' }],
    ])('200 with contextId %s, and the state carries no Context', async (_label, extra) => {
      const res = await mint(app, { mcpServerName: PERSONAL, userId: MEMBER, ...extra })
      expect(res.status).toBe(200)
      expect(signedContextIdOf(res.body.authorizeUrl)).toBeUndefined()
    })
  })

  describe('disconnect, context branch', () => {
    it.each([
      ['absent', {}],
      ['empty', { contextId: '' }],
    ])('400 context_required when contextId is %s; nothing deleted', async (_label, extra) => {
      const res = await disconnect(app, { mcpServerName: SHARED, userId: MEMBER, ...extra })
      expect(res.status).toBe(400)
      expect(res.body).toEqual({ error: 'context_required' })
      expect(grantDeletes()).toHaveLength(0)
    })

    it('400 invalid_request for a contextId that is not a resource name; nothing deleted', async () => {
      const res = await disconnect(app, {
        mcpServerName: SHARED,
        userId: MEMBER,
        contextId: 'Bad Name',
      })
      expect(res.status).toBe(400)
      expect(res.body).toEqual({ error: 'invalid_request' })
      expect(grantDeletes()).toHaveLength(0)
    })

    it('204 for a member and deletes only the grant of the named Context', async () => {
      const res = await disconnect(app, { mcpServerName: SHARED, userId: MEMBER, contextId: 'c1' })
      expect(res.status).toBe(204)
      const deletes = grantDeletes()
      expect(deletes).toHaveLength(1)
      expect(deletes[0][1]).toContain('c1')
      expect(deletes[0][1]).not.toContain('c2')
    })

    it('204 for a member of a Context that no longer allowlists the server', async () => {
      const res = await disconnect(app, { mcpServerName: SHARED, userId: MEMBER, contextId: 'c2' })
      expect(res.status).toBe(204)
      expect(grantDeletes()).toHaveLength(1)
      expect(grantDeletes()[0][1]).toContain('c2')
    })

    it('204 for a user who reaches the Context only through an assigned agent', async () => {
      const res = await disconnect(app, {
        mcpServerName: SHARED,
        userId: AGENT_USER,
        contextId: 'c1',
      })
      expect(res.status).toBe(204)
      expect(grantDeletes()).toHaveLength(1)
    })

    it.each([
      ['the Context does not exist', MEMBER, 'c-missing'],
      ['the user does not reach the Context', STRANGER, 'c1'],
      ['the userId is not a canonical UUID', 'user-7', 'c1'],
    ])('403 context_membership_denied when %s; nothing deleted', async (_l, userId, contextId) => {
      const res = await disconnect(app, { mcpServerName: SHARED, userId, contextId })
      expect(res.status).toBe(403)
      expect(res.body).toEqual({ error: 'context_membership_denied' })
      expect(grantDeletes()).toHaveLength(0)
    })

    it('403 when the Context is being deleted; nothing deleted', async () => {
      gateway.markDeleting('contexts', 'c1', config.contextsNamespace)
      const res = await disconnect(app, { mcpServerName: SHARED, userId: MEMBER, contextId: 'c1' })
      expect(res.status).toBe(403)
      expect(grantDeletes()).toHaveLength(0)
    })

    it('500 when the Context read fails; nothing deleted', async () => {
      gateway.failGetResource('contexts', Object.assign(new Error('boom'), { statusCode: 503 }))
      const res = await disconnect(app, { mcpServerName: SHARED, userId: MEMBER, contextId: 'c1' })
      expect(res.status).toBe(500)
      expect(grantDeletes()).toHaveLength(0)
    })
  })

  describe('audit events carry contextName only for context grants', () => {
    let logs: ReturnType<typeof captureRequestLogs>
    beforeEach(() => {
      logs = captureRequestLogs()
    })
    afterEach(() => logs.restore())

    const eventOf = (name: string) =>
      logs.info.mock.calls
        .map(call => call[0] as Record<string, unknown>)
        .find(fields => fields?.event === name)

    it('mint of a context server logs contextName', async () => {
      const res = await mint(app, { mcpServerName: SHARED, userId: MEMBER, contextId: 'c1' })
      expect(res.status).toBe(200)
      const event = eventOf('mcp_oauth_authorize_url_minted')
      expect(event).toMatchObject({ grantScope: 'context', contextName: 'c1' })
    })

    it('mint of a user server logs no context, whatever the body sent', async () => {
      const res = await mint(app, { mcpServerName: PERSONAL, userId: MEMBER, contextId: 'c1' })
      expect(res.status).toBe(200)
      const event = eventOf('mcp_oauth_authorize_url_minted')
      expect(event).toBeDefined()
      expect(event).not.toHaveProperty('contextName')
      expect(event).not.toHaveProperty('contextRef')
    })

    it('revoke of a context grant logs contextName and no contextRef', async () => {
      const res = await disconnect(app, { mcpServerName: SHARED, userId: MEMBER, contextId: 'c1' })
      expect(res.status).toBe(204)
      const event = eventOf('mcp_oauth_grant_revoked')
      expect(event).toMatchObject({ grantScope: 'context', contextName: 'c1', userId: MEMBER })
      expect(event).not.toHaveProperty('contextRef')
    })

    it('revoke of a user grant logs no context', async () => {
      const res = await disconnect(app, {
        mcpServerName: PERSONAL,
        userId: MEMBER,
        contextId: 'c1',
      })
      expect(res.status).toBe(204)
      const event = eventOf('mcp_oauth_grant_revoked')
      expect(event).toBeDefined()
      expect(event).not.toHaveProperty('contextName')
      expect(event).not.toHaveProperty('contextRef')
    })
  })
})
