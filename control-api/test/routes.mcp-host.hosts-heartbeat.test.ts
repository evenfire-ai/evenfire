import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { config } from '../src/config.js'
import type { K8sGateway } from '../src/k8s.js'
import { createMcpHostHostsHeartbeatRoutes } from '../src/routes/mcp-host/hosts-heartbeat.routes.js'
import * as hostHeartbeatService from '../src/services/hostHeartbeatService.js'
import { K8sNotFoundError } from '../src/services/resourceService.js'
import * as mcpHostJwt from '../src/utils/auth/mcpHostJwtToken.js'

/**
 * HTTP-level tests for POST /mcp-host/hosts/heartbeat (the /mcp-host facade
 * heartbeat ingest). The REAL requireMcpHostJwt middleware runs — only the
 * verifier is wrapped in a spy so the "400 before crypto" ordering can be
 * asserted. Tokens are minted with the real issuer (dev-default RS256 keys).
 */

vi.mock('../src/utils/auth/mcpHostJwtToken.js', async () => {
  const actual = await vi.importActual<typeof import('../src/utils/auth/mcpHostJwtToken.js')>(
    '../src/utils/auth/mcpHostJwtToken.js'
  )
  return {
    ...actual,
    verifyMcpHostAccessJwt: vi.fn(actual.verifyMcpHostAccessJwt),
  }
})

vi.mock('../src/services/hostHeartbeatService.js', () => ({
  upsertHostHeartbeat: vi.fn(),
  listHostHeartbeatsSince: vi.fn(),
}))

const HOST_REF = 'chatllm'
const verifySpy = vi.mocked(mcpHostJwt.verifyMcpHostAccessJwt)
const upsertSpy = vi.mocked(hostHeartbeatService.upsertHostHeartbeat)

function hostToken(hostRefs: string[] = [HOST_REF]): string {
  return mcpHostJwt.issueMcpHostAccessJwt('mcp-host', 'standalone', hostRefs).token
}

function heartbeatPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    hostRef: HOST_REF,
    podUid: 'pod-uid-123',
    activeWork: false,
    conditions: { activeTask: false, awaitingApproval: false, pendingResults: false },
    lastActivityTs: 1_700_000_000_000,
    state: 'active',
    ...overrides,
  }
}

function hostCr(state?: string): Record<string, unknown> {
  return {
    metadata: { name: HOST_REF, namespace: config.hostsNamespace },
    spec: { lifecycle: { stateless: true } },
    ...(state !== undefined ? { status: { lifecycle: { state } } } : {}),
  }
}

