import { beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { canonicalResourceIdentity, hashActionTarget } from '@clerum/action-context-contracts'
import { createApp } from '../src/app.js'
import { config } from '../src/config.js'
import { MockGateway } from './mockGateway.js'

const effects = vi.hoisted(() => ({
  deleteOAuthGrant: vi.fn(),
  getAccessTokenReactive: vi.fn(),
}))

vi.mock('../src/oauth/store.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/oauth/store.js')>()),
  deleteOAuthGrant: effects.deleteOAuthGrant,
}))
vi.mock('../src/oauth/reactiveTokenHelper.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/oauth/reactiveTokenHelper.js')>()),
  getAccessTokenReactive: effects.getAccessTokenReactive,
}))

const RPC_PROXY_TOKEN = 'dev-rpc-proxy-token'
const AUTHORIZE_URL = '/api/v1/internal/sandbox-ui/oauth/authorize-url'
const TOKEN_URL = '/api/v1/internal/sandbox-ui/oauth/token'
const GRANT_URL = '/api/v1/internal/sandbox-ui/oauth/grant'

function seedRecipe(gateway: MockGateway, name: string, oauthClientId: string): void {
  void gateway.createResource(
    'workflowrecipes',
    {
      metadata: { name },
      spec: {
        oauthClients: [
          {
            id: oauthClientId,
            provider: 'salesforce',
            clientIdRef: { name: `${name}-${oauthClientId}`, key: 'client-id' },
            clientSecretRef: { name: `${name}-${oauthClientId}`, key: 'client-secret' },
          },
        ],
      },
    },
    config.sandboxNamespace
  )
}

function app() {
  const gateway = new MockGateway()
  seedRecipe(gateway, 'crm', 'salesforce-prod')
  seedRecipe(gateway, 'calendar', 'google-calendar')
  return { gateway, instance: createApp(gateway as never) }
}

function body(
  userId: string,
  recipeName = 'crm',
  oauthClientId = 'salesforce-prod'
): Record<string, string> {
  return {
    recipeNs: config.sandboxNamespace,
    recipeName,
    oauthClientId,
    userId,
  }
}

function authorizeUrlBody(
  userId: string,
  recipeName = 'crm',
  oauthClientId = 'salesforce-prod'
): Record<string, string> {
  return {
    ...body(userId, recipeName, oauthClientId),
    redirectUri: `https://desktop.example.test/oauth-callback/${oauthClientId}`,
  }
}

function seedAuthorizeUrlSecret(gateway: MockGateway, recipeName = 'crm'): void {
  gateway.seedSecret(`${recipeName}-salesforce-prod`, config.sandboxNamespace, {
    data: {
      'client-id': Buffer.from('client-id').toString('base64'),
      'client-secret': Buffer.from('client-secret').toString('base64'),
    },
  })
}

function v2ContextHeader(input: {
  operationId: 'sandbox.oauth.vend' | 'sandbox.oauth.disconnect'
  userId: string
  recipeName?: string
  oauthClientId?: string
}): string {
  const recipeName = input.recipeName ?? 'crm'
  const oauthClientId = input.oauthClientId ?? 'salesforce-prod'
  const resource = canonicalResourceIdentity({
    environmentId: 'test',
    type: 'sandbox_app',
    logicalId: `${config.sandboxNamespace}/${recipeName}`,
    displayName: recipeName,
  })
  const target = {
    recipeNamespace: config.sandboxNamespace,
    recipeName,
    oauthClientId,
  }
  return Buffer.from(
    JSON.stringify({
      version: 2,
      userId: input.userId,
      operationId: input.operationId,
      resource,
      target,
      targetHash: hashActionTarget(target),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })
  ).toString('base64url')
}

function internal(requestBuilder: request.Test): request.Test {
  return requestBuilder
    .set('Authorization', `Bearer ${RPC_PROXY_TOKEN}`)
    .set('x-service-token', 'rpc-proxy')
}

