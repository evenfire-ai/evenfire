import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { config } from '../src/config.js'
import type { K8sGateway } from '../src/k8s.js'
import type { RpcAccessClaims } from '../src/profileTypes.js'
import { createRpcAccessHostsRouter } from '../src/routes/rpc-access/hosts.js'
import { K8sNotFoundError } from '../src/services/resourceService.js'

/**
 * HTTP-level tests for POST /rpc/hosts/:hostRef/wake (Stage 4.1).
 *
 * The REAL rpcAccessAuth middleware chain runs (only the token verifier is
 * mocked) so the authorization-before-mutation ordering is exercised end to
 * end: a token whose hostRefs do not include :hostRef must be rejected with
 * ZERO side effects — no rate-limit consumption, no generation bump, no K8s
 * annotation patch.
 */

const authMock = vi.hoisted(() => ({
  verifyRpcAccessToken: vi.fn(),
}))
vi.mock('../src/utils/auth/rpcAuthToken.js', () => authMock)

const wakeSvcMock = vi.hoisted(() => ({
  bumpWakeGeneration: vi.fn(),
}))
vi.mock('../src/services/hostWakeService.js', () => wakeSvcMock)

const rateLimiterMock = vi.hoisted(() => ({
  checkAndIncrement: vi.fn(),
}))
vi.mock('../src/services/rateLimiterService.js', () => rateLimiterMock)

const HOST_REF = 'chatllm'

function makeClaims(overrides: Partial<RpcAccessClaims> = {}): RpcAccessClaims {
  return {
    sub: 'user-1',
    typ: 'user',
    accessScope: 'user',
    teamId: null,
    scopes: ['host:wake:write'],
    hostRefs: [HOST_REF],
    jti: 'jti-1',
    iat: 0,
    exp: 4102444800,
    ...overrides,
  }
}

function statelessHost(state?: string): Record<string, unknown> {
  return {
    metadata: { name: HOST_REF, namespace: config.hostsNamespace },
    spec: { lifecycle: { stateless: true } },
    ...(state !== undefined ? { status: { lifecycle: { state } } } : {}),
  }
}

