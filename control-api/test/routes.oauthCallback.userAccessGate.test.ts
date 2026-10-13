import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { config } from '../src/config.js'
import { clerumErrorHandler } from '../src/http/errorHandler.js'
import { signOAuthState } from '../src/oauth/state.js'
import { createOAuthCallbackRouter } from '../src/routes/external/oauthCallback.js'
import { editContextAllowlist } from '../src/services/contextAllowlist.js'
import { membership, seedAgentHost, seedAllowlistedContext } from './fixtures/contextAllowlist.js'
import { MockGateway } from './mockGateway.js'

/**
 * The per-user (`grantScope: user`) consent callback re-checks access through the
 * PRODUCTION wiring of `userServerAccessReader` in `createOAuthCallbackRouter`:
 * some Context the signed user reaches — directly or through an assigned
 * agent's Host — must allowlist the server. The server's own `spec.contextRef`
 * is deliberately a Context the user is NOT a member of, so only the allowlist
 * rule can decide the outcome.
 *
 * Contexts are written through the real allowlist writer, membership is the
 * `user_contexts` / `user_agents` reads on the mocked pool (the same stand-in
 * the sibling suites use), Host CRs are hand-written, and the state is signed
 * by the real signer. The provider token endpoint is the only network edge:
 * `globalThis.fetch`, which the route wires as its baked-lane transport.
 */

const mockPoolQuery = vi.fn()
vi.mock('../src/db.js', () => ({
  pool: { query: (...args: unknown[]) => mockPoolQuery(...args) },
}))

const MCP_NS = config.mcpServersNamespace
const SERVER = 'gdrive'
const OAUTH_CLIENT_ID = 'google-drive'
const OWNER_CONTEXT = 'ctx-owner'
const USER_ID = 'user-7'

async function seedUserScopedOauthServer(gateway: MockGateway): Promise<void> {
  await gateway.createResource(
    'mcpservers',
    {
      metadata: { name: SERVER },
      spec: {
        contextRef: OWNER_CONTEXT,
        image: 'example/gdrive-mcp:1',
        transport: { type: 'streamableHttp', url: 'https://gdrive.example.com/mcp' },
        auth: { type: 'oauth' },
        oauth: {
          id: OAUTH_CLIENT_ID,
          provider: 'google',
          clientIdRef: { name: 'google-creds', key: 'client-id' },
          clientSecretRef: { name: 'google-creds', key: 'client-secret' },
          scopes: ['https://www.googleapis.com/auth/drive.readonly'],
          grantScope: 'user',
        },
      },
    },
    MCP_NS
  )
  gateway.seedSecret('google-creds', MCP_NS, {
    data: {
      'client-id': Buffer.from('GOOGLE_CLIENT_ID').toString('base64'),
      'client-secret': Buffer.from('GOOGLE_CLIENT_SECRET').toString('base64'),
    },
  })
}

function signedState(): string {
  return signOAuthState(config.oauthStateHmacSecret, {
    subjectKind: 'mcp',
    mcpServerName: SERVER,
    userId: USER_ID,
    oauthClientId: OAUTH_CLIENT_ID,
    grantKind: 'user',
    background: false,
  })
}

function grantWrites(): unknown[][] {
  return mockPoolQuery.mock.calls.filter(
    ([sql]) => typeof sql === 'string' && sql.includes('oauth_grants')
  )
}

