/**
 * Task 7: internal authorize-url accepts + forwards background
 * Follows the harness in routes.internal.oauth.test.ts:
 *   createApp(gateway) + MockGateway + vi.mock('../src/db.js') + x-service-token: rpc-proxy
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../src/app.js'
import { config } from '../src/config.js'
import * as helper from '../src/oauth/authorizeUrlHelper.js'
import { MockGateway } from './mockGateway.js'

const mockPoolQuery = vi.fn()
vi.mock('../src/db.js', () => ({
  pool: {
    query: (...args: unknown[]) => mockPoolQuery(...args),
  },
}))

const RPC_PROXY_TOKEN = 'dev-rpc-proxy-token'

function seedRecipeWithBackgroundOAuth(gateway: MockGateway, opts: { recipeName: string }): void {
  void gateway.createResource(
    'workflowrecipes',
    {
      metadata: { name: opts.recipeName },
      spec: {
        workloads: [{ id: 'api', type: 'deployment', image: 'nginx:alpine' }],
        ui: { workloadRef: 'api', port: 8080 },
        oauthClients: [
          {
            id: 'google-gmail',
            provider: 'google',
            backgroundAccess: true,
            clientIdRef: { name: 'gmail-oauth-secret', key: 'client_id' },
            clientSecretRef: { name: 'gmail-oauth-secret', key: 'client_secret' },
            scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
          },
        ],
      },
    },
    config.sandboxNamespace
  )
}

describe('POST /api/v1/internal/sandbox-ui/oauth/authorize-url background passthrough', () => {
  beforeEach(() => {
    mockPoolQuery.mockReset()
  })

  it('forwards background:true with grantKind user when body has background:true', async () => {
    const gateway = new MockGateway()
    seedRecipeWithBackgroundOAuth(gateway, { recipeName: 'leadforge' })
    // Seed the secret so we get past SecretNotFoundError to buildAuthorizeUrl
    gateway.seedSecret('gmail-oauth-secret', config.sandboxNamespace, {
      data: {
        client_id: Buffer.from('cid').toString('base64'),
        client_secret: Buffer.from('sec').toString('base64'),
      },
    })
    const app = createApp(gateway as never)

    const spy = vi.spyOn(helper, 'buildAuthorizeUrl').mockResolvedValue({
      kind: 'ok',
      authorizeUrl: 'https://accounts.google.com/oauth?...',
    })

    await request(app)
      .post('/api/v1/internal/sandbox-ui/oauth/authorize-url')
      .set('Authorization', `Bearer ${RPC_PROXY_TOKEN}`)
      .set('x-service-token', 'rpc-proxy')
      .send({
        recipeNs: config.sandboxNamespace,
        recipeName: 'leadforge',
        oauthClientId: 'google-gmail',
        userId: 'user-1',
        redirectUri: 'http://localhost:8090/oauth-callback/x/y/z',
        background: true,
      })

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ grantKind: 'user', background: true }),
      expect.anything()
    )

    spy.mockRestore()
  })

  it('defaults background to false when omitted', async () => {
    const gateway = new MockGateway()
    seedRecipeWithBackgroundOAuth(gateway, { recipeName: 'leadforge' })
    const app = createApp(gateway as never)

    const spy = vi.spyOn(helper, 'buildAuthorizeUrl').mockResolvedValue({
      kind: 'ok',
      authorizeUrl: 'https://accounts.google.com/oauth?...',
    })

    await request(app)
      .post('/api/v1/internal/sandbox-ui/oauth/authorize-url')
      .set('Authorization', `Bearer ${RPC_PROXY_TOKEN}`)
      .set('x-service-token', 'rpc-proxy')
      .send({
        recipeNs: config.sandboxNamespace,
        recipeName: 'leadforge',
        oauthClientId: 'google-gmail',
        userId: 'user-1',
        redirectUri: 'http://localhost:8090/oauth-callback/x/y/z',
      })

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ grantKind: 'user', background: false }),
      expect.anything()
    )

    spy.mockRestore()
  })

  it('returns 400 when background is a non-boolean truthy value', async () => {
    const gateway = new MockGateway()
    seedRecipeWithBackgroundOAuth(gateway, { recipeName: 'leadforge' })
    const app = createApp(gateway as never)

    const res = await request(app)
      .post('/api/v1/internal/sandbox-ui/oauth/authorize-url')
      .set('Authorization', `Bearer ${RPC_PROXY_TOKEN}`)
      .set('x-service-token', 'rpc-proxy')
      .send({
        recipeNs: config.sandboxNamespace,
        recipeName: 'leadforge',
        oauthClientId: 'google-gmail',
        userId: 'user-1',
        redirectUri: 'http://localhost:8090/oauth-callback/x/y/z',
        background: 'yes',
      })

    expect(res.status).toBe(400)
  })
})
