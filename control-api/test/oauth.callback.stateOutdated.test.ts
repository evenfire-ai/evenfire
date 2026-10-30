import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { config } from '../src/config.js'
import { clerumErrorHandler } from '../src/http/errorHandler.js'
import { signOAuthState } from '../src/oauth/state.js'
import { createOAuthCallbackRouter } from '../src/routes/external/oauthCallback.js'
import { membership, seedAllowlistedContext } from './fixtures/contextAllowlist.js'
import { MockGateway } from './mockGateway.js'

/**
 * A consent for a `context` server started before the state carried its
 * Context cannot say which Context the grant is for. The callback refuses it
 * with `oauth_state_outdated` before spending the single-use code at the
 * provider and before touching any table, even when the signed user would
 * pass every access check.
 *
 * The state comes from the real signer without the field, which is exactly
 * what the previous minter emitted. Production callback wiring, mocked pool.
 */

const mockPoolQuery = vi.fn()
vi.mock('../src/db.js', () => ({
  pool: { query: (...args: unknown[]) => mockPoolQuery(...args) },
}))

const MCP_NS = config.mcpServersNamespace
const SERVER = 'shared-drive'
const CLIENT = 'shared-drive-client'
const MEMBER = '11111111-1111-4111-8111-111111111111'

describe('GET /api/v1/oauth-callback/:id — state without contextId for a context server', () => {
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
      .mockImplementation(async () => Response.json({ access_token: 'AT', expires_in: 3600 }))
    await gateway.createResource(
      'mcpservers',
      {
        metadata: { name: SERVER },
        spec: {
          transport: { type: 'streamableHttp', url: 'https://shared.example.com/mcp' },
          auth: { type: 'oauth' },
          oauth: {
            id: CLIENT,
            provider: 'google',
            clientIdRef: { name: 'google-creds', key: 'client-id' },
            clientSecretRef: { name: 'google-creds', key: 'client-secret' },
            grantScope: 'context',
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
    await seedAllowlistedContext(gateway, 'c1', [SERVER], config.contextsNamespace)
    membership(mockPoolQuery, { contexts: { [MEMBER]: ['c1'] } })
  })

  afterEach(() => {
    fetchSpy.mockRestore()
  })

  it('400 oauth_state_outdated, no provider exchange and no database access', async () => {
    const legacyState = signOAuthState(config.oauthStateHmacSecret, {
      subjectKind: 'mcp',
      mcpServerName: SERVER,
      userId: MEMBER,
      oauthClientId: CLIENT,
      grantKind: 'user',
      background: false,
    })

    const res = await request(app)
      .get(`/api/v1/oauth-callback/${CLIENT}`)
      .query({ code: 'CODE', state: legacyState })

    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'oauth_state_outdated' })
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(mockPoolQuery).not.toHaveBeenCalled()
  })
})
