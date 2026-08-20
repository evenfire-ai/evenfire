import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createMcpHostLlmProviderAttemptRoutes } from '../src/routes/mcp-host/llmProviderAttempts.routes.js'
import { LlmProviderAttemptAuthorizeError } from '../src/services/llmProviderAttemptAuthorizer.js'
import * as authorizer from '../src/services/llmProviderAttemptAuthorizer.js'
import * as mcpHostJwt from '../src/utils/auth/mcpHostJwtToken.js'

vi.mock('../src/services/llmProviderAttemptAuthorizer.js', async () => {
  const actual = await vi.importActual<
    typeof import('../src/services/llmProviderAttemptAuthorizer.js')
  >('../src/services/llmProviderAttemptAuthorizer.js')
  return {
    ...actual,
    authorizeLlmProviderAttempt: vi.fn(),
  }
})

const NS = 'default'
const HOST = 'research-host'

function buildApp() {
  const app = express()
  app.use(express.json({ limit: '1mb' }))
  const api = express.Router()
  api.use(createMcpHostLlmProviderAttemptRoutes())
  app.use('/api/v1', api)
  return app
}

function token(scopes: mcpHostJwt.McpHostControlScope[] = ['llm:codex:execute']) {
  return mcpHostJwt.issueMcpHostAccessJwt(NS, HOST, [HOST], {
    workflowControlScopes: scopes,
  }).token
}

describe('POST /api/v1/mcp-host/llm/provider-attempts/authorize', () => {
  beforeEach(() => {
    vi.mocked(authorizer.authorizeLlmProviderAttempt).mockReset()
  })

  it('returns 401 for a missing or invalid JWT', async () => {
    const app = buildApp()
    const missing = await request(app)
      .post('/api/v1/mcp-host/llm/provider-attempts/authorize')
      .send({ request: {} })
    expect(missing.status).toBe(401)
    const invalid = await request(app)
      .post('/api/v1/mcp-host/llm/provider-attempts/authorize')
      .set('Authorization', 'Bearer not-a-jwt')
      .send({ request: {} })
    expect(invalid.status).toBe(401)
    expect(authorizer.authorizeLlmProviderAttempt).not.toHaveBeenCalled()
  })

  it('maps authorizer taxonomy without collapsing it into 500', async () => {
    const app = buildApp()
    vi.mocked(authorizer.authorizeLlmProviderAttempt).mockRejectedValueOnce(
      new LlmProviderAttemptAuthorizeError('disabled', 'off')
    )
    const disabled = await request(app)
      .post('/api/v1/mcp-host/llm/provider-attempts/authorize')
      .set('Authorization', `Bearer ${token()}`)
      .send({ request: {} })
    expect(disabled.status).toBe(404)
    expect(disabled.body).toEqual({ error: 'disabled' })

    vi.mocked(authorizer.authorizeLlmProviderAttempt).mockRejectedValueOnce(
      new LlmProviderAttemptAuthorizeError('insufficient_scope', 'no scope')
    )
    const scope = await request(app)
      .post('/api/v1/mcp-host/llm/provider-attempts/authorize')
      .set('Authorization', `Bearer ${token()}`)
      .send({ request: {} })
    expect(scope.status).toBe(403)
    expect(scope.body).toEqual({ error: 'insufficient_scope' })

    vi.mocked(authorizer.authorizeLlmProviderAttempt).mockRejectedValueOnce(
      new LlmProviderAttemptAuthorizeError('budget_denied', 'tokens')
    )
    const budget = await request(app)
      .post('/api/v1/mcp-host/llm/provider-attempts/authorize')
      .set('Authorization', `Bearer ${token()}`)
      .send({ request: {} })
    expect(budget.status).toBe(403)
    expect(budget.body).toEqual({ error: 'budget_denied' })
  })

  it('returns the authorize contract without leaking tokens', async () => {
    const app = buildApp()
    vi.mocked(authorizer.authorizeLlmProviderAttempt).mockResolvedValueOnce({
      providerAttemptId: '33333333-3333-4333-8333-333333333333',
      requestHash: 'a'.repeat(64),
      executionTicket: 'ticket.jwt',
      expiresAt: '2026-08-20T12:00:00.000Z',
    })
    const res = await request(app)
      .post('/api/v1/mcp-host/llm/provider-attempts/authorize')
      .set('Authorization', `Bearer ${token()}`)
      .send({ request: { schemaVersion: 'codex-completion-request.v1' } })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      providerAttemptId: '33333333-3333-4333-8333-333333333333',
      requestHash: 'a'.repeat(64),
      executionTicket: 'ticket.jwt',
      expiresAt: '2026-08-20T12:00:00.000Z',
    })
    expect(JSON.stringify(res.body)).not.toMatch(/refresh|access_token|Authorization/i)
  })
})
