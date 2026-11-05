import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { DatabaseError } from 'pg'
import request from 'supertest'
import { clerumErrorHandler } from '../src/http/errorHandler.js'
import { rootLogger } from '../src/observability/logger.js'
import { createExternalSharedFilesystemsRouter } from '../src/routes/external/sharedFilesystems.js'
import { externalSessionDatabaseFailure } from '../src/services/auth/sessionDatabaseFailure.js'
import { K8sNotFoundError } from '../src/services/resourceService.js'

const mockVerifyExternalSessionToken = vi.fn()
const mockGetUserContexts = vi.fn()
const mockGetTeamContexts = vi.fn()
const mockGetLiveTeamMembership = vi.fn()
const mockSignWfcBrowsingCredential = vi.hoisted(() => vi.fn())
const rateLimitMock = vi.hoisted(() => ({ checkAndIncrement: vi.fn() }))
const mockPoolQuery = vi.hoisted(() => vi.fn())

vi.mock('../src/db.js', () => ({
  pool: { query: (...args: unknown[]) => mockPoolQuery(...args) },
}))

vi.mock('../src/utils/auth/externalSessionAuthToken.js', () => ({
  verifyExternalSessionToken: (...args: unknown[]) => mockVerifyExternalSessionToken(...args),
}))
vi.mock('../src/services/auth/userSessionService.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/services/auth/userSessionService.js')>()
  return {
    ...actual,
    validateLegacyUserSession: vi.fn(async () => ({ status: 'valid', identity: {} })),
  }
})

vi.mock('../src/services/directory/index.js', () => ({
  getUserContexts: (...args: unknown[]) => mockGetUserContexts(...args),
  getTeamContexts: (...args: unknown[]) => mockGetTeamContexts(...args),
}))

vi.mock('../src/services/access/liveTeamAuthorization.js', () => ({
  getLiveTeamMembership: (...args: unknown[]) => mockGetLiveTeamMembership(...args),
}))

vi.mock('../src/utils/auth/wfcBrowsingToken.js', () => ({
  WFC_BROWSING_READ_SCOPE: 'files:read',
  signWfcBrowsingToken: (...args: unknown[]) => mockSignWfcBrowsingCredential(...args),
}))
vi.mock('../src/services/rateLimiterService.js', () => rateLimitMock)

vi.mock('../src/config.js', () => ({
  config: {
    contextsNamespace: 'mcp-server',
    sharedFilesystemsNamespace: 'mcp-host',
    wfcServiceUrlTemplate: 'http://wfc-{hash}.mcp-host.svc:8086',
  },
}))

const SESSION = {
  userId: 'user-1',
  email: 'user@example.com',
  teamId: 'team-1',
  role: 'member' as const,
  authGeneration: 1,
  exp: Math.floor(Date.now() / 1000) + 3600,
}

type GatewayStub = {
  getResource: ReturnType<typeof vi.fn>
  listResource?: ReturnType<typeof vi.fn>
}

function buildApp(gateway: GatewayStub) {
  const app = express()
  app.use(express.json())
  const gatewayWithCatalog = {
    ...gateway,
    listResource:
      gateway.listResource ??
      vi.fn(async (plural: string) =>
        plural === 'contexts'
          ? [
              { metadata: { name: 'ctx-a' }, spec: { contextId: 'ctx-a' } },
              { metadata: { name: 'ctx-team' }, spec: { contextId: 'ctx-team' } },
              { metadata: { name: 'ctx-other' }, spec: { contextId: 'ctx-other' } },
            ]
          : []
      ),
  }
  app.use(createExternalSharedFilesystemsRouter(gatewayWithCatalog as never))
  app.use(clerumErrorHandler)
  return app
}

const warn = vi.spyOn(rootLogger, 'warn').mockImplementation(() => undefined)

// team_members.user_id and team_id are UUID columns: the real live-membership
// read only queries the pool for UUID ids.
const UUID_USER_ID = '1d2e3f4a-5b6c-4d7e-8f9a-0b1c2d3e4f5a'
const UUID_TEAM_ID = '7e6d5c4b-3a29-4f18-8e7d-6c5b4a392817'

