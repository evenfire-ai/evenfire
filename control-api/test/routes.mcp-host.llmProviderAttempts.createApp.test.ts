import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import * as authorizer from '../src/services/llmProviderAttemptAuthorizer.js'
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

  it('returns 401 for an unauthenticated body over 24 MiB without calling authorize', async () => {
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
          body: `{"pad":"${'x'.repeat(25 * 1024 * 1024)}"}`,
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