describe('Sandbox OAuth binding validation', () => {
  beforeEach(() => {
    effects.deleteOAuthGrant.mockReset()
    effects.deleteOAuthGrant.mockResolvedValue(undefined)
    effects.getAccessTokenReactive.mockReset()
    effects.getAccessTokenReactive.mockResolvedValue({
      kind: 'ok',
      accessToken: 'provider-access-token',
      expiresAt: null,
    })
  })

  it('keeps authentication, body, and exact v2 binding ahead of admission', async () => {
    const { instance } = app()
    await request(instance).post(TOKEN_URL).send(body('user-a')).expect(401)
    await internal(request(instance).post(TOKEN_URL)).send({ userId: 'user-a' }).expect(400)
    await internal(request(instance).post(TOKEN_URL))
      .set(
        'x-clerum-edge-action-context',
        v2ContextHeader({ operationId: 'sandbox.oauth.vend', userId: 'other-user' })
      )
      .send(body('user-a'))
      .expect(400)

    expect(effects.getAccessTokenReactive).not.toHaveBeenCalled()
  })

  it('keeps authorize-url authentication, body, and exact v2 binding ahead of admission', async () => {
    const { gateway, instance } = app()
    seedAuthorizeUrlSecret(gateway)
    const recipeLookups = vi.spyOn(gateway, 'getResource')

    await request(instance).post(AUTHORIZE_URL).send(authorizeUrlBody('user-a')).expect(401)
    await internal(request(instance).post(AUTHORIZE_URL)).send({ userId: 'user-a' }).expect(400)
    await internal(request(instance).post(AUTHORIZE_URL))
      .send({ ...authorizeUrlBody('user-a'), recipeNs: 'other' })
      .expect(400)
    await internal(request(instance).post(AUTHORIZE_URL))
      .set(
        'x-clerum-edge-action-context',
        v2ContextHeader({ operationId: 'sandbox.oauth.vend', userId: 'other-user' })
      )
      .send(authorizeUrlBody('user-a'))
      .expect(400)
    await internal(request(instance).post(AUTHORIZE_URL))
      .send({ ...authorizeUrlBody('user-a'), redirectUri: undefined })
      .expect(400)
    await internal(request(instance).post(AUTHORIZE_URL))
      .send({ ...authorizeUrlBody('user-a'), background: 'yes' })
      .expect(400)

    expect(recipeLookups).not.toHaveBeenCalled()
  })

  it('preserves valid legacy and exact-target v2 token vending', async () => {
    const { instance } = app()
    await internal(request(instance).post(TOKEN_URL)).send(body('legacy-user')).expect(200)
    await internal(request(instance).post(TOKEN_URL))
      .set(
        'x-clerum-edge-action-context',
        v2ContextHeader({ operationId: 'sandbox.oauth.vend', userId: 'v2-user' })
      )
      .send(body('v2-user'))
      .expect(200)
    await internal(request(instance).delete(GRANT_URL))
      .set(
        'x-clerum-edge-action-context',
        v2ContextHeader({ operationId: 'sandbox.oauth.disconnect', userId: 'v2-user' })
      )
      .send(body('v2-user'))
      .expect(204)

    expect(effects.getAccessTokenReactive).toHaveBeenCalledTimes(2)
    expect(effects.deleteOAuthGrant).toHaveBeenCalledOnce()
  })

  it('preserves legacy and exact-target v2 authorize-url resolution', async () => {
    const { gateway, instance } = app()
    seedAuthorizeUrlSecret(gateway)

    await internal(request(instance).post(AUTHORIZE_URL))
      .send(authorizeUrlBody('legacy-user'))
      .expect(200)
    await internal(request(instance).post(AUTHORIZE_URL))
      .set(
        'x-clerum-edge-action-context',
        v2ContextHeader({ operationId: 'sandbox.oauth.vend', userId: 'v2-user' })
      )
      .send(authorizeUrlBody('v2-user'))
      .expect(200)
  })
})
