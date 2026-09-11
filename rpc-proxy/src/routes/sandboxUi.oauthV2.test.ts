import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { randomUUID } from 'node:crypto'
import request from 'supertest'
import {
  type ActionOperationId,
  canonicalResourceIdentity,
  hashActionTarget,
  validateActionOperationTarget,
} from '@clerum/action-context-contracts'
import type { AuthorizedActionV2 } from '../actionAuthorityV2.js'
import { ActionAuthorityCheckpointError } from '../actionAuthorityV2.js'
import type { UserDelegationV2Claims } from '../userDelegationV2.js'
import { createSandboxUiSessionRouter } from './sandboxUi.js'

const auth = vi.hoisted(() => ({
  tokenDeclaresV2: vi.fn((token: string) => token.startsWith('v2.')),
  verifyUserDelegationV2: vi.fn(),
}))
vi.mock('../userDelegationV2.js', () => auth)

const authority = vi.hoisted(() => ({ authorizeActionV2: vi.fn() }))
vi.mock('../actionAuthorityV2.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../actionAuthorityV2.js')>()),
  authorizeActionV2: authority.authorizeActionV2,
}))

const lease = vi.hoisted(() => ({ startActiveViewLease: vi.fn() }))
vi.mock('../services/activeViewLease.js', () => lease)

const proxy = vi.hoisted(() => ({
  on: vi.fn(),
  once: vi.fn(),
  off: vi.fn(),
  web: vi.fn((_req: unknown, res: express.Response) => res.status(200).end()),
}))
vi.mock('http-proxy', () => ({
  default: { createProxyServer: () => proxy },
}))

function delegation(operationId: ActionOperationId): UserDelegationV2Claims {
  const resource = canonicalResourceIdentity({
    environmentId: 'test',
    type: 'sandbox_app',
    logicalId: 'sandbox-recipes/r1',
    displayName: 'r1',
  })
  const target = validateActionOperationTarget({
    operationId,
    resource,
    operationTarget: {
      recipeNamespace: 'sandbox-recipes',
      recipeName: 'r1',
      oauthClientId: 'google-calendar',
    },
  })
  return {
    typ: 'user_delegation',
    ver: 2,
    sub: randomUUID(),
    sid: randomUUID(),
    sv: 1,
    jti: randomUUID(),
    iat: 1,
    exp: Math.floor(Date.now() / 1000) + 300,
    operationIds: [operationId],
    scopes: [`action:${operationId}`],
    resource,
    targets: { [operationId]: target },
    targetHashes: { [operationId]: hashActionTarget(target) },
    accessPathId: `ap1_${'A'.repeat(43)}`,
    authorizationRevision: `ar1_${'B'.repeat(43)}`,
    behaviorBindingHash: `bh2_${'C'.repeat(43)}`,
    pathKind: 'direct',
    effectiveTeamId: null,
  }
}

function viewDelegation(): UserDelegationV2Claims {
  const resource = canonicalResourceIdentity({
    environmentId: 'test',
    type: 'sandbox_app',
    logicalId: 'sandbox-recipes/r1',
    displayName: 'r1',
  })
  const operationId = 'sandbox.reconnect' as const
  const target = validateActionOperationTarget({
    operationId,
    resource,
    operationTarget: { recipeNamespace: 'sandbox-recipes', recipeName: 'r1' },
  })
  return {
    ...delegation('sandbox.oauth.vend'),
    operationIds: [operationId],
    scopes: ['action:sandbox.reconnect'],
    resource,
    targets: { [operationId]: target },
    targetHashes: { [operationId]: hashActionTarget(target) },
  }
}

function app() {
  const instance = express()
  instance.use(express.json())
  instance.use('/api/v1', createSandboxUiSessionRouter())
  return instance
}

