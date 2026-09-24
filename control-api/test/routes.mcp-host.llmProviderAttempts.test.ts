import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { createServer } from 'node:http'
import { gzipSync } from 'node:zlib'
import request from 'supertest'
import {
  BODY_STRUCTURE_LIMITS as GROK_BODY_STRUCTURE_LIMITS,
  LIMITS as GROK_LIMITS,
} from '@clerum/grok-provider-attempt-contract'
import {
  BODY_STRUCTURE_LIMITS as CODEX_BODY_STRUCTURE_LIMITS,
  LIMITS as CODEX_LIMITS,
  scanJsonStructure,
} from '@clerum/llm-provider-attempt-contract'
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
  // Route-only harness: JWT-before-35-MiB-parser. createApp() skip of the
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

  it('returns 413 for an authenticated body one byte over the 35 MiB Grok visual envelope', async () => {
    const app = buildApp()
    const listener = createServer(app).listen(0)
    // The shared route parser admits the larger of the two visual envelopes (#784).
    const limit = Math.max(
      CODEX_LIMITS.maxVisualRequestBodyBytes,
      GROK_LIMITS.maxVisualRequestBodyBytes
    )
    expect(limit).toBe(36700160)
    /** A JSON body of exactly `bytes` bytes. */
    const bodyOf = (bytes: number) => `{"pad":"${'x'.repeat(bytes - '{"pad":""}'.length)}"}`
    try {
      const address = listener.address()
      if (!address || typeof address === 'string') throw new Error('listener has no port')
      const url = `http://127.0.0.1:${address.port}/api/v1/mcp-host/llm/provider-attempts/authorize`
      const headers = {
        Authorization: `Bearer ${token(['llm:grok:execute'])}`,
        'content-type': 'application/json',
      }
      const oversized = await fetch(url, { method: 'POST', headers, body: bodyOf(limit + 1) })
      expect(oversized.status).toBe(413)
      expect(await oversized.json()).toEqual({ error: 'payload_too_large' })
      expect(authorizer.authorizeLlmProviderAttempt).not.toHaveBeenCalled()
      // Witness: a body at the limit passes the parser and reaches the authorizer.
      vi.mocked(authorizer.authorizeLlmProviderAttempt).mockRejectedValueOnce(
        new LlmProviderAttemptAuthorizeError('invalid_request', 'fixture body')
      )
      const atLimit = await fetch(url, { method: 'POST', headers, body: bodyOf(limit) })
      expect(atLimit.status).toBe(400)
      expect(authorizer.authorizeLlmProviderAttempt).toHaveBeenCalledTimes(1)
    } finally {
      await new Promise<void>((resolve, reject) =>
        listener.close(err => (err ? reject(err) : resolve()))
      )
    }
  }, 30_000)

  // The route parser admits the Grok 35 MiB envelope for both providers, so a
  // Codex body between the two visual caps now reaches the Codex authorizer,
  // and that authorizer is what must refuse it (#806 review, L1).
  it('refuses a Codex V2 body between the Codex and Grok visual caps in the Codex authorizer', async () => {
    const actual = await vi.importActual<
      typeof import('../src/services/llmProviderAttemptAuthorizer.js')
    >('../src/services/llmProviderAttemptAuthorizer.js')
    const rejections: unknown[] = []
    vi.mocked(authorizer.authorizeLlmProviderAttempt).mockImplementation((claims, body) =>
      actual.authorizeLlmProviderAttempt(claims, body, { enabled: true }).catch(err => {
        rejections.push(err)
        throw err
      })
    )
    expect(CODEX_LIMITS.maxVisualRequestBodyBytes).toBeLessThan(
      GROK_LIMITS.maxVisualRequestBodyBytes
    )
    /** A Codex V2 authorize body of exactly `bytes` bytes. */
    const codexBodyOf = (bytes: number) => {
      const frame = JSON.stringify({
        request: { schemaVersion: 'codex-completion-request.v2', provider: 'codex-subscription' },
        pad: '',
      })
      return `${frame.slice(0, -2)}${'x'.repeat(bytes - frame.length)}"}`
    }
    const app = buildApp()
    const listener = createServer(app).listen(0)
    try {
      const address = listener.address()
      if (!address || typeof address === 'string') throw new Error('listener has no port')
      const url = `http://127.0.0.1:${address.port}/api/v1/mcp-host/llm/provider-attempts/authorize`
      const headers = {
        Authorization: `Bearer ${token()}`,
        'content-type': 'application/json',
      }
      const between = codexBodyOf(CODEX_LIMITS.maxVisualRequestBodyBytes + 1)
      expect(Buffer.byteLength(between)).toBe(CODEX_LIMITS.maxVisualRequestBodyBytes + 1)
      const refused = await fetch(url, { method: 'POST', headers, body: between })
      expect(refused.status).toBe(413)
      expect(await refused.json()).toEqual({ error: 'payload_too_large' })
      // The parser admitted the body: the 413 is the Codex authorizer's
      // whole-body check, not express.json's limit.
      expect(authorizer.authorizeLlmProviderAttempt).toHaveBeenCalledTimes(1)
      expect(rejections).toEqual([
        expect.objectContaining({
          code: 'payload_too_large',
          message: 'request body exceeds the limit',
        }),
      ])
      // Witness: at the Codex cap exactly the whole-body check passes, and the
      // next check, the non-image budget, is the one that refuses the padding.
      const atCap = codexBodyOf(CODEX_LIMITS.maxVisualRequestBodyBytes)
      const nextCheck = await fetch(url, { method: 'POST', headers, body: atCap })
      expect(nextCheck.status).toBe(413)
      expect(authorizer.authorizeLlmProviderAttempt).toHaveBeenCalledTimes(2)
      expect(rejections[1]).toMatchObject({
        code: 'payload_too_large',
        message: 'authorize wrapper exceeds the non-image limit',
      })
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

// A8 D4: JSON.parse allocates one heap object per container, so a 35 MiB body
// of empty containers exhausts the heap before any authorizer check runs, and
// a gzip body inflates past the byte limit's intent. The route parser refuses
// both from the raw bytes.
describe('authorize raw-body scan before JSON.parse (A8 D4)', () => {
  const SCAN_LIMITS = {
    maxStructuralBytes: Math.max(
      CODEX_BODY_STRUCTURE_LIMITS.maxStructuralBytes,
      GROK_BODY_STRUCTURE_LIMITS.maxStructuralBytes
    ),
    maxContainers: Math.max(
      CODEX_BODY_STRUCTURE_LIMITS.maxContainers,
      GROK_BODY_STRUCTURE_LIMITS.maxContainers
    ),
    maxDepth: Math.max(CODEX_BODY_STRUCTURE_LIMITS.maxDepth, GROK_BODY_STRUCTURE_LIMITS.maxDepth),
  }
  const UNBOUNDED = { maxStructuralBytes: Infinity, maxContainers: Infinity, maxDepth: Infinity }
  const LARGE_PARSE = 100_000

  beforeEach(() => {
    vi.mocked(authorizer.authorizeLlmProviderAttempt).mockReset()
  })

  async function withRoute(run: (url: string) => Promise<void>): Promise<void> {
    const listener = createServer(buildApp()).listen(0)
    try {
      const address = listener.address()
      if (!address || typeof address === 'string') throw new Error('listener has no port')
      await run(`http://127.0.0.1:${address.port}/api/v1/mcp-host/llm/provider-attempts/authorize`)
    } finally {
      await new Promise<void>((resolve, reject) =>
        listener.close(err => (err ? reject(err) : resolve()))
      )
    }
  }

  function headers(extra: Record<string, string> = {}): Record<string, string> {
    return { Authorization: `Bearer ${token()}`, 'content-type': 'application/json', ...extra }
  }

  /** The next body that reaches the authorizer is answered 400 by this fixture. */
  function fixtureAuthorizer(): void {
    vi.mocked(authorizer.authorizeLlmProviderAttempt).mockRejectedValueOnce(
      new LlmProviderAttemptAuthorizeError('invalid_request', 'fixture body')
    )
  }

  /** Lengths of the large strings JSON.parse received while `run` ran. */
  async function largeParsesDuring(run: () => Promise<void>): Promise<number[]> {
    const parse = vi.spyOn(JSON, 'parse')
    try {
      await run()
      return parse.mock.calls
        .map(([text]) => (typeof text === 'string' ? text.length : 0))
        .filter(length => length > LARGE_PARSE)
    } finally {
      parse.mockRestore()
    }
  }

  /** A body of exactly `n` containers: the root, `pad`, and n - 2 empty arrays. */
  const containersBody = (n: number) => `{"pad":[${'[],'.repeat(n - 3)}[]]}`
  /**
   * A body of `k` zeros and a final number. A string counts only its two quotes,
   * so structural bytes = 2k + tail + 7.
   */
  const numbersBody = (k: number, tail: string) => `{"pad":[${'0,'.repeat(k)}${tail}]}`
  /** A body `d` containers deep, the root included. */
  const deepBody = (d: number) => `{"pad":${'['.repeat(d - 1)}${']'.repeat(d - 1)}}`

  it('pins the scan bounds to the contracts', () => {
    expect(SCAN_LIMITS).toEqual({
      maxStructuralBytes: 8404992,
      maxContainers: 262160,
      maxDepth: 70,
    })
  })

  it('refuses a gzip body and a non-UTF-8 charset with 415 without reading them as JSON', async () => {
    const json = JSON.stringify({ request: { schemaVersion: 'codex-completion-request.v1' } })
    await withRoute(async url => {
      const gzip = await fetch(url, {
        method: 'POST',
        headers: headers({ 'content-encoding': 'gzip' }),
        body: new Uint8Array(gzipSync(json)),
      })
      expect(gzip.status).toBe(415)
      expect(await gzip.json()).toEqual({ error: 'unsupported_media_type' })
      const utf16 = await fetch(url, {
        method: 'POST',
        headers: headers({ 'content-type': 'application/json; charset=utf-16' }),
        body: json,
      })
      expect(utf16.status).toBe(415)
      expect(await utf16.json()).toEqual({ error: 'unsupported_media_type' })
      expect(authorizer.authorizeLlmProviderAttempt).not.toHaveBeenCalled()
      // Witness: the same body, uncompressed UTF-8, reaches the authorizer.
      fixtureAuthorizer()
      const plain = await fetch(url, { method: 'POST', headers: headers(), body: json })
      expect(plain.status).toBe(400)
      expect(authorizer.authorizeLlmProviderAttempt).toHaveBeenCalledTimes(1)
    })
  })

  it('refuses a body with more containers than the bound before JSON.parse', async () => {
    const over = containersBody(SCAN_LIMITS.maxContainers + 1)
    const atBound = containersBody(SCAN_LIMITS.maxContainers)
    expect(scanJsonStructure(Buffer.from(atBound), UNBOUNDED).containers).toBe(
      SCAN_LIMITS.maxContainers
    )
    await withRoute(async url => {
      const refusedParses = await largeParsesDuring(async () => {
        const refused = await fetch(url, { method: 'POST', headers: headers(), body: over })
        expect(refused.status).toBe(413)
        expect(await refused.json()).toEqual({ error: 'payload_too_large' })
      })
      expect(refusedParses).not.toContain(over.length)
      expect(authorizer.authorizeLlmProviderAttempt).not.toHaveBeenCalled()
      // Witness: the same shape at the bound is parsed and reaches the authorizer.
      fixtureAuthorizer()
      const admittedParses = await largeParsesDuring(async () => {
        const admitted = await fetch(url, { method: 'POST', headers: headers(), body: atBound })
        expect(admitted.status).toBe(400)
      })
      expect(admittedParses).toContain(atBound.length)
      expect(authorizer.authorizeLlmProviderAttempt).toHaveBeenCalledTimes(1)
    })
  }, 30_000)

  it('refuses a body denser than the structural bound before JSON.parse', async () => {
    const k = (SCAN_LIMITS.maxStructuralBytes - 10) / 2
    const atBound = numbersBody(k, '100')
    const over = numbersBody(k, '1000')
    expect(scanJsonStructure(Buffer.from(atBound), UNBOUNDED).structuralBytes).toBe(
      SCAN_LIMITS.maxStructuralBytes
    )
    await withRoute(async url => {
      const refusedParses = await largeParsesDuring(async () => {
        const refused = await fetch(url, { method: 'POST', headers: headers(), body: over })
        expect(refused.status).toBe(413)
        expect(await refused.json()).toEqual({ error: 'payload_too_large' })
      })
      expect(refusedParses).not.toContain(over.length)
      expect(authorizer.authorizeLlmProviderAttempt).not.toHaveBeenCalled()
      // Witness: one structural byte fewer is parsed and reaches the authorizer.
      fixtureAuthorizer()
      const admittedParses = await largeParsesDuring(async () => {
        const admitted = await fetch(url, { method: 'POST', headers: headers(), body: atBound })
        expect(admitted.status).toBe(400)
      })
      expect(admittedParses).toContain(atBound.length)
      expect(authorizer.authorizeLlmProviderAttempt).toHaveBeenCalledTimes(1)
    })
  }, 30_000)

  it('answers 400 to a body deeper than the bound, and to malformed JSON, without the authorizer', async () => {
    const tooDeep = deepBody(SCAN_LIMITS.maxDepth + 1)
    expect(scanJsonStructure(Buffer.from(tooDeep), UNBOUNDED).deepest).toBe(
      SCAN_LIMITS.maxDepth + 1
    )
    await withRoute(async url => {
      const deep = await fetch(url, { method: 'POST', headers: headers(), body: tooDeep })
      expect(deep.status).toBe(400)
      expect(await deep.json()).toEqual({ error: 'invalid_request' })
      const malformed = await fetch(url, {
        method: 'POST',
        headers: headers(),
        body: '{"request":',
      })
      expect(malformed.status).toBe(400)
      expect(await malformed.json()).toEqual({ error: 'invalid_request' })
      expect(authorizer.authorizeLlmProviderAttempt).not.toHaveBeenCalled()
      // Witness: a body at the depth bound reaches the authorizer.
      fixtureAuthorizer()
      const atBound = await fetch(url, {
        method: 'POST',
        headers: headers(),
        body: deepBody(SCAN_LIMITS.maxDepth),
      })
      expect(atBound.status).toBe(400)
      expect(authorizer.authorizeLlmProviderAttempt).toHaveBeenCalledTimes(1)
    })
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