/** A server-side error as pg raises it: a DatabaseError carrying a SQLSTATE. */
function databaseError(sqlstate: string): DatabaseError {
  const error = new DatabaseError(`synthetic database failure ${sqlstate}`, 0, 'error')
  error.code = sqlstate
  return error
}

/**
 * Runs the real live-membership read against the mocked pool, so the route's
 * own database-failure classifier decides, and makes only the team_members
 * query fail with `failure`.
 */
async function failLiveMembershipRead(failure: Error): Promise<void> {
  const actual = await vi.importActual<
    typeof import('../src/services/access/liveTeamAuthorization.js')
  >('../src/services/access/liveTeamAuthorization.js')
  mockGetLiveTeamMembership.mockImplementation(actual.getLiveTeamMembership)
  mockVerifyExternalSessionToken.mockReturnValue({
    ...SESSION,
    userId: UUID_USER_ID,
    teamId: UUID_TEAM_ID,
  })
  mockPoolQuery.mockImplementation(async (text: string) => {
    if (text.includes('team_members')) throw failure
    return { rows: [{ lifecycle_state: 'active', lifecycle_version: 1 }] }
  })
}

function expectLiveMembershipReadOnce(): void {
  const membershipReads = mockPoolQuery.mock.calls.filter(([text]) =>
    String(text).includes('team_members')
  )
  expect(membershipReads).toEqual([[expect.any(String), [UUID_USER_ID, UUID_TEAM_ID]]])
}

/** Both outage headers and one warn log naming the event with the outage cause. */
function expectMarkedUnavailable(
  res: request.Response,
  event: string,
  cause: Record<string, unknown>
): void {
  expect(res.headers['retry-after']).toBe('2')
  expect(res.headers['cache-control']).toBe('no-store')
  expect(warn).toHaveBeenCalledOnce()
  expect(warn).toHaveBeenCalledWith(
    expect.objectContaining({ event, err: expect.objectContaining(cause) }),
    'external authority is unavailable'
  )
}