describe('Sandbox OAuth v2 authority', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    authority.authorizeActionV2.mockReset()
    auth.verifyUserDelegationV2.mockReset()
    lease.startActiveViewLease.mockReset()
    lease.startActiveViewLease.mockReturnValue({ close: vi.fn() })
    proxy.web.mockClear()
  })

  it('checkpoints exact token authority before broker forwarding', async () => {
    const claims = delegation('sandbox.oauth.vend')
    auth.verifyUserDelegationV2.mockReturnValue(claims)
    authority.authorizeActionV2.mockImplementation(
      async (_claims, bound) =>
        ({
          claims,
          bound,
          checkpoint: { status: 'allowed' },
          trustedEdgeContext: { userId: claims.sub },
          trustedEdgeHeader: 'trusted-v2-context',
        }) as unknown as AuthorizedActionV2
    )
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ accessToken: 'provider-token' }), { status: 200 })
      )

    const response = await request(app())
      .post('/api/v1/sandbox-ui/sandbox-recipes/r1/oauth/token')
      .set('Authorization', 'Bearer v2.token')
      .send({ oauthClientId: 'google-calendar', provider: 'attacker' })
      .expect(200)

    expect(response.body.accessToken).toBe('provider-token')
    expect(authority.authorizeActionV2).toHaveBeenCalledOnce()
    expect(fetchSpy).toHaveBeenCalledOnce()
    const [, init] = fetchSpy.mock.calls[0]
    expect((init?.headers as Record<string, string>)['x-clerum-edge-action-context']).toBe(
      'trusted-v2-context'
    )
    expect(authority.authorizeActionV2.mock.invocationCallOrder[0]).toBeLessThan(
      fetchSpy.mock.invocationCallOrder[0]
    )
  })

  it('does not contact Control API or the broker after checkpoint denial', async () => {
    auth.verifyUserDelegationV2.mockReturnValue(delegation('sandbox.oauth.vend'))
    authority.authorizeActionV2.mockRejectedValue(
      new ActionAuthorityCheckpointError(403, 'forbidden')
    )
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    await request(app())
      .post('/api/v1/sandbox-ui/sandbox-recipes/r1/oauth/token')
      .set('Authorization', 'Bearer v2.token')
      .send({ oauthClientId: 'google-calendar' })
      .expect(403)

    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('does not fall back to a legacy cookie when a v2 credential is malformed', async () => {
    auth.verifyUserDelegationV2.mockReturnValue(null)
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    await request(app())
      .post('/api/v1/sandbox-ui/sandbox-recipes/r1/oauth/token')
      .set('Authorization', 'Bearer v2.malformed')
      .set('Cookie', 'sandbox_ui=fake-legacy-cookie')
      .send({ oauthClientId: 'google-calendar' })
      .expect(401)

    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('mounts the active-view lease before a v2 Sandbox view reaches its upstream', async () => {
    const claims = viewDelegation()
    auth.verifyUserDelegationV2.mockReturnValue(claims)
    authority.authorizeActionV2.mockImplementation(async (_claims, bound) => ({
      claims,
      bound,
      checkpoint: { status: 'allowed' },
      trustedEdgeContext: {},
      trustedEdgeHeader: 'trusted-v2-context',
    }))
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          appRef: 'sandbox-recipes/r1',
          service: { name: 'web', namespace: 'sandbox-ui', port: 8080 },
          ready: true,
          defaultPath: '/',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    )

    await request(app())
      .get('/api/v1/sandbox-ui/sandbox-recipes/r1/view/index.html')
      .set('Authorization', 'Bearer v2.token')
      .expect(200)

    expect(authority.authorizeActionV2).toHaveBeenCalledOnce()
    expect(lease.startActiveViewLease).toHaveBeenCalledOnce()
    expect(proxy.web).toHaveBeenCalledOnce()
    expect(lease.startActiveViewLease.mock.invocationCallOrder[0]).toBeLessThan(
      proxy.web.mock.invocationCallOrder[0]
    )
  })

  it('destroys an active v2 Sandbox response when its mounted lease denies', async () => {
    const claims = viewDelegation()
    auth.verifyUserDelegationV2.mockReturnValue(claims)
    authority.authorizeActionV2.mockImplementation(async (_claims, bound) => ({
      claims,
      bound,
      checkpoint: { status: 'allowed' },
      trustedEdgeContext: {},
      trustedEdgeHeader: 'trusted-v2-context',
    }))
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          appRef: 'sandbox-recipes/r1',
          service: { name: 'web', namespace: 'sandbox-ui', port: 8080 },
          ready: true,
          defaultPath: '/',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    )
    proxy.web.mockImplementationOnce((_req, res) => res)

    const pending = request(app())
      .get('/api/v1/sandbox-ui/sandbox-recipes/r1/view/index.html')
      .set('Authorization', 'Bearer v2.token')
      .then(response => response)
    await vi.waitFor(() => expect(lease.startActiveViewLease).toHaveBeenCalledOnce())
    lease.startActiveViewLease.mock.calls[0]![1].onDenied()

    await expect(pending).rejects.toThrow(/aborted|socket hang up/i)
  })
})
