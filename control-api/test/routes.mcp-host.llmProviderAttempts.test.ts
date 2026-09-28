import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { createServer } from 'node:http'
import request from 'supertest'
import {
  createMcpHostLlmProviderAttemptRoutes,
  resolveHostAssignedAssignment,
} from '../src/routes/mcp-host/llmProviderAttempts.routes.js'
import { LlmProviderAttemptAuthorizeError } from '../src/services/llmProviderAttemptAuthorizer.js'
import * as authorizer from '../src/services/llmProviderAttemptAuthorizer.js'
import * as mcpHostJwt from '../src/utils/auth/mcpHostJwtToken.js'

vi.mock('../src/services/rateLimiterService.js', () => ({
  checkAndIncrement: vi.fn().mockResolvedValue({
    allowed: true,
    backendAvailable: true,
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
  // Route-only harness: JWT-before-24-MiB-parser. createApp() skip of the
  // global 150mb parser is locked in llmProviderAttempts.createApp.test.ts.
  const api = express.Router()
  api.use(
    createMcpHostLlmProviderAttemptRoutes({
      getResource: vi.fn(),
    } as never)
  )
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

  it('returns 401 for an unauthenticated 7 MiB body without parsing it as 413', async () => {
    const app = buildApp()
    const listener = createServer(app).listen(0)
    try {
      const address = listener.address()
      if (!address || typeof address === 'string') throw new Error('listener has no port')
      const oversized = await fetch(
        `http://127.0.0.1:${address.port}/api/v1/mcp-host/llm/provider-attempts/authorize`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: `{"pad":"${'x'.repeat(7 * 1024 * 1024)}"}`,
        }
      )
      expect(oversized.status).toBe(401)
      expect(oversized.status).not.toBe(413)
      expect(authorizer.authorizeLlmProviderAttempt).not.toHaveBeenCalled()
    } finally {
      await new Promise<void>((resolve, reject) =>
        listener.close(err => (err ? reject(err) : resolve()))
      )
    }
  })

  it('returns 413 for an authenticated body over the 24 MiB visual envelope', async () => {
    const app = buildApp()
    const listener = createServer(app).listen(0)
    try {
      const address = listener.address()
      if (!address || typeof address === 'string') throw new Error('listener has no port')
      const oversized = await fetch(
        `http://127.0.0.1:${address.port}/api/v1/mcp-host/llm/provider-attempts/authorize`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token()}`,
            'content-type': 'application/json',
          },
          body: `{"pad":"${'x'.repeat(25 * 1024 * 1024)}"}`,
        }
      )
      expect(oversized.status).toBe(413)
      expect(await oversized.json()).toEqual({ error: 'payload_too_large' })
      expect(authorizer.authorizeLlmProviderAttempt).not.toHaveBeenCalled()
    } finally {
      await new Promise<void>((resolve, reject) =>
        listener.close(err => (err ? reject(err) : resolve()))
      )
    }
  }, 30_000)

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

    vi.mocked(authorizer.authorizeLlmProviderAttempt).mockRejectedValueOnce(
      new LlmProviderAttemptAuthorizeError('unassigned_connection', 'no grant assigned')
    )
    const unassigned = await request(app)
      .post('/api/v1/mcp-host/llm/provider-attempts/authorize')
      .set('Authorization', `Bearer ${token()}`)
      .send({ request: {} })
    expect(unassigned.status).toBe(403)
    expect(unassigned.body).toEqual({ error: 'unassigned_connection' })

    vi.mocked(authorizer.authorizeLlmProviderAttempt).mockRejectedValueOnce(
      new LlmProviderAttemptAuthorizeError('payload_too_large', 'proxy envelope exceeds limit')
    )
    const oversized = await request(app)
      .post('/api/v1/mcp-host/llm/provider-attempts/authorize')
      .set('Authorization', `Bearer ${token()}`)
      .send({ request: {} })
    expect(oversized.status).toBe(413)
    expect(oversized.body).toEqual({ error: 'payload_too_large' })
  })

  it('injects resolveAssignment from the live Host instead of the empty default', async () => {
    const getResource = vi.fn().mockResolvedValue({
      spec: {
        model: { provider: 'codex-subscription', name: 'gpt-5.1', connectionRef: 'team-plus' },
      },
    })
    const app = express()
    app.use(express.json({ limit: '1mb' }))
    const api = express.Router()
    api.use(createMcpHostLlmProviderAttemptRoutes({ getResource } as never))
    app.use('/api/v1', api)
    vi.mocked(authorizer.authorizeLlmProviderAttempt).mockResolvedValueOnce({
      providerAttemptId: '33333333-3333-4333-8333-333333333333',
      requestHash: 'a'.repeat(64),
      executionTicket: 'ticket.jwt',
      expiresAt: '2026-08-20T12:00:00.000Z',
    })
    await request(app)
      .post('/api/v1/mcp-host/llm/provider-attempts/authorize')
      .set('Authorization', `Bearer ${token()}`)
      .send({ request: { schemaVersion: 'codex-completion-request.v1' } })
    expect(authorizer.authorizeLlmProviderAttempt).toHaveBeenCalled()
    const injected = vi.mocked(authorizer.authorizeLlmProviderAttempt).mock.calls[0]?.[2]
    expect(injected?.resolveAssignment).toEqual(expect.any(Function))
    await expect(injected!.resolveAssignment!('research-host')).resolves.toEqual({
      liveBrokerProviders: ['codex-subscription'],
      liveConnectionRef: 'team-plus',
    })
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

  it('admits a V2 authorize body larger than 1 MiB', async () => {
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
      .send({
        request: {
          schemaVersion: 'codex-completion-request.v2',
          pad: 'x'.repeat(2 * 1024 * 1024),
        },
      })
    expect(res.status).toBe(200)
    expect(authorizer.authorizeLlmProviderAttempt).toHaveBeenCalledOnce()
  })
})

describe('resolveHostAssignedAssignment', () => {
  it('reads connectionRef from a static primary with a Codex fallback', async () => {
    const gateway = {
      getResource: vi.fn().mockResolvedValue({
        spec: {
          model: { provider: 'openai', name: 'gpt-5.1', connectionRef: 'team-plus' },
          secretRef: 'llm',
          llmPolicy: { fallbacks: [{ provider: 'codex-subscription', name: 'gpt-5.3-codex' }] },
        },
      }),
    }
    await expect(resolveHostAssignedAssignment(gateway, 'agent-a')).resolves.toEqual({
      liveBrokerProviders: ['codex-subscription'],
      liveConnectionRef: 'team-plus',
    })
  })

  it('reads connectionRef from a Grok Host', async () => {
    const gateway = {
      getResource: vi.fn().mockResolvedValue({
        spec: {
          model: { provider: 'grok-subscription', name: 'grok-4.6', connectionRef: 'team-grok' },
        },
      }),
    }
    await expect(resolveHostAssignedAssignment(gateway, 'agent-g')).resolves.toEqual({
      liveBrokerProviders: ['grok-subscription'],
      liveConnectionRef: 'team-grok',
    })
  })

  it('reads the Host connectionRef and treats a missing field as unassigned', async () => {
    const gateway = {
      getResource: vi.fn().mockResolvedValue({
        spec: { model: { provider: 'codex-subscription', connectionRef: 'team-plus' } },
      }),
    }
    await expect(resolveHostAssignedAssignment(gateway, 'agent-a')).resolves.toMatchObject({
      liveConnectionRef: 'team-plus',
    })

    gateway.getResource.mockResolvedValueOnce({
      spec: { model: { provider: 'codex-subscription' } },
    })
    await expect(resolveHostAssignedAssignment(gateway, 'agent-b')).resolves.toMatchObject({
      liveConnectionRef: 'unassigned',
    })
  })

  it('returns recipe broker targets and raw annotations for the authorizer to attest', async () => {
    const annotations = {
      'clerum.io/codex-connection-ref': 'team-plus',
      'clerum.io/subscription-connection-ref': 'other-key',
    }
    const gateway = {
      getResource: vi.fn().mockResolvedValue({
        metadata: { annotations },
        spec: { agent: { provider: 'codex-subscription' } },
      }),
    }
    await expect(
      resolveHostAssignedAssignment(gateway, 'sandbox-recipes/codex-recipe')
    ).resolves.toEqual({
      liveBrokerProviders: ['codex-subscription'],
      liveConnectionRef: 'unassigned',
      annotations,
    })
    expect(gateway.getResource).toHaveBeenCalledWith(
      'workflowrecipes',
      'codex-recipe',
      'sandbox-recipes'
    )
  })

  it('fails closed when the recipe cannot be attested', async () => {
    const gateway = {
      getResource: vi.fn().mockRejectedValue(Object.assign(new Error('nf'), { code: 404 })),
    }
    await expect(
      resolveHostAssignedAssignment(gateway, 'sandbox-recipes/ghost-recipe')
    ).rejects.toMatchObject({ code: 'host_binding_mismatch' })

    // Malformed multi-segment refs never reach the gateway.
    await expect(resolveHostAssignedAssignment(gateway, 'ns/name/extra')).rejects.toMatchObject({
      code: 'host_binding_mismatch',
    })
  })

  it('fails closed when the Host cannot be attested', async () => {
    const gateway = {
      getResource: vi.fn().mockRejectedValue(Object.assign(new Error('nf'), { code: 404 })),
    }
    await expect(resolveHostAssignedAssignment(gateway, 'ghost')).rejects.toMatchObject({
      code: 'host_binding_mismatch',
    })
  })
})
