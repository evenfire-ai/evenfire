import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createMcpHostPluginWorkloadSdkRoutes } from '../src/routes/mcp-host/plugin-workload-sdk.routes.js'
import { issuePluginWorkloadSdkCredentialTicket } from '../src/services/pluginWorkloadSdkCredentialTicket.js'
import { hashPromptTargetPolicy } from '../src/services/pluginWorkloadSdkDb.js'
import { issueMcpHostAccessJwt } from '../src/utils/auth/mcpHostJwtToken.js'

const boundary = vi.hoisted(() => ({
  counts: new Map<string, number>(),
  reissue: vi.fn(),
  invocation: vi.fn(),
  grant: vi.fn(),
  receipt: vi.fn(),
  attempt: vi.fn(),
  redeem: vi.fn(),
}))

// The controlled limit exercises the real route guards at their configuration
// boundary. Only database state and ticket-authorizer persistence are mocked;
// JWT authentication, signed tickets, binding checks and quota middleware run.
vi.mock('../src/config.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/config.js')>()
  return { ...actual, config: { ...actual.config, pluginSdkCredentialRlPerMin: 6 } }
})
vi.mock('../src/db.js', () => ({
  pool: { query: vi.fn(), connect: vi.fn() },
  withTransaction: vi.fn(),
  rateLimitPool: {
    query: vi.fn(async (_sql: string, params: unknown[]) => {
      const key = `${String(params[0])}|${String(params[1])}`
      const count = (boundary.counts.get(key) ?? 0) + 1
      boundary.counts.set(key, count)
      return { rows: [{ count }], rowCount: 1 }
    }),
  },
}))
vi.mock('../src/services/pluginWorkloadSdkDb.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/services/pluginWorkloadSdkDb.js')>()
  return {
    ...actual,
    getInvocationById: (...args: unknown[]) => boundary.invocation(...args),
    findGrant: (...args: unknown[]) => boundary.grant(...args),
    getPluginWorkloadSdkAttemptReceipt: (...args: unknown[]) => boundary.receipt(...args),
    getPluginWorkloadSdkProviderAttempt: (...args: unknown[]) => boundary.attempt(...args),
    redeemPluginWorkloadSdkCredentialTicketJti: (...args: unknown[]) => boundary.redeem(...args),
  }
})
vi.mock('../src/services/pluginWorkloadSdkAuthorizer.js', async importOriginal => {
  const actual =
    await importOriginal<typeof import('../src/services/pluginWorkloadSdkAuthorizer.js')>()
  return {
    ...actual,
    reissuePromptBridgeCredentialTicket: (...args: unknown[]) => boundary.reissue(...args),
  }
})

const NS = 'sandbox-recipes'
const RECIPE = 'credential-budget'
const target = {
  targetRef: 'primary-zai',
  provider: 'zai',
  model: 'glm-4.7',
  credentialSlot: 'zai-api-key',
}
const policy = { policyRevision: 1, defaultTargetRef: target.targetRef, promptTargets: [target] }
const policyHash = hashPromptTargetPolicy(policy)
const attemptIds = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
]