describe('POST /mcp-host/hosts/heartbeat', () => {
  const gateway = {
    getResource: vi.fn(),
  }

  const app = express()
  app.use(express.json())
  app.use(createMcpHostHostsHeartbeatRoutes(gateway as unknown as K8sGateway))

  function beat(body: unknown, token?: string) {
    const req = request(app).post('/mcp-host/hosts/heartbeat')
    if (token !== undefined) {
      req.set('Authorization', `Bearer ${token}`)
    }
    return req.send(body as object)
  }

  beforeEach(() => {
    verifySpy.mockClear()
    upsertSpy.mockReset()
    upsertSpy.mockResolvedValue(undefined)
    gateway.getResource.mockReset()
    gateway.getResource.mockResolvedValue(hostCr('active'))
  })

  describe('payload shape — 400 BEFORE any auth crypto', () => {
    it.each([
      ['missing schemaVersion', heartbeatPayload({ schemaVersion: undefined })],
      ['schemaVersion !== 1', heartbeatPayload({ schemaVersion: 2 })],
      ['empty hostRef', heartbeatPayload({ hostRef: '  ' })],
      ['missing podUid', heartbeatPayload({ podUid: undefined })],
      ['stringy activeWork', heartbeatPayload({ activeWork: 'false' })],
      [
        'non-boolean condition',
        heartbeatPayload({
          conditions: { activeTask: 'no', awaitingApproval: false, pendingResults: false },
        }),
      ],
      ['stringy lastActivityTs', heartbeatPayload({ lastActivityTs: 'now' })],
      ['negative lastActivityTs', heartbeatPayload({ lastActivityTs: -1 })],
      ['unknown state', heartbeatPayload({ state: 'sleeping' })],
      [
        'non-boolean activeCronSchedules (cron×stateless)',
        heartbeatPayload({
          conditions: {
            activeTask: false,
            awaitingApproval: false,
            pendingResults: false,
            activeCronSchedules: 'yes',
          },
        }),
      ],
      ['array body', [heartbeatPayload()]],
    ])('rejects %s with 400 and never touches the verifier', async (_name, body) => {
      const res = await beat(body, hostToken())

      expect(res.status).toBe(400)
      expect(res.body.error).toBe('invalid_heartbeat_payload')
      expect(verifySpy).not.toHaveBeenCalled()
      expect(upsertSpy).not.toHaveBeenCalled()
      expect(gateway.getResource).not.toHaveBeenCalled()
    })

    it('rejects an oversized body (content-length above the 8KB cap) with 400 before crypto', async () => {
      const res = await beat(heartbeatPayload({ padding: 'x'.repeat(9_000) }), hostToken())

      expect(res.status).toBe(400)
      expect(res.body.error).toBe('body_too_large')
      expect(verifySpy).not.toHaveBeenCalled()
      expect(upsertSpy).not.toHaveBeenCalled()
    })
  })

  describe('authentication and claims binding', () => {
    it('rejects a missing bearer token with 401 and zero side effects', async () => {
      const res = await beat(heartbeatPayload())

      expect(res.status).toBe(401)
      expect(upsertSpy).not.toHaveBeenCalled()
      expect(gateway.getResource).not.toHaveBeenCalled()
    })

    it('rejects a garbage token with 401', async () => {
      const res = await beat(heartbeatPayload(), 'not-a-jwt')

      expect(res.status).toBe(401)
      expect(upsertSpy).not.toHaveBeenCalled()
    })

    it('rejects with 403 when the payload hostRef differs from hostRefs[0] — claims win', async () => {
      const res = await beat(heartbeatPayload(), hostToken(['other-host']))

      expect(res.status).toBe(403)
      expect(res.body.error).toBe('host_binding_mismatch')
      expect(upsertSpy).not.toHaveBeenCalled()
      expect(gateway.getResource).not.toHaveBeenCalled()
    })

    it('rejects a recipe-bound (WRC-style) token whose hostRefs[0] is a recipe binding', async () => {
      const res = await beat(
        heartbeatPayload(),
        mcpHostJwt.issueMcpHostAccessJwt('sandbox-recipes', 'some-recipe', [
          'sandbox-recipes/some-recipe',
        ]).token
      )

      expect(res.status).toBe(403)
      expect(res.body.error).toBe('host_binding_mismatch')
      expect(upsertSpy).not.toHaveBeenCalled()
    })

    it('rejects a recipe-shaped ref that MATCHES the payload with 403 and no upsert (feed injection guard)', async () => {
      // A recipe-plane token whose hostRefs[0] equals its own `namespace/name`
      // payload would pass the equality check. The '/' shape must be rejected
      // BEFORE upsertHostHeartbeat so no recipe-shaped row lands in the feed.
      const res = await beat(
        heartbeatPayload({ hostRef: 'sandbox-recipes/some-recipe' }),
        mcpHostJwt.issueMcpHostAccessJwt('sandbox-recipes', 'some-recipe', [
          'sandbox-recipes/some-recipe',
        ]).token
      )

      expect(res.status).toBe(403)
      expect(res.body.error).toBe('host_binding_mismatch')
      expect(upsertSpy).not.toHaveBeenCalled()
      expect(gateway.getResource).not.toHaveBeenCalled()
    })
  })

  describe('persistence + drain verdict from the Host CR', () => {
    it('upserts the heartbeat and answers drain:false for an active Host', async () => {
      const res = await beat(heartbeatPayload(), hostToken())

      expect(res.status).toBe(200)
      expect(res.body).toEqual({ drain: false })
      expect(upsertSpy).toHaveBeenCalledTimes(1)
      expect(upsertSpy).toHaveBeenCalledWith({
        hostRef: HOST_REF,
        podUid: 'pod-uid-123',
        activeWork: false,
        conditions: {
          activeTask: false,
          awaitingApproval: false,
          pendingResults: false,
          // Cron×stateless (additive): absent on the wire normalizes to false.
          activeCronSchedules: false,
        },
        lastActivityTs: 1_700_000_000_000,
        state: 'active',
      })
      expect(gateway.getResource).toHaveBeenCalledWith('hosts', HOST_REF, config.hostsNamespace)
    })

    it('passes activeCronSchedules:true through to persistence (cron×stateless — HCC must see it)', async () => {
      const res = await beat(
        heartbeatPayload({
          activeWork: true,
          conditions: {
            activeTask: false,
            awaitingApproval: false,
            pendingResults: false,
            activeCronSchedules: true,
          },
        }),
        hostToken()
      )

      expect(res.status).toBe(200)
      expect(upsertSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          activeWork: true,
          conditions: {
            activeTask: false,
            awaitingApproval: false,
            pendingResults: false,
            activeCronSchedules: true,
          },
        })
      )
    })

    it("answers drain:true ONLY when status.lifecycle.state === 'draining'", async () => {
      gateway.getResource.mockResolvedValue(hostCr('draining'))
      expect((await beat(heartbeatPayload(), hostToken())).body).toEqual({ drain: true })

      for (const state of ['active', 'suspended', undefined]) {
        gateway.getResource.mockResolvedValue(hostCr(state))
        expect((await beat(heartbeatPayload(), hostToken())).body).toEqual({ drain: false })
      }
    })

    it('answers 503 when the Host CR read fails — the beat is already persisted', async () => {
      gateway.getResource.mockRejectedValue(new Error('k8s api unreachable'))

      const res = await beat(heartbeatPayload(), hostToken())

      expect(res.status).toBe(503)
      expect(res.body.error).toBe('host_state_unavailable')
      expect(upsertSpy).toHaveBeenCalledTimes(1)
    })

    it('answers 503 (not 404) when the Host CR is absent — an anomaly, not rollout skew', async () => {
      gateway.getResource.mockRejectedValue(new K8sNotFoundError(`hosts/${HOST_REF} not found`))

      const res = await beat(heartbeatPayload(), hostToken())

      expect(res.status).toBe(503)
      expect(res.body.error).toBe('host_state_unavailable')
    })
  })
})
