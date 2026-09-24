import { describe, expect, it, vi } from 'vitest'
import type { Router } from 'express'

type LimiterOptions = {
  bucketType: string
  maxPerMinute: number
  onBackendUnavailable: 'process-memory' | 'closed'
}

const captured = vi.hoisted(() => [] as LimiterOptions[])

vi.mock('../src/config.js', () => ({
  config: {
    approvalRlExternalClientIpPerMin: 100,
    approvalRlExternalEdgePerMin: 100,
    approvalRlExternalPerMin: 60,
  },
}))
vi.mock('../src/middleware/externalClientIdentity.js', () => ({
  createExternalClientRateLimiters: () => [],
}))
vi.mock('../src/middleware/externalSessionAuth.js', () => ({
  isCurrentExternalSession: vi.fn(),
  requireValidExternalSessionToken: (_req: unknown, _res: unknown, next: () => void) => next(),
}))
vi.mock('../src/middleware/rateLimitMiddleware.js', () => ({
  rateLimitMiddleware: (options: LimiterOptions) => {
    captured.push(options)
    const middleware = ((_req: unknown, _res: unknown, next: () => void) => next()) as ((
      ...args: unknown[]
    ) => void) & { limiterOptions: LimiterOptions }
    middleware.limiterOptions = options
    return middleware
  },
}))
vi.mock('../src/routes/entityChangeStream.js', () => ({
  parseRequestedEntityChangeCursor: () => null,
  streamEntityChanges: vi.fn(),
}))

const { createExternalEntityChangesRouter } =
  await import('../src/routes/external/entityChanges.routes.js')

type RouteLayer = {
  route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: unknown }> }
}

describe('external entity-change stream rate-limit policy', () => {
  it('fails closed when the shared rate-limit backend cannot count the user request', () => {
    const router: Router = createExternalEntityChangesRouter()
    const route = (router.stack as RouteLayer[]).find(
      layer => layer.route?.path === '/external/entity-changes/stream'
    )?.route
    expect(route).toBeDefined()
    expect(captured).toHaveLength(1)
    expect(captured[0]).toMatchObject({
      bucketType: 'external_user',
      maxPerMinute: 60,
      onBackendUnavailable: 'closed',
    })
    expect(route?.stack.some(layer => 'limiterOptions' in (layer.handle as object))).toBe(true)
  })
})