describe('SDK credential-operation budget across actual endpoints', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-02T12:00:17.500Z'))
    boundary.counts.clear()
    const used = new Set<string>()
    boundary.redeem.mockReset().mockImplementation(async ({ jti }: { jti: string }) => {
      if (used.has(jti)) return false
      used.add(jti)
      return true
    })
    boundary.grant.mockReset().mockResolvedValue({
      id: 'grant-credential-budget',
      recipeNamespace: NS,
      recipeName: RECIPE,
      capabilityFamily: 'promptBridge',
      ...policy,
      policyState: 'active',
    })
    boundary.invocation.mockReset().mockImplementation(async (id: string) => ({
      id,
      recipeNamespace: NS,
      recipeName: RECIPE,
      method: 'promptBridge',
      status: 'in_progress',
      attemptGeneration: 1,
      authorizationDecision: 'authorized',
      promptAuthorization: {
        policyRevision: 1,
        policyHash,
        authorizedTargetRefs: [target.targetRef],
      },
    }))
    boundary.receipt.mockReset().mockImplementation(async (invocationId: string) => ({
      invocationId,
      recipeNamespace: NS,
      recipeName: RECIPE,
      method: 'promptBridge',
      status: 'in_progress',
      attemptGeneration: 1,
    }))
    boundary.attempt.mockReset().mockImplementation(async (id: string) => ({
      id,
      invocationId: `inv-${attemptIds.indexOf(id) + 1}`,
      attemptGeneration: 1,
      targetRef: target.targetRef,
      status: 'in_progress',
    }))
    boundary.reissue
      .mockReset()
      .mockImplementation(async ({ invocationId }: { invocationId: string }) => {
        const index = Number(invocationId.slice(4)) - 1
        return {
          ok: true,
          value: {
            invocationId,
            attemptGeneration: 1,
            targetRef: target.targetRef,
            providerAttemptId: attemptIds[index],
            providerAttemptIndex: 1,
            credentialTicket: issuePluginWorkloadSdkCredentialTicket({
              recipeNamespace: NS,
              recipeName: RECIPE,
              invocationId,
              attemptGeneration: 1,
              providerAttemptId: attemptIds[index],
              providerAttemptIndex: 1,
              target,
              policyRevision: 1,
              policyHash,
            }),
            policyRevision: 1,
            policyHash,
            expiresInSeconds: 60,
          },
        }
      })
  })

  afterEach(() => vi.useRealTimers())

  it('permits two three-operation static credential sequences at six, then rejects the third reissue before ticket work', async () => {
    const instance = express()
    instance.use(express.json())
    instance.use(createMcpHostPluginWorkloadSdkRoutes())
    const authorization = `Bearer ${
      issueMcpHostAccessJwt(NS, RECIPE, undefined, {
        workflowControlScopes: ['plugin-workload-sdk'],
      }).token
    }`
    for (let index = 1; index <= 2; index += 1) {
      const invocationId = `inv-${index}`
      const issued = await request(instance)
        .post('/mcp-host/plugin-workload-sdk/prompt-bridge/credential-ticket')
        .set('Authorization', authorization)
        .send({
          recipeNamespace: NS,
          recipeName: RECIPE,
          invocationId,
          targetRef: target.targetRef,
          attemptGeneration: 1,
        })
      expect(issued.status).toBe(201)
      const body = {
        credentialTicket: issued.body.credentialTicket,
        invocationId,
        targetRef: target.targetRef,
        attemptGeneration: 1,
        providerAttemptId: attemptIds[index - 1],
        providerAttemptIndex: 1,
      }
      await request(instance)
        .post('/mcp-host/plugin-workload-sdk/credential-ticket/introspect')
        .set('Authorization', authorization)
        .send({ ...body, redeem: false })
        .expect(200)
      expect(boundary.redeem).toHaveBeenCalledTimes(index - 1)
      await request(instance)
        .post('/mcp-host/plugin-workload-sdk/credential-ticket/introspect')
        .set('Authorization', authorization)
        .send({ ...body, redeem: true })
        .expect(200)
      expect(boundary.redeem).toHaveBeenCalledTimes(index)
    }
    const denied = await request(instance)
      .post('/mcp-host/plugin-workload-sdk/prompt-bridge/credential-ticket')
      .set('Authorization', authorization)
      .send({
        recipeNamespace: NS,
        recipeName: RECIPE,
        invocationId: 'inv-3',
        targetRef: target.targetRef,
        attemptGeneration: 1,
      })
    expect(denied.status).toBe(429)
    expect(Number(denied.headers['retry-after'])).toBeGreaterThan(0)
    expect(boundary.reissue).toHaveBeenCalledTimes(2)
    expect(boundary.invocation).toHaveBeenCalledTimes(4)
    expect(boundary.redeem).toHaveBeenCalledTimes(2)
    const credentialCounts = [...boundary.counts.entries()].filter(([key]) =>
      key.startsWith('plugin_workload_sdk_credential:')
    )
    expect(credentialCounts).toHaveLength(1)
    expect(credentialCounts[0][0]).toContain(`plugin_workload_sdk_credential:${NS}/${RECIPE}|`)
    expect(credentialCounts[0][1]).toBe(7)
  })
})