beforeEach(() => {
  warn.mockClear()
  mockVerifyExternalSessionToken.mockReset()
  mockGetUserContexts.mockReset()
  mockGetTeamContexts.mockReset()
  mockGetLiveTeamMembership.mockReset()
  mockGetLiveTeamMembership.mockResolvedValue({ teamId: 'team-1', role: 'member' })
  mockSignWfcBrowsingCredential.mockReset()
  mockPoolQuery.mockReset()
  mockPoolQuery.mockResolvedValue({ rows: [{ lifecycle_state: 'active', lifecycle_version: 1 }] })
  mockSignWfcBrowsingCredential.mockReturnValue({ token: 'browsing-token', expiresInSeconds: 60 })
  rateLimitMock.checkAndIncrement.mockReset()
  rateLimitMock.checkAndIncrement.mockResolvedValue({
    allowed: true,
    count: 1,
    remaining: 29,
    resetMs: Date.now() + 60_000,
    windowStartMs: Date.now(),
    backendAvailable: true,
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

const validAuth = () => {
  mockVerifyExternalSessionToken.mockReturnValue(SESSION)
}

describe('GET /external/contexts/:contextId/shared-filesystems', () => {
  it('preserves context authorization without an added user quota', async () => {
    validAuth()
    mockGetUserContexts.mockResolvedValue({ userId: 'user-1', contextIds: [] })
    mockGetTeamContexts.mockResolvedValue({ teamId: 'team-1', contextIds: [] })
    await request(buildApp({ getResource: vi.fn() }))
      .get('/external/contexts/ctx-a/shared-filesystems')
      .set('x-user-session-token', 'synthetic-session')
      .expect(403)
    expect(mockGetUserContexts).toHaveBeenCalled()
    expect(rateLimitMock.checkAndIncrement).not.toHaveBeenCalled()
  })

  it('returns merged spec+status for an accessible context', async () => {
    validAuth()
    mockGetUserContexts.mockResolvedValue({ userId: 'user-1', contextIds: ['ctx-a'] })
    mockGetTeamContexts.mockResolvedValue({ teamId: 'team-1', contextIds: [] })

    const getResource = vi.fn().mockResolvedValue({
      spec: {
        sharedFileSystems: [
          { name: 'team-mission', mountPath: '/workspace/team-mission' },
          { name: 'runbooks', mountPath: '/workspace/runbooks' },
        ],
      },
      status: {
        sharedFileSystems: [
          {
            name: 'team-mission',
            mountPath: '/workspace/team-mission',
            phase: 'Mounted',
            pvcName: 'pvc-1',
          },
        ],
      },
    })
    const app = buildApp({ getResource })

    const res = await request(app)
      .get('/external/contexts/ctx-a/shared-filesystems')
      .set('x-user-session-token', 'dummy-jwt')

    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      items: [
        {
          name: 'team-mission',
          mountPath: '/workspace/team-mission',
          phase: 'Mounted',
          pvcName: 'pvc-1',
          message: null,
        },
        {
          name: 'runbooks',
          mountPath: '/workspace/runbooks',
          phase: null,
          pvcName: null,
          message: null,
        },
      ],
    })
    expect(getResource).toHaveBeenCalledWith('contexts', 'ctx-a', 'mcp-server')
  })

  it('falls back to team_contexts when user has no direct access', async () => {
    validAuth()
    mockGetUserContexts.mockResolvedValue({ userId: 'user-1', contextIds: [] })
    mockGetTeamContexts.mockResolvedValue({ teamId: 'team-1', contextIds: ['ctx-team'] })
    const getResource = vi.fn().mockResolvedValue({ spec: { sharedFileSystems: [] } })
    const app = buildApp({ getResource })

    const res = await request(app)
      .get('/external/contexts/ctx-team/shared-filesystems')
      .set('x-user-session-token', 'dummy')
    expect(res.status).toBe(200)
    expect(res.body.items).toEqual([])
    expect(mockGetLiveTeamMembership).toHaveBeenCalledWith('user-1', 'team-1', {
      onDatabaseFailure: externalSessionDatabaseFailure,
    })
  })

  it('does not trust a stale v1 team claim after membership revocation', async () => {
    validAuth()
    mockGetUserContexts.mockResolvedValue({ userId: 'user-1', contextIds: [] })
    mockGetLiveTeamMembership.mockResolvedValue(null)
    const getResource = vi.fn()
    const app = buildApp({ getResource })

    await request(app)
      .get('/external/contexts/ctx-team/shared-filesystems')
      .set('x-user-session-token', 'stale-team-token')
      .expect(403)

    expect(mockGetTeamContexts).not.toHaveBeenCalled()
    expect(getResource).not.toHaveBeenCalled()
  })

  it('returns unavailable when a live membership read hits a database outage', async () => {
    const outage = databaseError('08006')
    await failLiveMembershipRead(outage)
    mockGetUserContexts.mockResolvedValue({ userId: UUID_USER_ID, contextIds: [] })
    const getResource = vi.fn()
    const app = buildApp({ getResource })

    const res = await request(app)
      .get('/external/contexts/ctx-team/shared-filesystems')
      .set('x-user-session-token', 'stale-team-token')

    expect(res.status).toBe(503)
    expect(res.body).toEqual({ error: 'authority_unavailable' })
    expectMarkedUnavailable(res, 'external_shared_filesystems_authority_unavailable', {
      name: 'ExternalSessionBackendUnavailableError',
    })
    // The logged cause is the classified outage, which carries the pg error.
    expect(warn.mock.calls[0]?.[0]).toMatchObject({ err: { cause: outage } })
    expectLiveMembershipReadOnce()
    expect(getResource).not.toHaveBeenCalled()
  })

  it('keeps a programmer error from the live membership read on the sanitized 500 path', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    await failLiveMembershipRead(new TypeError('synthetic membership read defect'))
    mockGetUserContexts.mockResolvedValue({ userId: UUID_USER_ID, contextIds: [] })
    const getResource = vi.fn()
    const app = buildApp({ getResource })

    const res = await request(app)
      .get('/external/contexts/ctx-team/shared-filesystems')
      .set('x-user-session-token', 'stale-team-token')

    expect(res.status).toBe(500)
    expect(res.body).toMatchObject({ error: 'Internal Server Error' })
    expect(JSON.stringify(res.body)).not.toContain('synthetic membership read defect')
    expect(res.headers['retry-after']).toBeUndefined()
    expectLiveMembershipReadOnce()
    expect(getResource).not.toHaveBeenCalled()
  })

  it('returns 403 when caller has no access to the context', async () => {
    validAuth()
    mockGetUserContexts.mockResolvedValue({ userId: 'user-1', contextIds: ['ctx-other'] })
    mockGetTeamContexts.mockResolvedValue({ teamId: 'team-1', contextIds: [] })
    const getResource = vi.fn()
    const app = buildApp({ getResource })

    const res = await request(app)
      .get('/external/contexts/ctx-a/shared-filesystems')
      .set('x-user-session-token', 'dummy')
    expect(res.status).toBe(403)
    expect(getResource).not.toHaveBeenCalled()
  })

  it('fails closed when active context reconciliation is unavailable', async () => {
    validAuth()
    mockGetUserContexts.mockResolvedValue({ userId: 'user-1', contextIds: ['ctx-a'] })
    mockGetTeamContexts.mockResolvedValue({ teamId: 'team-1', contextIds: [] })
    const getResource = vi.fn()
    const app = buildApp({
      getResource,
      listResource: vi.fn().mockRejectedValue(new Error('k8s unavailable')),
    })

    const res = await request(app)
      .get('/external/contexts/ctx-a/shared-filesystems')
      .set('x-user-session-token', 'dummy')

    expect(res.status).toBe(503)
    expect(res.body).toEqual({ error: 'context_reconciliation_unavailable' })
    expectMarkedUnavailable(res, 'external_shared_filesystems_context_reconciliation_failed', {
      message: 'k8s unavailable',
    })
    expect(getResource).not.toHaveBeenCalled()
  })

  it('returns 401 without a session token', async () => {
    mockVerifyExternalSessionToken.mockReturnValue(null)
    const app = buildApp({ getResource: vi.fn() })
    const res = await request(app).get('/external/contexts/ctx-a/shared-filesystems')
    expect(res.status).toBe(401)
  })

  it('returns 404 when the context does not exist', async () => {
    validAuth()
    mockGetUserContexts.mockResolvedValue({ userId: 'user-1', contextIds: ['ctx-a'] })
    mockGetTeamContexts.mockResolvedValue({ teamId: 'team-1', contextIds: [] })
    const getResource = vi.fn().mockRejectedValue(new K8sNotFoundError('Context not found'))
    const app = buildApp({ getResource })
    const res = await request(app)
      .get('/external/contexts/ctx-a/shared-filesystems')
      .set('x-user-session-token', 'dummy')
    expect(res.status).toBe(404)
  })

  // #592 CWE-209: the end-user API must NEVER echo a raw status.conditions
  // message — neither the Failed reconcile error NOR the Degraded scheduler/
  // kubelet text (which can carry node names, registry paths, API-server bodies).
  // The message is DERIVED from the phase (curated, fixed strings). Operators
  // still see the raw condition message in the CRD status via admin RBAC.
  it('never echoes raw condition text; derives a curated message from the phase (CWE-209)', async () => {
    validAuth()
    mockGetUserContexts.mockResolvedValue({ userId: 'user-1', contextIds: ['ctx-a'] })
    mockGetTeamContexts.mockResolvedValue({ teamId: 'team-1', contextIds: [] })
    const getResource = vi.fn(async (plural: string, name: string) => {
      if (plural === 'contexts') {
        return {
          spec: {
            sharedFileSystems: [
              { name: 'failed-sfs', mountPath: '/workspace/failed' },
              { name: 'degraded-sfs', mountPath: '/workspace/degraded' },
              { name: 'init-sfs', mountPath: '/workspace/init' },
            ],
          },
        }
      }
      if (plural === 'sharedfilesystems' && name === 'failed-sfs') {
        return {
          status: {
            phase: 'Failed',
            conditions: [
              {
                type: 'Reconciled',
                status: 'False',
                reason: 'ReconcileError',
                message: 'pvc sfs-abc not found in namespace mcp-host at apiserver 10.0.0.1',
              },
            ],
          },
        }
      }
      if (plural === 'sharedfilesystems' && name === 'degraded-sfs') {
        return {
          status: {
            phase: 'Degraded',
            conditions: [
              {
                type: 'Reconciled',
                status: 'False',
                reason: 'PVCUnbound',
                message: 'wfc pod is Unschedulable: volume node affinity conflict on node-7.',
              },
            ],
          },
        }
      }
      if (plural === 'sharedfilesystems' && name === 'init-sfs') {
        return { status: { phase: 'Initializing' } }
      }
      throw new Error(`unexpected getResource ${plural}/${name}`)
    })
    const app = buildApp({ getResource })

    const res = await request(app)
      .get('/external/contexts/ctx-a/shared-filesystems')
      .set('x-user-session-token', 'dummy')

    expect(res.status).toBe(200)
    const items = res.body.items as Array<{
      name: string
      phase: string | null
      message: string | null
    }>
    const failed = items.find(i => i.name === 'failed-sfs')!
    const degraded = items.find(i => i.name === 'degraded-sfs')!
    const init = items.find(i => i.name === 'init-sfs')!
    // Phase is still surfaced (public enum).
    expect(failed.phase).toBe('Failed')
    expect(degraded.phase).toBe('Degraded')
    expect(init.phase).toBe('Initializing')
    // Messages are curated fixed strings — never the raw condition text.
    expect(failed.message).toBe('Storage provisioning failed; contact an administrator.')
    expect(degraded.message).toBe('Storage is degraded; contact an administrator.')
    expect(init.message).toBe('Provisioning storage…')
    // The raw internals (apiserver IP, scheduler/volume text, node name) must NOT leak.
    const allMessages = items.map(i => i.message ?? '').join(' | ')
    expect(allMessages).not.toMatch(
      /10\.0\.0\.1|Unschedulable|volume node affinity|node-7|sfs-abc/i
    )
  })
})

describe('Method gating', () => {
  it('rejects POST/PUT/PATCH/DELETE with 405 even for an accessible context', async () => {
    validAuth()
    mockGetUserContexts.mockResolvedValue({ userId: 'user-1', contextIds: ['ctx-a'] })
    mockGetTeamContexts.mockResolvedValue({ teamId: 'team-1', contextIds: [] })
    const getResource = vi.fn()
    const app = buildApp({ getResource })

    for (const method of ['post', 'put', 'patch', 'delete'] as const) {
      const res = await request(app)
        [method]('/external/contexts/ctx-a/shared-filesystems')
        .set('x-user-session-token', 'dummy')
      expect(res.status).toBe(405)
      expect(res.headers['allow']).toBe('GET, HEAD')
    }
    expect(getResource).not.toHaveBeenCalled()
  })

  it('rejects POST/DELETE on the proxy path too', async () => {
    validAuth()
    mockGetUserContexts.mockResolvedValue({ userId: 'user-1', contextIds: ['ctx-a'] })
    const app = buildApp({ getResource: vi.fn() })

    for (const method of ['post', 'delete'] as const) {
      const res = await request(app)
        [method]('/external/contexts/ctx-a/shared-filesystems/team-mission/proxy/files')
        .set('x-user-session-token', 'dummy')
      expect(res.status).toBe(405)
    }
  })
})

describe('Proxy guard', () => {
  it('rejects proxy paths with encoded traversal before forwarding', async () => {
    validAuth()
    mockGetUserContexts.mockResolvedValue({ userId: 'user-1', contextIds: ['ctx-a'] })
    mockGetTeamContexts.mockResolvedValue({ teamId: 'team-1', contextIds: [] })
    const getResource = vi
      .fn()
      .mockResolvedValueOnce({
        spec: { sharedFileSystems: [{ name: 'attached', mountPath: '/x' }] },
      })
      // SFS must be Ready (#592) to get past the readiness gate and reach the
      // path-traversal guard under test.
      .mockResolvedValueOnce({ metadata: { name: 'attached' }, status: { phase: 'Ready' } })
    const app = buildApp({ getResource })

    const res = await request(app)
      .get('/external/contexts/ctx-a/shared-filesystems/attached/proxy/files/%252e%252e/admin')
      .set('x-user-session-token', 'dummy')

    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'invalid_path' })
  })

  it('returns 503 when the SFS is attached but not Ready (#592)', async () => {
    validAuth()
    mockGetUserContexts.mockResolvedValue({ userId: 'user-1', contextIds: ['ctx-a'] })
    mockGetTeamContexts.mockResolvedValue({ teamId: 'team-1', contextIds: [] })
    const getResource = vi
      .fn()
      .mockResolvedValueOnce({
        spec: { sharedFileSystems: [{ name: 'attached', mountPath: '/x' }] },
      })
      .mockResolvedValueOnce({ metadata: { name: 'attached' }, status: { phase: 'Degraded' } })
    const app = buildApp({ getResource })

    const res = await request(app)
      .get('/external/contexts/ctx-a/shared-filesystems/attached/proxy/files')
      .set('x-user-session-token', 'dummy')
    expect(res.status).toBe(503)
    expect(res.body).toMatchObject({ error: 'sharedfilesystem_not_ready', phase: 'Degraded' })
  })

  it('returns 404 when the requested SFS is not attached to the context', async () => {
    validAuth()
    mockGetUserContexts.mockResolvedValue({ userId: 'user-1', contextIds: ['ctx-a'] })
    mockGetTeamContexts.mockResolvedValue({ teamId: 'team-1', contextIds: [] })
    const getResource = vi.fn().mockResolvedValue({
      spec: { sharedFileSystems: [{ name: 'attached', mountPath: '/x' }] },
    })
    const app = buildApp({ getResource })

    const res = await request(app)
      .get('/external/contexts/ctx-a/shared-filesystems/not-attached/proxy/files')
      .set('x-user-session-token', 'dummy')
    expect(res.status).toBe(404)
  })
})