describe('GET /api/v1/oauth-callback/:oauthClientId — per-user access re-check (production wiring)', () => {
  let gateway: MockGateway
  let app: express.Express
  let fetchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    gateway = new MockGateway(MCP_NS)
    app = express()
    app.use('/api/v1', createOAuthCallbackRouter(gateway as never))
    app.use(clerumErrorHandler)
    mockPoolQuery.mockReset()
    fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () =>
        Response.json({ access_token: 'AT', refresh_token: 'RT', expires_in: 3600 })
      )
    await seedUserScopedOauthServer(gateway)
    // The server's own Context allowlists it — the user is never a member of it.
    await seedAllowlistedContext(gateway, OWNER_CONTEXT, [SERVER])
  })

  afterEach(() => {
    fetchSpy.mockRestore()
  })

  function callback() {
    return request(app)
      .get(`/api/v1/oauth-callback/${OAUTH_CLIENT_ID}`)
      .query({ code: 'CODE', state: signedState() })
  }

  it('403 context_membership_denied when no Context of the user enables the server; no exchange, no grant', async () => {
    await seedAllowlistedContext(gateway, 'ctx-mine', ['some-other-server'])
    membership(mockPoolQuery, { contexts: { [USER_ID]: ['ctx-mine'] } })

    const res = await callback()

    expect(res.status).toBe(403)
    expect(res.body).toEqual({ error: 'context_membership_denied' })
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(grantWrites()).toHaveLength(0)
  })

  it('403 when the signed user is not a member but another user is; no exchange, no grant', async () => {
    await seedAllowlistedContext(gateway, 'ctx-business', [SERVER])
    membership(mockPoolQuery, { contexts: { 'someone-else': ['ctx-business'] } })

    const res = await callback()

    expect(res.status).toBe(403)
    expect(res.body).toEqual({ error: 'context_membership_denied' })
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(grantWrites()).toHaveLength(0)
  })

  it('200 when a Context of the user enables the server, though not its contextRef; exchanges and writes the user grant', async () => {
    await seedAllowlistedContext(gateway, 'ctx-business', [SERVER])
    membership(mockPoolQuery, { contexts: { [USER_ID]: ['ctx-business'] } })

    const res = await callback()

    expect(res.status).toBe(200)
    expect(res.text).toContain('source=mcp')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(String(fetchSpy.mock.calls[0][0])).toBe('https://oauth2.googleapis.com/token')
    const writes = grantWrites()
    expect(writes).toHaveLength(1)
    const [sql, params] = writes[0] as [string, unknown[]]
    expect(sql).toContain('INSERT INTO oauth_grants')
    expect(params.slice(0, 5)).toEqual(['mcpserver', MCP_NS, SERVER, USER_ID, OAUTH_CLIENT_ID])
  })

  it('200 when the user reaches an allowlisting Context only through an assigned agent; exchanges and writes the user grant', async () => {
    await seedAllowlistedContext(gateway, 'ctx-c', [SERVER])
    await seedAgentHost(gateway, 'host-c', 'ctx-c')
    membership(mockPoolQuery, {
      contexts: { [USER_ID]: [OWNER_CONTEXT] },
      agents: { [USER_ID]: ['host-c'] },
    })
    // The owner Context no longer allowlists the server.
    await editContextAllowlist(
      gateway as never,
      { name: OWNER_CONTEXT, namespace: MCP_NS },
      servers => servers.filter(name => name !== SERVER)
    )

    const res = await callback()

    expect(res.status).toBe(200)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const writes = grantWrites()
    expect(writes).toHaveLength(1)
    const [sql, params] = writes[0] as [string, unknown[]]
    expect(sql).toContain('INSERT INTO oauth_grants')
    expect(params.slice(0, 5)).toEqual(['mcpserver', MCP_NS, SERVER, USER_ID, OAUTH_CLIENT_ID])
  })

  it('500 when listing Contexts fails; no exchange, no grant', async () => {
    membership(mockPoolQuery, { contexts: { [USER_ID]: ['ctx-business'] } })
    const realList = gateway.listResource.bind(gateway)
    vi.spyOn(gateway, 'listResource').mockImplementation((plural, ns) =>
      plural === 'contexts'
        ? Promise.reject(Object.assign(new Error('apiserver unavailable'), { statusCode: 503 }))
        : realList(plural, ns)
    )

    const res = await callback()

    expect(res.status).toBe(500)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(grantWrites()).toHaveLength(0)
  })

  it('500 when an assigned agent Host read fails and no direct Context enables the server; no exchange, no grant', async () => {
    await seedAllowlistedContext(gateway, 'ctx-c', [SERVER])
    await seedAgentHost(gateway, 'host-c', 'ctx-c')
    membership(mockPoolQuery, { agents: { [USER_ID]: ['host-c'] } })
    const realGet = gateway.getResource.bind(gateway)
    vi.spyOn(gateway, 'getResource').mockImplementation((plural, name, ns) =>
      plural === 'hosts'
        ? Promise.reject(Object.assign(new Error('apiserver unavailable'), { statusCode: 503 }))
        : realGet(plural, name, ns)
    )

    const res = await callback()

    expect(res.status).toBe(500)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(grantWrites()).toHaveLength(0)
  })
})
