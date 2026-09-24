import { describe, expect, it, vi } from 'vitest'
import type { Router } from 'express'

/**
 * #764: the two actor buckets in front of the external grant and share routes
 * refuse a request they cannot count. An HTTP test cannot observe this option,
 * because the pre-resolution Postgres bucket fails closed first on the same
 * pool, so the wiring is read from the router: which options each limiter was
 * built with, and which routes mount it.
 */

type LimiterOptions = { bucketType: string; onBackendUnavailable: 'process-memory' | 'closed' }
type TaggedLimiter = ((...a: unknown[]) => void) & { limiterOptions: LimiterOptions }

const built = vi.hoisted(() => [] as LimiterOptions[])

vi.mock('../src/middleware/rateLimitMiddleware.js', () => ({
  rateLimitMiddleware: (options: LimiterOptions) => {
    built.push(options)
    const limiter = ((_req: unknown, _res: unknown, next: () => void) => next()) as TaggedLimiter
    limiter.limiterOptions = options
    return limiter
  },
}))
vi.mock('../src/config.js', () => ({
  config: {
    gfscBaseUrl: 'http://gfsc.gfs.svc:8087',
    gfscWriteBaseUrl: 'http://gfsc-writer.gfs.svc:8087',
    gfscProxyTimeoutMs: 300_000,
    gfsUploadMaxPartBytes: 16 * 1024 * 1024,
    hostsNamespace: 'mcp-host',
    desktopGfsOperatorLinkingEnabled: false,
    externalGfsIngressRlPerMin: 1800,
    externalGfsTokenUserRlPerMin: 10,
    externalGfsTokenIpRlPerMin: 600,
    externalGfsIpRlPerMin: 1200,
    externalGfsResourceReadRlPerMin: 120,
    externalGfsProxyReadRlPerMin: 60,
    externalGfsGrantsReadRlPerMin: 45,
    externalGfsSharesReadRlPerMin: 35,
    externalGfsOperationRlPerMin: 30,
  },
}))
// Both derive signing keys at module load; building the router never signs.
vi.mock('../src/utils/auth/externalSessionAuthToken.js', () => ({
  verifyExternalSessionToken: vi.fn(),
}))
vi.mock('../src/auth/gfsToken.js', () => ({
  GFS_DELETE_SCOPE: 'gfs.delete',
  GFS_READ_SCOPE: 'gfs.read',
  GFS_WRITE_SCOPE: 'gfs.write',
  GFS_SCOPES: ['gfs.read', 'gfs.write', 'gfs.delete', 'gfs.manage_acl', 'gfs.share'],
  signGfsToken: vi.fn(),
}))
vi.mock('../src/db.js', () => ({
  pool: { query: vi.fn() },
  rateLimitPool: { query: vi.fn() },
  withTransaction: vi.fn(),
}))
// grants.ts/shares.ts/token.ts import requireAuthForControlUI, which derives the
// admin JWT key at module load; these routes never call it.
vi.mock('../src/middleware/controlUIAuth.js', () => ({
  requireAuthForControlUI: (_req: unknown, _res: unknown, next: () => void) => next(),
}))

const { createExternalGfsRouter } = await import('../src/routes/external/gfs.js')

type RouteLayer = {
  route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: unknown }> }
}

function actorLimiterOf(router: Router, method: string, path: string): LimiterOptions {
  const layer = (router.stack as RouteLayer[]).find(
    l => l.route?.path === path && l.route.methods[method] === true
  )
  if (!layer?.route) throw new Error(`route ${method.toUpperCase()} ${path} is not mounted`)
  const limiters = layer.route.stack
    .map(s => (s.handle as Partial<TaggedLimiter>).limiterOptions)
    .filter((o): o is LimiterOptions => o !== undefined)
  expect(limiters).toHaveLength(1)
  return limiters[0]!
}

describe('external GFS grant and share actor limiters', () => {
  const router = createExternalGfsRouter()

  it('builds both actor buckets to fail closed', () => {
    // Witness: the router built exactly these two limiters, so the rows below
    // are the options the routes use and not an empty match.
    expect(built.map(o => o.bucketType).sort()).toEqual([
      'gfs_grants_external',
      'gfs_grants_external_read',
    ])
    for (const options of built) expect(options.onBackendUnavailable).toBe('closed')
  })

  it.each([
    ['get', '/external/gfs/grants', 'gfs_grants_external_read'],
    ['get', '/external/gfs/shares', 'gfs_grants_external_read'],
    ['put', '/external/gfs/grants', 'gfs_grants_external'],
    ['delete', '/external/gfs/grants/:id', 'gfs_grants_external'],
    ['post', '/external/gfs/shares', 'gfs_grants_external'],
    ['delete', '/external/gfs/shares/:id', 'gfs_grants_external'],
  ])('%s %s mounts %s, which fails closed', (method, path, bucketType) => {
    const limiter = actorLimiterOf(router, method, path)
    expect(limiter.bucketType).toBe(bucketType)
    expect(limiter.onBackendUnavailable).toBe('closed')
  })
})