describe('POST /rpc/hosts/:hostRef/wake', () => {
  const gateway = {
    getResource: vi.fn(),
    patchAnnotationMonotonic: vi.fn(),
  }

  const app = express()
  app.use(express.json())
  app.use(createRpcAccessHostsRouter(gateway as unknown as K8sGateway))

  function wake(hostRef = HOST_REF) {
    return request(app).post(`/rpc/hosts/${hostRef}/wake`).set('x-rpc-access-token', 'token')
  }

  beforeEach(() => {
    authMock.verifyRpcAccessToken.mockReset()
    wakeSvcMock.bumpWakeGeneration.mockReset()
    rateLimiterMock.checkAndIncrement.mockReset()
    gateway.getResource.mockReset()
    gateway.patchAnnotationMonotonic.mockReset()

    authMock.verifyRpcAccessToken.mockReturnValue(makeClaims())
    rateLimiterMock.checkAndIncrement.mockResolvedValue({
      allowed: true,
      remaining: 9,
      resetMs: Date.now() + 60_000,
      windowStartMs: 0,
      count: 1,
    })
    gateway.patchAnnotationMonotonic.mockResolvedValue({})
  })

  describe('authorization strictly before any mutation', () => {
    it('rejects a token whose hostRefs do not include :hostRef with zero side effects', async () => {
      authMock.verifyRpcAccessToken.mockReturnValue(makeClaims({ hostRefs: ['other-host'] }))

      const res = await wake()

      expect(res.status).toBe(403)
      expect(gateway.getResource).not.toHaveBeenCalled()
      expect(gateway.patchAnnotationMonotonic).not.toHaveBeenCalled()
      expect(wakeSvcMock.bumpWakeGeneration).not.toHaveBeenCalled()
      // Authz runs BEFORE the rate limiter: forbidden callers must not even
      // consume rate-limit budget for the target host.
      expect(rateLimiterMock.checkAndIncrement).not.toHaveBeenCalled()
    })

    it('rejects a missing token with 401 and zero side effects', async () => {
      const res = await request(app).post(`/rpc/hosts/${HOST_REF}/wake`)

      expect(res.status).toBe(401)
      expect(gateway.patchAnnotationMonotonic).not.toHaveBeenCalled()
      expect(wakeSvcMock.bumpWakeGeneration).not.toHaveBeenCalled()
      expect(rateLimiterMock.checkAndIncrement).not.toHaveBeenCalled()
    })

    it('rejects a token without any accepted host scope with 403 and zero side effects', async () => {
      authMock.verifyRpcAccessToken.mockReturnValue(makeClaims({ scopes: ['mcp:servers:list'] }))

      const res = await wake()

      expect(res.status).toBe(403)
      expect(wakeSvcMock.bumpWakeGeneration).not.toHaveBeenCalled()
      expect(gateway.patchAnnotationMonotonic).not.toHaveBeenCalled()
    })
  })

  describe('rate limiting', () => {
    it('returns 429 with Retry-After when over the per-host limit, with no mutation', async () => {
      rateLimiterMock.checkAndIncrement.mockResolvedValue({
        allowed: false,
        remaining: 0,
        resetMs: Date.now() + 30_000,
        windowStartMs: 0,
        count: 11,
      })

      const res = await wake()

      expect(res.status).toBe(429)
      expect(res.headers['retry-after']).toBeDefined()
      expect(gateway.getResource).not.toHaveBeenCalled()
      expect(gateway.patchAnnotationMonotonic).not.toHaveBeenCalled()
      expect(wakeSvcMock.bumpWakeGeneration).not.toHaveBeenCalled()
    })

    it('keys the bucket by hostRef with the configured per-minute limit', async () => {
      gateway.getResource.mockResolvedValue(statelessHost('active'))

      await wake()

      expect(rateLimiterMock.checkAndIncrement).toHaveBeenCalledWith(
        `host-wake:${HOST_REF}`,
        config.hostWakeRlPerMin
      )
    })
  })

  describe('response contract', () => {
    it('returns 404 {status:unknown} when the Host CR is absent, without bumping', async () => {
      gateway.getResource.mockRejectedValue(new K8sNotFoundError('hosts/chatllm not found'))

      const res = await wake()

      expect(res.status).toBe(404)
      expect(res.body).toEqual({ status: 'unknown' })
      expect(wakeSvcMock.bumpWakeGeneration).not.toHaveBeenCalled()
      expect(gateway.patchAnnotationMonotonic).not.toHaveBeenCalled()
    })

    it('returns 409 {status:not-stateless} when spec.lifecycle.stateless !== true, without bumping', async () => {
      gateway.getResource.mockResolvedValue({
        metadata: { name: HOST_REF },
        spec: { lifecycle: { stateless: false } },
        status: { lifecycle: { state: 'suspended' } },
      })

      const res = await wake()

      expect(res.status).toBe(409)
      expect(res.body).toEqual({ status: 'not-stateless' })
      expect(wakeSvcMock.bumpWakeGeneration).not.toHaveBeenCalled()
      expect(gateway.patchAnnotationMonotonic).not.toHaveBeenCalled()
    })

    it('returns 200 {status:active} for a running host without bumping or patching', async () => {
      gateway.getResource.mockResolvedValue(statelessHost('active'))

      const res = await wake()

      expect(res.status).toBe(200)
      expect(res.body).toEqual({ status: 'active' })
      expect(wakeSvcMock.bumpWakeGeneration).not.toHaveBeenCalled()
      expect(gateway.patchAnnotationMonotonic).not.toHaveBeenCalled()
    })

    it('returns 200 {status:active} when status.lifecycle is absent, without bumping', async () => {
      gateway.getResource.mockResolvedValue(statelessHost())

      const res = await wake()

      expect(res.status).toBe(200)
      expect(res.body).toEqual({ status: 'active' })
      expect(wakeSvcMock.bumpWakeGeneration).not.toHaveBeenCalled()
    })

    it('returns 200 {status:active, wakeGeneration} for a draining host AND still bumps + projects', async () => {
      gateway.getResource.mockResolvedValue(statelessHost('draining'))
      wakeSvcMock.bumpWakeGeneration.mockResolvedValue({ generation: 7, shouldProject: true })

      const res = await wake()

      expect(res.status).toBe(200)
      expect(res.body).toEqual({ status: 'active', wakeGeneration: 7 })
      expect(wakeSvcMock.bumpWakeGeneration).toHaveBeenCalledWith(
        HOST_REF,
        config.hostWakeCoalesceWindowMs
      )
      expect(gateway.patchAnnotationMonotonic).toHaveBeenCalledWith(
        'hosts',
        HOST_REF,
        'clerum.io/wake-requested',
        7,
        config.hostsNamespace
      )
    })

    it('returns 202 {status:wake-requested, wakeGeneration} for a suspended host', async () => {
      gateway.getResource.mockResolvedValue(statelessHost('suspended'))
      wakeSvcMock.bumpWakeGeneration.mockResolvedValue({ generation: 3, shouldProject: true })

      const res = await wake()

      expect(res.status).toBe(202)
      expect(res.body).toEqual({ status: 'wake-requested', wakeGeneration: 3 })
      expect(gateway.patchAnnotationMonotonic).toHaveBeenCalledWith(
        'hosts',
        HOST_REF,
        'clerum.io/wake-requested',
        3,
        config.hostsNamespace
      )
    })

    it('fails loud (500) when the annotation patch fails — no silent success', async () => {
      gateway.getResource.mockResolvedValue(statelessHost('suspended'))
      wakeSvcMock.bumpWakeGeneration.mockResolvedValue({ generation: 9, shouldProject: true })
      gateway.patchAnnotationMonotonic.mockRejectedValue(new Error('k8s api unavailable'))

      const res = await wake()

      expect(res.status).toBe(500)
    })

    it('returns 404 {status:unknown} when the Host is deleted between the read and the projection patch', async () => {
      gateway.getResource.mockResolvedValue(statelessHost('suspended'))
      wakeSvcMock.bumpWakeGeneration.mockResolvedValue({ generation: 4, shouldProject: true })
      gateway.patchAnnotationMonotonic.mockRejectedValue(
        new K8sNotFoundError('hosts/chatllm not found in namespace mcp-host')
      )

      const res = await wake()

      // Same contract row as the read path: absent Host CR -> 404 unknown.
      expect(res.status).toBe(404)
      expect(res.body).toEqual({ status: 'unknown' })
    })
  })

  describe('server-side coalescence', () => {
    it('N rapid wakes produce exactly 1 annotation patch while every caller gets a valid response', async () => {
      gateway.getResource.mockResolvedValue(statelessHost('suspended'))
      wakeSvcMock.bumpWakeGeneration
        .mockResolvedValueOnce({ generation: 1, shouldProject: true })
        .mockResolvedValueOnce({ generation: 2, shouldProject: false })
        .mockResolvedValueOnce({ generation: 3, shouldProject: false })

      const responses = [await wake(), await wake(), await wake()]

      for (const [index, res] of responses.entries()) {
        expect(res.status).toBe(202)
        expect(res.body).toEqual({ status: 'wake-requested', wakeGeneration: index + 1 })
      }
      expect(gateway.patchAnnotationMonotonic).toHaveBeenCalledTimes(1)
      expect(gateway.patchAnnotationMonotonic).toHaveBeenCalledWith(
        'hosts',
        HOST_REF,
        'clerum.io/wake-requested',
        1,
        config.hostsNamespace
      )
    })

    it('coalesced wakes still consume rate-limit budget (limiter runs before the coalescer)', async () => {
      // Middleware order in the router is limiter BEFORE handler; the
      // coalescer inside the handler only suppresses redundant annotation
      // patches. The hostWakeRlPerMin budget therefore has to cover RAW
      // calls — this is the assumption the derivation comment in
      // src/config.ts (guarded by config.hostWakeRateLimit.test.ts) counts
      // with.
      gateway.getResource.mockResolvedValue(statelessHost('suspended'))
      wakeSvcMock.bumpWakeGeneration
        .mockResolvedValueOnce({ generation: 1, shouldProject: true })
        .mockResolvedValueOnce({ generation: 2, shouldProject: false })
        .mockResolvedValueOnce({ generation: 3, shouldProject: false })

      await wake()
      await wake()
      await wake()

      // Every non-429 call bumps a generation (coalescing never swallows a
      // bump)...
      expect(wakeSvcMock.bumpWakeGeneration).toHaveBeenCalledTimes(3)
      // ...and every raw call consumed one token from the per-host bucket,
      // including the two whose annotation projection was coalesced.
      expect(rateLimiterMock.checkAndIncrement).toHaveBeenCalledTimes(3)
      expect(rateLimiterMock.checkAndIncrement).toHaveBeenNthCalledWith(
        2,
        `host-wake:${HOST_REF}`,
        config.hostWakeRlPerMin
      )
      // Only the first (in-window leader) projection reached K8s.
      expect(gateway.patchAnnotationMonotonic).toHaveBeenCalledTimes(1)
    })
  })

  describe('annotation is write-only', () => {
    it('projects the DB generation verbatim, ignoring an existing annotation value on the Host', async () => {
      // The Host already carries a HIGHER wake-requested annotation (e.g.
      // stale or clobbered by the admin facade full-replace). The handler
      // must NOT read it to compute the next value — the projected value is
      // exactly the Postgres generation.
      gateway.getResource.mockResolvedValue({
        metadata: {
          name: HOST_REF,
          annotations: { 'clerum.io/wake-requested': '999' },
        },
        spec: { lifecycle: { stateless: true } },
        status: { lifecycle: { state: 'suspended' } },
      })
      wakeSvcMock.bumpWakeGeneration.mockResolvedValue({ generation: 5, shouldProject: true })

      const res = await wake()

      expect(res.status).toBe(202)
      expect(res.body).toEqual({ status: 'wake-requested', wakeGeneration: 5 })
      expect(gateway.patchAnnotationMonotonic).toHaveBeenCalledTimes(1)
      expect(gateway.patchAnnotationMonotonic).toHaveBeenCalledWith(
        'hosts',
        HOST_REF,
        'clerum.io/wake-requested',
        5,
        config.hostsNamespace
      )
    })
  })
})
