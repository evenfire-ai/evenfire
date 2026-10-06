import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import { config } from '../src/config.js'
import {
  createPluginWorkloadSdkAnonymousPreauthRateLimit,
  createPluginWorkloadSdkAuthenticatedPreauthRateLimit,
  createPluginWorkloadSdkInternalEdgeRateLimit,
  createPluginWorkloadSdkVerificationBudgetRateLimit,
} from '../src/middleware/pluginWorkloadSdkRateLimits.js'
import { createInternalPluginWorkloadSdkRouter } from '../src/routes/internal/pluginWorkloadSdk.js'
import { createMcpHostPluginWorkloadSdkRoutes } from '../src/routes/mcp-host/plugin-workload-sdk.routes.js'
import { verifyInternalControlJwt } from '../src/utils/auth/internalControlToken.js'
import { issueMcpHostAccessJwt, verifyMcpHostAccessJwt } from '../src/utils/auth/mcpHostJwtToken.js'

// Count signature verifications without changing their result, so each test
// can prove how many tokens a limiter verified before it denied.
vi.mock('../src/utils/auth/mcpHostJwtToken.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/utils/auth/mcpHostJwtToken.js')>()
  return { ...actual, verifyMcpHostAccessJwt: vi.fn(actual.verifyMcpHostAccessJwt) }
})
vi.mock('../src/utils/auth/internalControlToken.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/utils/auth/internalControlToken.js')>()
  return { ...actual, verifyInternalControlJwt: vi.fn(actual.verifyInternalControlJwt) }
})
vi.mock('../src/db.js', () => ({
  pool: { query: vi.fn(), connect: vi.fn() },
  rateLimitPool: { query: vi.fn() },
}))

const mcpHostVerifier = vi.mocked(verifyMcpHostAccessJwt)
const internalVerifier = vi.mocked(verifyInternalControlJwt)

function mcpHostVerificationsOf(token: string): number {
  return mcpHostVerifier.mock.calls.filter(([candidate]) => candidate === token).length
}

function signedHost(): string {
  return issueMcpHostAccessJwt('sandbox-recipes', 'budget-sdk', undefined, {
    workflowControlScopes: ['plugin-workload-sdk'],
  }).token
}

function forgedInternal(): string {
  return jwt.sign({ iss: 'wrc', aud: 'control-api', sub: 'wrc-provisioner' }, 'not-the-secret', {
    algorithm: 'HS256',
    expiresIn: 60,
  })
}

describe('Plugin Workload SDK verification budget', () => {
  const original = {
    authenticated: config.pluginSdkAuthenticatedPreauthRlPerMin,
    anonymous: config.pluginSdkPreauthRlPerMin,
  }

  beforeEach(() => {
    mcpHostVerifier.mockClear()
    internalVerifier.mockClear()
  })

  afterEach(() => {
    config.pluginSdkAuthenticatedPreauthRlPerMin = original.authenticated
    config.pluginSdkPreauthRlPerMin = original.anonymous
  })

  function preauthApp() {
    const instance = express()
    instance.use(
      createPluginWorkloadSdkVerificationBudgetRateLimit(),
      createPluginWorkloadSdkAnonymousPreauthRateLimit(),
      createPluginWorkloadSdkAuthenticatedPreauthRateLimit()
    )
    // The handler never verifies, so every counted call came from a limiter.
    instance.get('/sdk-gate', (_req, res) => res.json({ ok: true }))
    return instance
  }

  it('denies tokens past the per-IP budget without verifying them', async () => {
    config.pluginSdkAuthenticatedPreauthRlPerMin = 4
    config.pluginSdkPreauthRlPerMin = 2
    const instance = preauthApp()
    const forged = `${signedHost()}x`
    const valid = signedHost()

    await request(instance).get('/sdk-gate').set('Authorization', `Bearer ${forged}`).expect(200)
    await request(instance).get('/sdk-gate').set('Authorization', `Bearer ${forged}`).expect(200)
    await request(instance).get('/sdk-gate').set('Authorization', `Bearer ${forged}`).expect(429)
    // A valid caller behind the flooded IP still passes inside the budget.
    await request(instance).get('/sdk-gate').set('Authorization', `Bearer ${valid}`).expect(200)
    expect(mcpHostVerificationsOf(forged)).toBe(3)
    expect(mcpHostVerificationsOf(valid)).toBe(1)

    const denied = await request(instance).get('/sdk-gate').set('Authorization', `Bearer ${valid}`)
    expect(denied.status).toBe(429)
    expect(denied.body).toEqual({ error: 'Too Many Requests', retryable: true })
    expect(mcpHostVerificationsOf(valid)).toBe(1)
  })

  it('does not spend the budget on requests that present no bearer token', async () => {
    config.pluginSdkAuthenticatedPreauthRlPerMin = 1
    config.pluginSdkPreauthRlPerMin = 10
    const instance = preauthApp()
    const valid = signedHost()

    for (let i = 0; i < 3; i += 1) await request(instance).get('/sdk-gate').expect(200)
    await request(instance).get('/sdk-gate').set('Authorization', `Bearer ${valid}`).expect(200)
    expect(mcpHostVerificationsOf(valid)).toBe(1)
  })

  it('bounds internal edge verification per IP before the edge limiter verifies', async () => {
    config.pluginSdkAuthenticatedPreauthRlPerMin = 3
    const instance = express()
    instance.use(
      createPluginWorkloadSdkVerificationBudgetRateLimit(),
      createPluginWorkloadSdkInternalEdgeRateLimit()
    )
    instance.post('/edge', (_req, res) => res.json({ ok: true }))
    const forged = forgedInternal()

    for (let i = 0; i < 3; i += 1) {
      await request(instance).post('/edge').set('Authorization', `Bearer ${forged}`).expect(200)
    }
    expect(internalVerifier).toHaveBeenCalledTimes(3)
    await request(instance).post('/edge').set('Authorization', `Bearer ${forged}`).expect(429)
    expect(internalVerifier).toHaveBeenCalledTimes(3)
  })

  it('is mounted ahead of verification on both SDK routers', async () => {
    config.pluginSdkAuthenticatedPreauthRlPerMin = 2
    config.pluginSdkPreauthRlPerMin = 600

    const mcpHost = express()
    mcpHost.use(express.json())
    mcpHost.use('/api/v1', createMcpHostPluginWorkloadSdkRoutes())
    const forgedHost = `${signedHost()}x`
    const hostPath = '/api/v1/mcp-host/plugin-workload-sdk/capabilities'
    for (let i = 0; i < 2; i += 1) {
      await request(mcpHost).get(hostPath).set('Authorization', `Bearer ${forgedHost}`).expect(401)
    }
    await request(mcpHost).get(hostPath).set('Authorization', `Bearer ${forgedHost}`).expect(429)

    const internal = express()
    internal.use(express.json())
    internal.use('/api/v1', createInternalPluginWorkloadSdkRouter())
    const forged = forgedInternal()
    const internalPath = '/api/v1/internal/plugin-workload-sdk/revoke'
    for (let i = 0; i < 2; i += 1) {
      await request(internal)
        .post(internalPath)
        .set('Authorization', `Bearer ${forged}`)
        .send({})
        .expect(401)
    }
    await request(internal)
      .post(internalPath)
      .set('Authorization', `Bearer ${forged}`)
      .send({})
      .expect(429)
    expect(internalVerifier.mock.calls.length).toBeGreaterThanOrEqual(2)
  })
})
