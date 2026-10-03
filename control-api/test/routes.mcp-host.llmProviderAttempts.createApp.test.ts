import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer, request as httpRequest } from 'node:http'
import { gzipSync } from 'node:zlib'
import { registry } from '../src/observability/metrics.js'
import * as authorizer from '../src/services/llmProviderAttemptAuthorizer.js'
import { issueMcpHostAccessJwt } from '../src/utils/auth/mcpHostJwtToken.js'
import { MockGateway } from './mockGateway.js'

vi.mock('../src/config.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/config.js')>()
  return {
    ...actual,
    config: { ...actual.config, jsonBodyLimit: '1mb' },
  }
})

vi.mock('../src/db.js', () => ({
  pool: {
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    connect: vi.fn(),
  },
  withTransaction: vi.fn(),
}))

vi.mock('../src/services/notificationEmitter.js', () => ({
  emitNotification: vi.fn().mockResolvedValue(undefined),
  enqueueApprovalRequestedNotification: vi.fn().mockResolvedValue(undefined),
  enqueueApprovalUpdatedNotification: vi.fn().mockResolvedValue(undefined),
}))

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

describe('createApp POST /api/v1/mcp-host/llm/provider-attempts/authorize', () => {
  beforeEach(() => {
    vi.mocked(authorizer.authorizeLlmProviderAttempt).mockReset()
  })

  it('returns 401 for an unauthenticated body over 35 MiB without calling authorize', async () => {
    const { createApp } = await import('../src/app.js')
    const app = createApp(new MockGateway() as never)
    const listener = createServer(app).listen(0)
    try {
      const address = listener.address()
      if (!address || typeof address === 'string') throw new Error('listener has no port')
      const oversized = await fetch(
        `http://127.0.0.1:${address.port}/api/v1/mcp-host/llm/provider-attempts/authorize`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          // One byte past the shared 35 MiB (Grok) visual envelope (#784).
          body: `{"pad":"${'x'.repeat(36700160 + 1 - '{"pad":""}'.length)}"}`,
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
  }, 30_000)
})

const PROVIDERS = [
  {
    provider: 'codex-subscription',
    schemaVersion: 'codex-completion-request.v1',
    model: 'gpt-5.1',
    scope: 'llm:codex:execute',
  },
  {
    provider: 'grok-subscription',
    schemaVersion: 'grok-completion-request.v1',
    model: 'grok-4.6',
    scope: 'llm:grok:execute',
  },
] as const

const AUTHORIZE_PATHS = [
  { name: 'canonical path', path: '/api/v1/mcp-host/llm/provider-attempts/authorize' },
  { name: 'double-slash path', path: '/api/v1//mcp-host/llm/provider-attempts/authorize' },
] as const

type ProviderCase = (typeof PROVIDERS)[number]

function bodyOf(p: ProviderCase, parameters = '{"type":"object"}'): string {
  return (
    `{"request":{"schemaVersion":"${p.schemaVersion}","requestId":"req-1",` +
    `"idempotencyKey":"idem-1","provider":"${p.provider}","model":"${p.model}",` +
    `"messages":[{"role":"user","content":"hi"}],` +
    `"tools":[{"name":"t","description":"d","parameters":${parameters}}]},` +
    `"invocationId":"inv-1","attemptGeneration":1,"policyRevision":1,` +
    `"policyHash":"${'a'.repeat(64)}"}`
  )
}

function headers(p: ProviderCase): Record<string, string> {
  const issued = issueMcpHostAccessJwt('default', 'research-host', ['research-host'], {
    workflowControlScopes: [p.scope],
  })
  return { Authorization: `Bearer ${issued.token}`, 'content-type': 'application/json' }
}

async function withApp(path: string, run: (url: string) => Promise<void>): Promise<void> {
  const { createApp } = await import('../src/app.js')
  const listener = createServer(createApp(new MockGateway() as never)).listen(0)
  try {
    const address = listener.address()
    if (!address || typeof address === 'string') throw new Error('listener has no port')
    await run(`http://127.0.0.1:${address.port}${path}`)
  } finally {
    await new Promise<void>((resolve, reject) =>
      listener.close(err => (err ? reject(err) : resolve()))
    )
  }
}

async function expectAcceptedBody(url: string, p: ProviderCase): Promise<void> {
  // Only the service is mocked: this witness proves that the real app mount,
  // JWT verification and route parser still deliver the provider's body.
  const success = {
    providerAttemptId: 'attempt-1',
    requestHash: 'a'.repeat(64),
    executionTicket: 'test-execution-ticket',
    expiresAt: '2026-01-01T00:00:00.000Z',
  }
  vi.mocked(authorizer.authorizeLlmProviderAttempt).mockResolvedValueOnce(success)
  const response = await fetch(url, { method: 'POST', headers: headers(p), body: bodyOf(p) })
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual(success)
  expect(authorizer.authorizeLlmProviderAttempt).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ workflowControlScopes: [p.scope] }),
    JSON.parse(bodyOf(p)),
    expect.any(Object)
  )
}

