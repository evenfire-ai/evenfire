import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { hashCodexCompletionRequestV1 } from '@clerum/llm-provider-attempt-contract'
import { config } from '../src/config.js'
import { createMcpHostLlmProviderAttemptRoutes } from '../src/routes/mcp-host/llmProviderAttempts.routes.js'
import { computeCodexPolicyHash } from '../src/services/llmProviderAttemptAuthorizer.js'
import * as mcpHostJwt from '../src/utils/auth/mcpHostJwtToken.js'

vi.mock('../src/services/rateLimiterService.js', () => ({
  checkAndIncrement: vi.fn().mockResolvedValue({
    allowed: true,
    remaining: 59,
    resetMs: Date.now() + 60_000,
    windowStartMs: Date.now(),
    count: 1,
  }),
}))

vi.mock('../src/observability/metrics.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/observability/metrics.js')>()
  return {
    ...actual,
    rateLimitHitsTotal: { inc: vi.fn() },
  }
})

const REQUEST = {
  schemaVersion: 'codex-completion-request.v1' as const,
  requestId: 'req-001',
  idempotencyKey: 'idem-001',
  provider: 'codex-subscription' as const,
  model: 'gpt-5.1',
  messages: [{ role: 'user' as const, content: 'hello' }],
}

describe('authorize D6 live-target witness', () => {
  beforeEach(() => {
    config.codexSubscriptionEnabled = true
  })

  it('returns 403 host_binding_mismatch for a Codex body on a static-only Host', async () => {
    const app = express()
    app.use(express.json({ limit: '1mb' }))
    const api = express.Router()
    api.use(
      createMcpHostLlmProviderAttemptRoutes({
        getResource: vi.fn().mockResolvedValue({
          spec: { model: { provider: 'openai', name: 'gpt-5.1' }, secretRef: 'llm' },
        }),
      } as never)
    )
    app.use('/api/v1', api)

    const token = mcpHostJwt.issueMcpHostAccessJwt('default', 'research-host', ['research-host'], {
      workflowControlScopes: ['llm:codex:execute'],
    }).token
    const res = await request(app)
      .post('/api/v1/mcp-host/llm/provider-attempts/authorize')
      .set('Authorization', `Bearer ${token}`)
      .send({
        request: REQUEST,
        invocationId: 'invocation-1',
        attemptGeneration: 1,
        providerAttemptIndex: 1,
        policyRevision: 4,
        policyHash: computeCodexPolicyHash({
          model: REQUEST.model,
          catalogRevision: 4,
          credentialRevision: 3,
        }),
        requestHash: hashCodexCompletionRequestV1(REQUEST),
      })
    expect(res.status).toBe(403)
    expect(res.body).toEqual({ error: 'host_binding_mismatch' })
  })
})
