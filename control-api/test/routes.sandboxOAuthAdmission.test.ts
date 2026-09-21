import { beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { canonicalResourceIdentity, hashActionTarget } from '@clerum/action-context-contracts'
import { createApp } from '../src/app.js'
import { config } from '../src/config.js'
import { MockGateway } from './mockGateway.js'

const effects = vi.hoisted(() => ({
  deleteOAuthGrant: vi.fn(),
  getAccessToken: vi.fn(),
}))
const limiter = vi.hoisted(() => ({
  checkAndIncrement: vi.fn(),
  counts: new Map<string, number>(),
}))

vi.mock('../src/oauth/store.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/oauth/store.js')>()),
  deleteOAuthGrant: effects.deleteOAuthGrant,
}))
vi.mock('../src/oauth/tokenHelper.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/oauth/tokenHelper.js')>()),
  getAccessToken: effects.getAccessToken,
}))
vi.mock('../src/services/rateLimiterService.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/services/rateLimiterService.js')>()),
  checkAndIncrement: limiter.checkAndIncrement,
}))

const RPC_PROXY_TOKEN = 'dev-rpc-proxy-token'
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

function expectCanonicalRateLimitHeaders(response: request.Response): void {
  expect(response.headers['retry-after']).toBe('30')
  expect(response.headers['x-ratelimit-limit']).toBe('10')
  expect(response.headers['x-ratelimit-remaining']).toBe('0')
  expect(Number(response.headers['x-ratelimit-reset'])).toBeGreaterThan(0)
}

describe('Sandbox OAuth distributed admission', () => {
  beforeEach(() => {
    effects.deleteOAuthGrant.mockReset()
    effects.deleteOAuthGrant.mockResolvedValue(undefined)
    effects.getAccessToken.mockReset()
    effects.getAccessToken.mockResolvedValue({
      kind: 'ok',
      accessToken: 'provider-access-token',
      expiresAt: null,
    })
    limiter.counts.clear()
    limiter.checkAndIncrement.mockReset()
    limiter.checkAndIncrement.mockImplementation(async (key: string, max: number) => {
      const count = (limiter.counts.get(key) ?? 0) + 1
      limiter.counts.set(key, count)
      return {
        allowed: count <= max,
        count,
        remaining: Math.max(0, max - count),
        resetMs: Date.now() + 30_000,
      }
    })
  })

  it('denies token request 11 before token vending using one user budget across targets', async () => {
    const { instance } = app()
    for (let requestIndex = 0; requestIndex < 10; requestIndex += 1) {
      const target =
        requestIndex % 2 === 0 ? body('user-a') : body('user-a', 'calendar', 'google-calendar')
      await internal(request(instance).post(TOKEN_URL)).send(target).expect(200)
    }

    const denied = await internal(request(instance).post(TOKEN_URL))
      .send(body('user-a'))
      .expect(429)
    expectCanonicalRateLimitHeaders(denied)
    expect(effects.getAccessToken).toHaveBeenCalledTimes(10)
    expect(limiter.checkAndIncrement).toHaveBeenLastCalledWith(
      'sandbox-oauth-token-vend:user-a',
      10
    )

    await internal(request(instance).post(TOKEN_URL)).send(body('user-b')).expect(200)
    expect(effects.getAccessToken).toHaveBeenCalledTimes(11)
  })

  it('denies disconnect request 11 before recipe lookup and deletion', async () => {
    const { gateway, instance } = app()
    const recipeLookups = vi.spyOn(gateway, 'getResource')
    for (let requestIndex = 0; requestIndex < 10; requestIndex += 1) {
      const target =
        requestIndex % 2 === 0 ? body('user-a') : body('user-a', 'calendar', 'google-calendar')
      await internal(request(instance).delete(GRANT_URL)).send(target).expect(204)
    }

    const denied = await internal(request(instance).delete(GRANT_URL))
      .send(body('user-a'))
      .expect(429)
    expectCanonicalRateLimitHeaders(denied)
    expect(recipeLookups).toHaveBeenCalledTimes(10)
    expect(effects.deleteOAuthGrant).toHaveBeenCalledTimes(10)
    expect(limiter.checkAndIncrement).toHaveBeenLastCalledWith(
      'sandbox-oauth-grant-disconnect:user-a',
      10
    )

    await internal(request(instance).delete(GRANT_URL)).send(body('user-b')).expect(204)
    expect(effects.deleteOAuthGrant).toHaveBeenCalledTimes(11)
  })

  it('keeps token-vend and disconnect budgets independent for the same user', async () => {
    const { instance } = app()
    for (let requestIndex = 0; requestIndex < 10; requestIndex += 1) {
      await internal(request(instance).post(TOKEN_URL)).send(body('user-a')).expect(200)
    }

    await internal(request(instance).delete(GRANT_URL)).send(body('user-a')).expect(204)
    expect(effects.deleteOAuthGrant).toHaveBeenCalledOnce()
    expect(limiter.counts.get('sandbox-oauth-token-vend:user-a')).toBe(10)
    expect(limiter.counts.get('sandbox-oauth-grant-disconnect:user-a')).toBe(1)
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

    expect(limiter.checkAndIncrement).not.toHaveBeenCalled()
    expect(effects.getAccessToken).not.toHaveBeenCalled()
  })

  it('preserves valid legacy and exact-target v2 admission', async () => {
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

    expect(limiter.counts.get('sandbox-oauth-token-vend:legacy-user')).toBe(1)
    expect(limiter.counts.get('sandbox-oauth-token-vend:v2-user')).toBe(1)
    expect(limiter.counts.get('sandbox-oauth-grant-disconnect:v2-user')).toBe(1)
  })
})