describe('createApp authorize parser boundary', () => {
  beforeEach(() => {
    vi.mocked(authorizer.authorizeLlmProviderAttempt).mockReset()
  })

  for (const { name, path } of AUTHORIZE_PATHS) {
    for (const p of PROVIDERS) {
      describe(`${name} ${p.provider}`, () => {
        it('checks JWT before parsing malformed, 100000-deep and gzip bodies', async () => {
          const malformed = '{not json'
          const deep = bodyOf(p, `${'{"n":'.repeat(99_999)}{}${'}'.repeat(99_999)}`)
          const plain = bodyOf(p)
          await withApp(path, async url => {
            const parse = vi.spyOn(JSON, 'parse')
            try {
              const inputs: Array<{ body: BodyInit; encoding: Record<string, string> }> = [
                { body: malformed, encoding: {} },
                { body: deep, encoding: {} },
                { body: new Uint8Array(gzipSync(plain)), encoding: { 'content-encoding': 'gzip' } },
              ]
              for (const input of inputs) {
                const response = await fetch(url, {
                  method: 'POST',
                  headers: { 'content-type': 'application/json', ...input.encoding },
                  body: input.body,
                })
                expect(response.status).toBe(401)
                expect(await response.json()).toEqual({ error: 'Unauthorized' })
              }
              const parsedTexts = parse.mock.calls.map(([text]) => text)
              expect(parsedTexts).not.toContain(malformed)
              expect(parsedTexts).not.toContain(deep)
              expect(parsedTexts).not.toContain(plain)
              expect(authorizer.authorizeLlmProviderAttempt).not.toHaveBeenCalled()
            } finally {
              parse.mockRestore()
            }
          })
        })

        it('refuses authenticated over-deep and malformed bodies before authorize and accepts a valid body', async () => {
          const deep = bodyOf(p, `${'{"n":'.repeat(99_999)}{}${'}'.repeat(99_999)}`)
          await withApp(path, async url => {
            const parse = vi.spyOn(JSON, 'parse')
            try {
              for (const body of [deep, '{"request":']) {
                const response = await fetch(url, { method: 'POST', headers: headers(p), body })
                expect(response.status).toBe(400)
                expect(await response.json()).toEqual({ error: 'invalid_request' })
              }
              expect(parse.mock.calls.map(([text]) => text)).not.toContain(deep)
              expect(authorizer.authorizeLlmProviderAttempt).not.toHaveBeenCalled()
              await expectAcceptedBody(url, p)
            } finally {
              parse.mockRestore()
            }
          })
        })

        it('refuses authenticated gzip before authorize and accepts the same uncompressed body', async () => {
          await withApp(path, async url => {
            const response = await fetch(url, {
              method: 'POST',
              headers: { ...headers(p), 'content-encoding': 'gzip' },
              body: new Uint8Array(gzipSync(bodyOf(p))),
            })
            expect(response.status).toBe(415)
            expect(await response.json()).toEqual({ error: 'unsupported_media_type' })
            expect(authorizer.authorizeLlmProviderAttempt).not.toHaveBeenCalled()
            await expectAcceptedBody(url, p)
          })
        })
      })
    }
  }
})

async function getWithJsonBody(
  url: string,
  body: Buffer,
  encoding?: 'gzip'
): Promise<{ status: number; body: string }> {
  // Fetch forbids GET bodies. A native request exercises the existing, public
  // metrics route and the global parser without adding a fixture-only route.
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      url,
      {
        method: 'GET',
        headers: {
          'content-type': 'application/json',
          'content-length': body.length,
          ...(encoding ? { 'content-encoding': encoding } : {}),
        },
      },
      res => {
        const status = res.statusCode
        if (status === undefined) {
          res.resume()
          reject(new Error('response has no status'))
          return
        }
        const chunks: string[] = []
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => chunks.push(chunk))
        res.on('error', reject)
        res.on('end', () => resolve({ status, body: chunks.join('') }))
      }
    )
    req.on('error', reject)
    req.setTimeout(2_000, () => req.destroy(new Error('local parser probe timed out')))
    req.end(body)
  })
}

describe('createApp global JSON encoding', () => {
  it('refuses compressed JSON before parsing or the public handler and accepts the same uncompressed body', async () => {
    const plain = JSON.stringify({ probe: 'global-json-parser', pad: 'x'.repeat(1_024) })
    const compressed = gzipSync(plain)
    expect(Buffer.byteLength(plain)).toBeLessThan(2_048)
    expect(compressed.length).toBeLessThan(Buffer.byteLength(plain))
    await withApp('/metrics', async url => {
      const parse = vi.spyOn(JSON, 'parse')
      const metrics = vi.spyOn(registry, 'metrics')
      try {
        const gzip = await getWithJsonBody(url, compressed, 'gzip')
        // The original global parser yielded 200, parsedBody=true and one
        // handler call: this assertion detects actual inflation and dispatch.
        expect({
          status: gzip.status,
          parsedBody: parse.mock.calls.some(([text]) => text === plain),
          handlerCalls: metrics.mock.calls.length,
        }).toEqual({ status: 415, parsedBody: false, handlerCalls: 0 })
        const uncompressed = await getWithJsonBody(url, Buffer.from(plain))
        expect(uncompressed.status).toBe(200)
        expect(uncompressed.body).toContain('# HELP')
        expect(parse.mock.calls.map(([text]) => text)).toContain(plain)
        expect(metrics).toHaveBeenCalledOnce()
      } finally {
        parse.mockRestore()
        metrics.mockRestore()
      }
    })
  })
})
