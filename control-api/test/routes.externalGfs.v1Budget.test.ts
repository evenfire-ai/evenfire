import { beforeEach, describe, expect, it, vi } from 'vitest'
import express, { type NextFunction, type Request, type Response } from 'express'
import request from 'supertest'

/**
 * X5 (T-W2): the V1 `/external/gfs` plane no longer mounts a request-scoped
 * action execution budget. A V1 request is answered by its handler and the
 * request never carries `accessExecutionBudget`; V2 checks allocate and close
 * their own budget inside `requireWorkflowActionAuthority`.
 */

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  signGfsToken: vi.fn(),
  signCurrentExternalGfsUserToken: vi.fn(),
  query: vi.fn(),
  withTransaction: vi.fn(),
  requireWorkflowActionAuthority: vi.fn(),
}))

vi.mock('../src/services/auth/externalSessionAuthentication.js', () => ({
  authenticateExternalUserSession: (...a: unknown[]) => mocks.authenticate(...a),
}))
vi.mock('../src/auth/gfsToken.js', () => ({
  GFS_DELETE_SCOPE: 'gfs.delete',
  GFS_READ_SCOPE: 'gfs.read',
  GFS_WRITE_SCOPE: 'gfs.write',
  GFS_SCOPES: ['gfs.read', 'gfs.write', 'gfs.delete', 'gfs.manage_acl', 'gfs.share'],
  signGfsToken: (...a: unknown[]) => mocks.signGfsToken(...a),
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
    adminGfsGrantsPerMin: 150,
    adminGfsSharesPerMin: 150,
    adminGfsLegacyGrantReportPerMin: 150,
  },
}))
vi.mock('../src/services/gfsDesktopOperatorLinkService.js', () => ({
  gfsDesktopOperatorLinkService: {
    resolveActiveLink: async () => null,
    isDesktopUserActive: async () => true,
  },
  GfsDesktopOperatorLinkError: class GfsDesktopOperatorLinkError extends Error {},
}))
vi.mock('../src/db.js', () => ({
  pool: { query: (...a: unknown[]) => mocks.query(...a) },
  rateLimitPool: { query: (...a: unknown[]) => mocks.query(...a) },
  withTransaction: (...a: unknown[]) => mocks.withTransaction(...a),
}))
vi.mock('../src/gfs/externalAuthority.js', async importOriginal => {
  const original = await importOriginal<typeof import('../src/gfs/externalAuthority.js')>()
  return {
    ...original,
    signCurrentExternalGfsUserToken: (...args: unknown[]) =>
      mocks.signCurrentExternalGfsUserToken(...args),
  }
})
// grants.ts/shares.ts/token.ts import requireAuthForControlUI, which derives
// the admin JWT key at module load; the Session-JWT plane does not use it.
vi.mock('../src/middleware/controlUIAuth.js', () => ({
  requireAuthForControlUI: (_req: unknown, _res: unknown, next: () => void) => next(),
}))
vi.mock('../src/services/workflows/workflowAuthorityBindingService.js', async importOriginal => {
  const actual =
    await importOriginal<
      typeof import('../src/services/workflows/workflowAuthorityBindingService.js')
    >()
  return {
    ...actual,
    requireWorkflowActionAuthority: (...args: unknown[]) =>
      mocks.requireWorkflowActionAuthority(...args),
  }
})

const userId = '11111111-aaaa-4aaa-8aaa-111111111111'
const session = {
  userId,
  email: 'u1@example.com',
  teamId: '33333333-cccc-4ccc-8ccc-333333333333',
  role: 'member',
  authGeneration: 1,
  exp: Math.floor(Date.now() / 1000) + 3600,
}

beforeEach(() => {
  mocks.authenticate.mockReset().mockResolvedValue({
    status: 'authenticated',
    contract: 'v1',
    claims: session,
    // The authenticated variant always carries its authority context
    // (`services/auth/externalSessionAuthentication.ts`).
    authorityContext: { contract: 'v1', userId },
  })
  mocks.query.mockReset().mockImplementation(async (text: string) => {
    if (text.includes('SELECT lifecycle_state, lifecycle_version')) {
      return { rows: [{ lifecycle_state: 'active', lifecycle_version: 1 }] }
    }
    if (text.includes('rate_limit_buckets')) return { rows: [{ count: 1 }] }
    return { rows: [] }
  })
  mocks.withTransaction
    .mockReset()
    .mockImplementation(async (work: (db: { query: typeof mocks.query }) => Promise<unknown>) =>
      work({ query: mocks.query })
    )
  mocks.signGfsToken
    .mockReset()
    .mockReturnValue({ token: 'synthetic-signed-gfs-token', expiresInSeconds: 300 })
  mocks.signCurrentExternalGfsUserToken
    .mockReset()
    .mockImplementation(async (_authentication: unknown, input: Record<string, unknown>) =>
      mocks.signGfsToken({ ...input, principalType: 'user' })
    )
  mocks.requireWorkflowActionAuthority.mockReset().mockResolvedValue(null)
})

describe('external GFS V1 plane: no request-scoped action budget (T-W2)', () => {
  it('answers a V1 token request without attaching an action execution budget', async () => {
    const { createExternalGfsRouter } = await import('../src/routes/external/gfs.js')
    const { correlationIdMiddleware } = await import('../src/middleware/correlationId.js')
    const finished: Array<{ accessExecutionBudget?: unknown }> = []
    const app = express()
    app.use(express.json())
    app.use(correlationIdMiddleware)
    app.use((req: Request, res: Response, next: NextFunction) => {
      res.on('finish', () => finished.push(req as { accessExecutionBudget?: unknown }))
      next()
    })
    app.use(createExternalGfsRouter(undefined))

    const res = await request(app)
      .post('/external/gfs/token')
      .set('x-user-session-token', 'sess')
      .send({ scopes: ['gfs.read'] })

    // Witness: the V1 token handler answered with its body.
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.token).toBe('synthetic-signed-gfs-token')
    expect(mocks.signGfsToken).toHaveBeenCalledTimes(1)
    expect(finished).toHaveLength(1)
    expect(finished[0]?.accessExecutionBudget).toBeUndefined()
  })
})