describe('External SharedFileSystem proxy least privilege', () => {
  it('mints read-only wfc browsing credentials for end-user GET proxy calls', async () => {
    validAuth()
    mockGetUserContexts.mockResolvedValue({ userId: 'user-1', contextIds: ['ctx-a'] })
    mockGetTeamContexts.mockResolvedValue({ teamId: 'team-1', contextIds: [] })
    const getResource = vi
      .fn()
      .mockResolvedValueOnce({
        spec: { sharedFileSystems: [{ name: 'attached', mountPath: '/x' }] },
      })
      .mockResolvedValueOnce({ metadata: { name: 'attached' }, status: { phase: 'Ready' } })
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ ok: true, data: { path: 'docs', entries: [], truncated: false } }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }
      )
    )
    vi.stubGlobal('fetch', fetchMock)
    const app = buildApp({ getResource })

    const res = await request(app)
      .get('/external/contexts/ctx-a/shared-filesystems/attached/proxy/v1/files?path=docs')
      .set('x-user-session-token', 'dummy')

    expect(res.status).toBe(200)
    expect(mockSignWfcBrowsingCredential).toHaveBeenCalledWith({
      subject: 'user@example.com',
      sharedFileSystem: 'attached',
      sharedFileSystemNamespace: 'mcp-host',
      scopes: ['files:read'],
    })
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/v1/files?path=docs'),
      expect.objectContaining({
        method: 'GET',
        headers: { authorization: 'Bearer browsing-token' },
      })
    )
  })
})
