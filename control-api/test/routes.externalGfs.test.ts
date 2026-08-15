import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
// The MOCKED config object (defined below); mutating gfscProxyTimeoutMs drives a
// real deadline abort in the read-proxy timeout test.
import { config } from '../src/config.js'

/**
 * Unit tests for the end-user gfs surface on the /external (Session-JWT) plane.
 * Proves the user path reuses the EXISTING JWT scheme: the token mint calls the
 * existing `signGfsToken` with `sub = users.id`, and delegation flows through the
 * existing `handleGrantWrite` (user caller via resolveCaller, no-escalation via
 * assertMayGrant). No new auth is introduced.
 */

const mockVerifyExternalSessionToken = vi.fn()
const mockSignGfsToken = vi.hoisted(() => vi.fn())
const mockQuery = vi.hoisted(() => vi.fn())
const mockAppendPermissionEvents = vi.hoisted(() => vi.fn())
const mockWithTransaction = vi.hoisted(() => vi.fn())
const mockResolveActiveLink = vi.hoisted(() => vi.fn())
const mockIsDesktopUserActive = vi.hoisted(() => vi.fn())

vi.mock('../src/utils/auth/externalSessionAuthToken.js', () => ({
  verifyExternalSessionToken: (...a: unknown[]) => mockVerifyExternalSessionToken(...a),
}))
vi.mock('../src/auth/gfsToken.js', () => ({
  GFS_DELETE_SCOPE: 'gfs.delete',
  GFS_READ_SCOPE: 'gfs.read',
  GFS_WRITE_SCOPE: 'gfs.write',
  GFS_SCOPES: ['gfs.read', 'gfs.write', 'gfs.delete', 'gfs.manage_acl', 'gfs.share'],
  signGfsToken: (...a: unknown[]) => mockSignGfsToken(...a),
}))
vi.mock('../src/config.js', () => ({
  config: {
    gfscBaseUrl: 'http://gfsc.gfs.svc:8087',
    gfscWriteBaseUrl: 'http://gfsc-writer.gfs.svc:8087',
    gfscProxyTimeoutMs: 300_000,
    gfsUploadMaxPartBytes: 16 * 1024 * 1024,
    // The eligibility guard maps caller agent names to 1st:<hostsNamespace>/<name>.
    hostsNamespace: 'mcp-host',
    desktopGfsOperatorLinkingEnabled: false,
    externalGfsIngressRlPerMin: 1800,
    externalGfsTokenUserRlPerMin: 10,
    externalGfsTokenIpRlPerMin: 600,
    externalGfsIpRlPerMin: 1200,
    externalGfsReadRlPerMin: 120,
    externalGfsOperationRlPerMin: 30,
  },
}))
vi.mock('../src/services/gfsDesktopOperatorLinkService.js', () => ({
  gfsDesktopOperatorLinkService: {
    resolveActiveLink: (...a: unknown[]) => mockResolveActiveLink(...a),
    isDesktopUserActive: (...a: unknown[]) => mockIsDesktopUserActive(...a),
  },
  GfsDesktopOperatorLinkError: class GfsDesktopOperatorLinkError extends Error {
    constructor(
      readonly code: string,
      message: string
    ) {
      super(message)
    }
  },
}))
vi.mock('../src/middleware/gfsUploadAdmission.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/middleware/gfsUploadAdmission.js')>()
  return {
    ...actual,
    gfsUploadAdmission: (
      req: { headers: Record<string, unknown>; gfsUploadDeclaredBytes?: number },
      _res: unknown,
      next: () => void
    ) => {
      const value = Number(req.headers['content-length'])
      if (Number.isSafeInteger(value) && value > 0) req.gfsUploadDeclaredBytes = value
      next()
    },
  }
})
vi.mock('../src/db.js', () => ({
  pool: { query: (...a: unknown[]) => mockQuery(...a) },
  withTransaction: (...a: unknown[]) => mockWithTransaction(...a),
}))
vi.mock('../src/services/tracing/controlApiPermissionEvents.js', () => ({
  appendControlApiPermissionEventsInTransaction: (...a: unknown[]) =>
    mockAppendPermissionEvents(...a),
}))
// grants.ts/shares.ts/token.ts import requireAuthForControlUI, which at module
// load derives the admin JWT key — irrelevant to the /external (Session-JWT)
// surface and unused by these routes. Stub it so the import chain is key-free.
vi.mock('../src/middleware/controlUIAuth.js', () => ({
  requireAuthForControlUI: (_req: unknown, _res: unknown, next: () => void) => next(),
}))

// user/team subject ids are real UUIDs (validated by parseSubject); the caller
// session + delegation target use valid UUIDs so the fixtures match production.
const U1 = '11111111-aaaa-4aaa-8aaa-111111111111'
const U2 = '22222222-bbbb-4bbb-8bbb-222222222222'
const T1 = '33333333-cccc-4ccc-8ccc-333333333333'
const T2 = '44444444-dddd-4ddd-8ddd-444444444444'
const H1 = '1st:mcp-host/agent-a'
const CORRELATION_ID = '55555555-eeee-4eee-8eee-555555555555'
const SESSION = {
  userId: U1,
  email: 'u@example.com',
  teamId: T1,
  role: 'member' as const,
  authGeneration: 1,
  exp: Math.floor(Date.now() / 1000) + 3600,
}
const R = '11111111-1111-1111-1111-111111111111'
const R2 = '22222222-2222-2222-2222-222222222222'
const R_RID = R.replace(/-/g, '')
const CONTROL_ADMIN_ID = '66666666-eeee-4eee-8eee-666666666666'
const REQUEST_ID = '77777777-eeee-4eee-8eee-777777777777'
const ACTIVE_LINK = {
  desktopUserId: U1,
  controlAdminId: CONTROL_ADMIN_ID,
  source: 'initial_setup' as const,
  lineageId: '88888888-eeee-4eee-8eee-888888888888',
  generation: 1,
  desktopUserGeneration: 1,
  controlAdminGeneration: 1,
  createdAt: new Date('2026-08-10T00:00:00.000Z'),
}

async function buildApp() {
  const { createExternalGfsRouter } = await import('../src/routes/external/gfs.js')
  const { correlationIdMiddleware } = await import('../src/middleware/correlationId.js')
  const app = express()
  app.use(express.json())
  app.use(correlationIdMiddleware)
  app.use(createExternalGfsRouter())
  return app
}

async function buildOperatorShareApp() {
  const { registerGfsShareRoutes } = await import('../src/routes/gfs/shares.js')
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    ;(req as typeof req & { adminAuth: { sub: string } }).adminAuth = {
      sub: 'operator-share-test',
    }
    next()
  })
  const router = express.Router()
  registerGfsShareRoutes(router)
  app.use(router)
  return app
}

// Admin (Control UI) grants plane — the SAME grant surface the external plane
// reuses, but mounted behind its OWN operator rate limiter (bucketType
// `gfs_grants`, key `gfsgrants:<sub>`). Used to prove the two planes never share
// a rate-limit bucket for the same subject id.
async function buildAdminGrantsApp(sub: string) {
  const { registerGfsGrantRoutes } = await import('../src/routes/gfs/grants.js')
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    ;(req as typeof req & { adminAuth: { sub: string } }).adminAuth = { sub }
    next()
  })
  const router = express.Router()
  registerGfsGrantRoutes(router)
  app.use(router)
  return app
}

beforeEach(() => {
  mockVerifyExternalSessionToken.mockReset()
  mockSignGfsToken.mockReset()
  mockQuery.mockReset()
  mockAppendPermissionEvents.mockReset()
  mockWithTransaction.mockReset()
  mockResolveActiveLink.mockReset()
  mockIsDesktopUserActive.mockReset()
  mockResolveActiveLink.mockResolvedValue(null)
  mockIsDesktopUserActive.mockResolvedValue(true)
  mockQuery.mockImplementation(async (text: string) => {
    if (text.includes('SELECT lifecycle_state, lifecycle_version')) {
      return { rows: [{ lifecycle_state: 'active', lifecycle_version: 1 }] }
    }
    return { rows: [] }
  })
  mockWithTransaction.mockImplementation(
    async (work: (db: { query: typeof mockQuery }) => Promise<unknown>) =>
      work({ query: mockQuery })
  )
  mockAppendPermissionEvents.mockResolvedValue(null)
  mockSignGfsToken.mockReturnValue({ token: 'gfs-user-token', expiresInSeconds: 300 })
  ;(config as { gfscProxyTimeoutMs: number }).gfscProxyTimeoutMs = 300_000
  ;(config as { desktopGfsOperatorLinkingEnabled: boolean }).desktopGfsOperatorLinkingEnabled =
    false
})
afterEach(() => vi.unstubAllGlobals())

const auth = () => mockVerifyExternalSessionToken.mockReturnValue(SESSION)

function activeSessionLifecycleResult(
  text: string
): { rows: [{ lifecycle_state: string; lifecycle_version: number }] } | null {
  return text.includes('SELECT lifecycle_state, lifecycle_version')
    ? { rows: [{ lifecycle_state: 'active', lifecycle_version: 1 }] }
    : null
}

function combinedAuthorityRow(
  grants: Record<string, unknown>[],
  values?: unknown[]
): { rows: Array<{ ancestors: string[]; grants: Record<string, unknown>[]; shares: never[] }> } {
  const subjectTypes = (values?.[2] as string[]) ?? []
  const subjectIds = (values?.[3] as string[]) ?? []
  const wanted = new Set(subjectTypes.map((type, i) => `${type}:${subjectIds[i] ?? ''}`))
  return {
    rows: [
      {
        ancestors: [String(values?.[1])],
        grants: grants.filter(grant =>
          wanted.has(`${String(grant.subject_type)}:${String(grant.subject_id ?? '')}`)
        ),
        shares: [],
      },
    ],
  }
}

/** Route the grant engine's queries by SQL shape. */
function dbReturning(
  grants: Record<string, unknown>[],
  opts: {
    callerAgentNames?: string[]
    grantListRows?: Record<string, unknown>[]
    rateLimitCount?: number
  } = {}
) {
  // The external-plane eligibility guard resolves the caller's own agents via
  // getUserAgents (user_agents table). Default matches H1's name so existing
  // host-grant fixtures represent an in-directory agent.
  const callerAgentNames = opts.callerAgentNames ?? ['agent-a']
  mockQuery.mockImplementation(async (text: string, values?: unknown[]) => {
    const lifecycle = activeSessionLifecycleResult(text)
    if (lifecycle) return lifecycle
    if (text.includes('FROM user_agents')) {
      return { rows: callerAgentNames.map(name => ({ agent_name: name })) }
    }
    if (text.includes('rate_limit_buckets')) {
      return { rows: [{ count: opts.rateLimitCount ?? 1 }] }
    }
    if (text.includes('ORDER BY created_at ASC, id ASC')) {
      return { rows: opts.grantListRows ?? [] }
    }
    if (text.includes('authority_grants AS') && text.includes('authority_shares AS')) {
      return combinedAuthorityRow(grants, values)
    }
    if (text.includes('WITH RECURSIVE chain'))
      return { rows: [{ resource_id: String(values?.[1]) }] }
    if (text.includes('FROM gfs_grants')) {
      // Faithfully model the SQL subject filter on subject_type + subject_id.
      const subjectTypes = (values?.[1] as string[]) ?? []
      const subjectIds = (values?.[2] as string[]) ?? []
      const wanted = new Set(subjectTypes.map((type, i) => `${type}:${subjectIds[i] ?? ''}`))
      return {
        rows: grants.filter(g =>
          wanted.has(`${String(g.subject_type)}:${String(g.subject_id ?? '')}`)
        ),
      }
    }
    if (text.includes('FROM gfs_shares')) return { rows: [] }
    if (text.includes('INSERT INTO gfs_grants')) return { rows: [] }
    if (text.includes('INSERT INTO gfs_audit')) return { rows: [{ id: 'audit-1' }] }
    return { rows: [] }
  })
}

describe('POST /external/gfs/token (user mint — existing signer, sub=users.id)', () => {
  it('allows a mixed GFS journey beyond the former 30/min ingress cap', async () => {
    auth()
    const app = await buildApp()

    for (let attempt = 0; attempt < 31; attempt += 1) {
      const response = await request(app)
        .post('/external/gfs/not-classified')
        .set('x-user-session-token', 'sess')
      expect(response.status).toBe(404)
    }

    expect(mockVerifyExternalSessionToken).toHaveBeenCalledTimes(31)
    expect(mockResolveActiveLink).not.toHaveBeenCalled()
    expect(mockQuery.mock.calls).toHaveLength(31)
    expect(mockQuery.mock.calls.every(call => String(call[0]).includes('lifecycle_state'))).toBe(
      true
    )
  })

  it('enforces the configurable ingress backstop before session or authority work', async () => {
    const previousIngressLimit = (config as { externalGfsIngressRlPerMin: number })
      .externalGfsIngressRlPerMin
    ;(config as { externalGfsIngressRlPerMin: number }).externalGfsIngressRlPerMin = 3
    try {
      auth()
      const app = await buildApp()

      for (let attempt = 0; attempt < 3; attempt += 1) {
        const response = await request(app)
          .post('/external/gfs/not-classified')
          .set('x-user-session-token', 'sess')
        expect(response.status).toBe(404)
      }

      const exhausted = await request(app)
        .post('/external/gfs/not-classified')
        .set('x-user-session-token', 'sess')

      expect(exhausted.status).toBe(429)
      expect(mockVerifyExternalSessionToken).toHaveBeenCalledTimes(3)
      expect(mockResolveActiveLink).not.toHaveBeenCalled()
      expect(mockQuery.mock.calls).toHaveLength(3)
      expect(mockQuery.mock.calls.every(call => String(call[0]).includes('lifecycle_state'))).toBe(
        true
      )
    } finally {
      ;(config as { externalGfsIngressRlPerMin: number }).externalGfsIngressRlPerMin =
        previousIngressLimit
    }
  })

  it('enforces the recognised 10/min token route limit per authenticated user', async () => {
    auth()
    const app = await buildApp()

    for (let attempt = 0; attempt < 10; attempt += 1) {
      await request(app)
        .post('/external/gfs/token')
        .set('x-user-session-token', 'sess')
        .send({})
        .expect(200)
    }

    const exhausted = await request(app)
      .post('/external/gfs/token')
      .set('x-user-session-token', 'sess')
      .send({})

    expect(exhausted.status).toBe(429)
    expect(mockSignGfsToken).toHaveBeenCalledTimes(10)
  })

  it('uses the dedicated 120/min read route ceiling without widening mutation ceilings', async () => {
    const previousReadLimit = (config as { externalGfsReadRlPerMin: number })
      .externalGfsReadRlPerMin
    const previousOperationLimit = (config as { externalGfsOperationRlPerMin: number })
      .externalGfsOperationRlPerMin
    ;(config as { externalGfsReadRlPerMin: number }).externalGfsReadRlPerMin = 2
    ;(config as { externalGfsOperationRlPerMin: number }).externalGfsOperationRlPerMin = 2
    try {
      auth()
      dbReturning([])
      const app = await buildApp()

      for (let attempt = 0; attempt < 2; attempt += 1) {
        await request(app)
          .get('/external/gfs/resources')
          .set('x-user-session-token', 'read-session')
          .expect(200)
      }
      const exhaustedRead = await request(app)
        .get('/external/gfs/resources')
        .set('x-user-session-token', 'read-session')
      expect(exhaustedRead.status).toBe(429)
      expect(
        exhaustedRead.headers['ratelimit-limit'] ?? exhaustedRead.headers['x-ratelimit-limit']
      ).toBe('2')

      // A mutation has its own class budget; exhausting reads must not consume it.
      const mutation = await request(app)
        .patch(`/external/gfs/resources/${R}`)
        .set('x-user-session-token', 'mutation-0')
        .send({ name: 'rename' })
      expect(mutation.status).not.toBe(429)
    } finally {
      ;(config as { externalGfsReadRlPerMin: number }).externalGfsReadRlPerMin = previousReadLimit
      ;(config as { externalGfsOperationRlPerMin: number }).externalGfsOperationRlPerMin =
        previousOperationLimit
    }
  })

  it('mints a gfs token for the user with the EXISTING signGfsToken (sub=users.id)', async () => {
    auth()
    const app = await buildApp()
    const res = await request(app)
      .post('/external/gfs/token')
      .set('x-user-session-token', 'sess')
      .send({ scopes: ['gfs.read', 'gfs.write'] })
    expect(res.status).toBe(200)
    expect(res.body.token).toBe('gfs-user-token')
    expect(mockSignGfsToken).toHaveBeenCalledWith({
      subject: U1,
      drive: 'main',
      scopes: ['gfs.read', 'gfs.write'],
      pathBindings: [],
      authGeneration: 1,
      principalType: 'user',
    })
  })

  it('denies token minting for a retired Desktop user before signing a user-plane token', async () => {
    auth()
    mockIsDesktopUserActive.mockResolvedValue(false)
    const app = await buildApp()

    const res = await request(app)
      .post('/external/gfs/token')
      .set('x-user-session-token', 'sess')
      .send({})

    expect(res.status).toBe(403)
    expect(res.body).toEqual({ error: 'desktop_user_retired' })
    expect(mockSignGfsToken).not.toHaveBeenCalled()
  })

  it('defaults to gfs.read when no scopes requested', async () => {
    auth()
    const app = await buildApp()
    const res = await request(app)
      .post('/external/gfs/token')
      .set('x-user-session-token', 'sess')
      .send({})
    expect(res.status).toBe(200)
    expect(mockSignGfsToken.mock.calls[0][0].scopes).toEqual(['gfs.read'])
  })

  it('rejects invalid scopes with 400 (no token minted)', async () => {
    auth()
    const app = await buildApp()
    const res = await request(app)
      .post('/external/gfs/token')
      .set('x-user-session-token', 'sess')
      .send({ scopes: ['gfs.bogus'] })
    expect(res.status).toBe(400)
    expect(mockSignGfsToken).not.toHaveBeenCalled()
  })

  it('401 without a session token (Session-JWT plane gate)', async () => {
    mockVerifyExternalSessionToken.mockReturnValue(null)
    const app = await buildApp()
    const res = await request(app).post('/external/gfs/token').send({})
    expect(res.status).toBe(401)
  })

  it('stays user-only and never resolves linked authority even when linking is enabled', async () => {
    auth()
    ;(config as { desktopGfsOperatorLinkingEnabled: boolean }).desktopGfsOperatorLinkingEnabled =
      true
    mockResolveActiveLink.mockResolvedValue(ACTIVE_LINK)

    const res = await request(await buildApp())
      .post('/external/gfs/token')
      .set('x-user-session-token', 'sess')
      .send({ scopes: ['gfs.read'] })

    expect(res.status).toBe(200)
    expect(mockResolveActiveLink).not.toHaveBeenCalled()
    expect(mockSignGfsToken).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: U1,
        principalType: 'user',
      })
    )
    expect(mockSignGfsToken.mock.calls[0]?.[0]).not.toHaveProperty('brokeredAuthority')
  })
})

describe('linked Desktop operator authority contract', () => {
  function linked(): void {
    auth()
    ;(config as { desktopGfsOperatorLinkingEnabled: boolean }).desktopGfsOperatorLinkingEnabled =
      true
    mockResolveActiveLink.mockResolvedValue(ACTIVE_LINK)
  }

  it('mints only an internal effective-admin token and forwards the same request id to gfsc', async () => {
    linked()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ok: true, data: { resourceId: R } }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        })
      )
    )

    const res = await request(await buildApp())
      .post(`/external/gfs/resources/${R}/children?drive=main`)
      .set('x-user-session-token', 'sess')
      .set('x-request-id', REQUEST_ID)
      .send({ name: 'operator-folder', kind: 'directory' })

    expect(res.status).toBe(201)
    expect(res.headers['x-request-id']).toBe(REQUEST_ID)
    expect(mockSignGfsToken).toHaveBeenCalledWith({
      subject: CONTROL_ADMIN_ID,
      drive: 'main',
      scopes: ['gfs.write'],
      authGeneration: 1,
      principalType: 'control-admin',
      brokeredAuthority: {
        desktopUserId: U1,
        controlAdminId: CONTROL_ADMIN_ID,
        authoritySource: 'linked-admin',
        linkLineageId: ACTIVE_LINK.lineageId,
        linkGeneration: ACTIVE_LINK.generation,
        desktopUserGeneration: ACTIVE_LINK.desktopUserGeneration,
      },
    })
    const fetchOptions = (vi.mocked(fetch).mock.calls[0]?.[1] ?? {}) as RequestInit
    expect(new Headers(fetchOptions.headers).get('x-request-id')).toBe(REQUEST_ID)
  })

  it('uses the existing root tree primitive for a full operator root view', async () => {
    linked()
    mockQuery.mockImplementation(async (text: string) => {
      const lifecycle = activeSessionLifecycleResult(text)
      if (lifecycle) return lifecycle
      if (text.includes('parent_resource_id IS NULL')) {
        return {
          rows: [{ resource_id: R, drive: 'main', name: '', kind: 'directory', path_cache: '/' }],
        }
      }
      if (text.includes('parent_resource_id = $2::uuid')) {
        return {
          rows: [
            {
              resource_id: R2,
              name: 'all-operator-visible',
              kind: 'directory',
              path_cache: '/all-operator-visible',
              bytes: 0,
              version: 1,
            },
          ],
        }
      }
      return { rows: [] }
    })

    const res = await request(await buildApp())
      .get('/external/gfs/resources?drive=main')
      .set('x-user-session-token', 'sess')

    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      ok: true,
      data: {
        items: [expect.objectContaining({ resourceId: R2, name: 'all-operator-visible' })],
        nextCursor: null,
        rootResourceId: R,
        view: 'operator',
      },
    })
    expect(mockQuery.mock.calls.some(call => String(call[0]).includes('team_members'))).toBe(false)
  })

  it('persists Desktop actor, effective admin, authority source, and request id separately', async () => {
    linked()
    dbReturning([])

    const res = await request(await buildApp())
      .put('/external/gfs/grants')
      .set('x-user-session-token', 'sess')
      .set('x-request-id', REQUEST_ID)
      .send({
        resourceId: R,
        subject: { type: 'user', id: U2 },
        permissions: ['read'],
        inherit: false,
      })

    expect(res.status).toBe(200)
    const audit = mockQuery.mock.calls.find(call =>
      String(call[0]).includes('INSERT INTO gfs_audit')
    )
    expect(audit?.[1]).toEqual([
      `user:${U2}`,
      CONTROL_ADMIN_ID,
      'grant.put[read]',
      `gfs://main/${R}`,
      'allowed',
      expect.anything(),
      REQUEST_ID,
      expect.stringMatching(/^[0-9a-f]{64}$/),
      U1,
      'linked-admin',
    ])
    expect(mockAppendPermissionEvents).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ operatorKind: 'control_admin', operatorSub: CONTROL_ADMIN_ID })
    )
  })

  it.each([
    ['get', '/external/gfs/resources'],
    ['get', '/external/gfs/resolve?uri=gfs%3A%2F%2Fmain%2Ffoo'],
    ['get', `/external/gfs/resources/${R}/children`],
    ['get', `/external/gfs/resources/${R}/affordances`],
    ['get', `/external/gfs/proxy/${R}`],
    ['get', `/external/gfs/grants?drive=main&resourceId=${R}`],
    ['put', '/external/gfs/grants'],
    ['delete', `/external/gfs/grants/${R}`],
    ['get', `/external/gfs/shares?drive=main&resourceId=${R}`],
    ['post', '/external/gfs/shares'],
    ['delete', `/external/gfs/shares/${R}`],
    ['patch', `/external/gfs/resources/${R}`],
    ['post', `/external/gfs/resources/${R}/children`],
    ['put', `/external/gfs/resources/${R}/content`],
    ['delete', `/external/gfs/resources/${R}`],
  ] as const)('fails closed before route-specific work for %s %s', async (method, path) => {
    auth()
    ;(config as { desktopGfsOperatorLinkingEnabled: boolean }).desktopGfsOperatorLinkingEnabled =
      true
    const { GfsDesktopOperatorLinkError } =
      await import('../src/services/gfsDesktopOperatorLinkService.js')
    mockResolveActiveLink.mockRejectedValue(
      new GfsDesktopOperatorLinkError('control_admin_inactive', 'sensitive state')
    )

    const res = await request(await buildApp())
      [method](path)
      .set('x-user-session-token', 'sess')
      .send({})

    expect(res.status).toBe(403)
    expect(res.body).toEqual({ error: 'gfs_operator_link_invalid' })
    // The boundary rate limiter is deliberately the only DB-backed work that
    // precedes the authority resolver. A resolver failure must not invoke a
    // route handler or any of its database queries.
    expect(
      mockQuery.mock.calls.every(call => /rate_limit_buckets|lifecycle_state/.test(String(call[0])))
    ).toBe(true)
    expect(mockSignGfsToken).not.toHaveBeenCalled()
  })

  it('returns 404 for an unclassified GFS path without resolving authority', async () => {
    auth()
    ;(config as { desktopGfsOperatorLinkingEnabled: boolean }).desktopGfsOperatorLinkingEnabled =
      true
    mockResolveActiveLink.mockResolvedValue(ACTIVE_LINK)

    const res = await request(await buildApp())
      .post('/external/gfs/not-classified')
      .set('x-user-session-token', 'sess')
      .send({})

    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'Not Found' })
    expect(mockResolveActiveLink).not.toHaveBeenCalled()
    expect(mockQuery.mock.calls).toHaveLength(1)
    expect(mockQuery.mock.calls[0]?.[0]).toContain('lifecycle_state')
  })

  it('returns a bounded retry body and header when the express edge backstop is exhausted', async () => {
    const previous = config.externalGfsIngressRlPerMin
    config.externalGfsIngressRlPerMin = 1
    try {
      auth()
      const app = await buildApp()
      await request(app)
        .get('/external/gfs/not-classified')
        .set('x-user-session-token', 'sess')
        .expect(404)
      const res = await request(app)
        .get('/external/gfs/not-classified')
        .set('x-user-session-token', 'sess')
      expect(res.status).toBe(429)
      expect(res.headers['retry-after']).toMatch(/^\d+$/)
      expect(res.body).toEqual({
        error: 'Too Many Requests',
        retryAfterSeconds: expect.any(Number),
      })
    } finally {
      config.externalGfsIngressRlPerMin = previous
    }
  })

  it('rejects a pre-resolution rate limit before resolver or route work', async () => {
    auth()
    ;(config as { desktopGfsOperatorLinkingEnabled: boolean }).desktopGfsOperatorLinkingEnabled =
      true
    mockResolveActiveLink.mockResolvedValue(ACTIVE_LINK)
    mockQuery.mockImplementation(async (text: string) => {
      const lifecycle = activeSessionLifecycleResult(text)
      if (lifecycle) return lifecycle
      if (text.includes('rate_limit_buckets')) return { rows: [{ count: 121 }] }
      throw new Error(`unexpected route query: ${text}`)
    })

    const res = await request(await buildApp())
      .get('/external/gfs/resources')
      .set('x-user-session-token', 'sess')

    expect(res.status).toBe(429)
    expect(res.body.error).toBe('Too Many Requests')
    expect(res.headers['x-ratelimit-limit']).toBe('120')
    expect(mockResolveActiveLink).not.toHaveBeenCalled()
    expect(mockSignGfsToken).not.toHaveBeenCalled()
    expect(mockQuery.mock.calls).toHaveLength(2)
    expect(mockQuery.mock.calls[0]?.[0]).toContain('lifecycle_state')
    expect(mockQuery.mock.calls[1]?.[1]?.[0]).toMatch(/^gfs-ext:pre:resource:session:[0-9a-f]{64}$/)
  })

  it('does not resolve or elevate when the feature flag is off', async () => {
    auth()
    mockResolveActiveLink.mockResolvedValue(ACTIVE_LINK)
    mockQuery.mockImplementation(
      async (text: string) => activeSessionLifecycleResult(text) ?? { rows: [] }
    )

    const res = await request(await buildApp())
      .get('/external/gfs/resources')
      .set('x-user-session-token', 'sess')

    expect(res.status).toBe(200)
    expect(res.body.data).toEqual({ items: [], nextCursor: null })
    expect(mockResolveActiveLink).not.toHaveBeenCalled()
  })
})

describe('indexed upload relay canonical drive', () => {
  it('allows a drive-independent capability probe while still rejecting mismatched creates', async () => {
    auth()
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ upload: { resumableV2: { enabled: true } } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
    )
    vi.stubGlobal('fetch', fetchMock)
    const app = await buildApp()
    const nested = (app as any)._router?.stack?.find((layer: any) => layer.name === 'router')

    const missing = await request(app)
      .get('/external/gfs/capabilities')
      .set('x-user-session-token', 'sess')
    const mismatched = await request(app)
      .post('/external/gfs/uploads?drive=archive')
      .set('x-user-session-token', 'sess')
      .send({ drive: 'main', operation: 'create' })


    expect(missing.status).toBe(200)
    expect(missing.body).toMatchObject({ upload: { resumableV2: { enabled: true } } })
    expect(mismatched.status).toBe(400)
    expect(mismatched.body).toEqual({ error: 'drive_mismatch' })
    expect(mockSignGfsToken).toHaveBeenCalledWith({
      subject: U1,
      drive: 'main',
      scopes: ['gfs.write'],
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('rejects malformed canonical drive values before admission or token minting', async () => {
    auth()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const malformed = ['', ' archive', 'archive ', '\tarchive', 'archive\n']

    for (const drive of malformed) {
      const app = await buildApp()
      const response = await request(app)
        .get(`/external/gfs/capabilities?drive=${encodeURIComponent(drive)}`)
        .set('x-user-session-token', 'sess')
      expect(response.status).toBe(400)
      expect(response.body).toEqual({ error: 'drive_invalid' })
    }

    const arrayValue = await request(await buildApp())
      .get('/external/gfs/capabilities?drive=archive&drive=main')
      .set('x-user-session-token', 'sess')
    expect(arrayValue.status).toBe(400)
    expect(arrayValue.body).toEqual({ error: 'drive_invalid' })
  })

  it('signs and forwards every lifecycle request from one non-main canonical drive', async () => {
    auth()
    const uploadId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      if (init.body && typeof init.body !== 'string') {
        for await (const _chunk of init.body as unknown as AsyncIterable<Uint8Array>) {
          /* drain the streaming part */
        }
      }
      return new Response(JSON.stringify({ ok: true, data: { drive: 'archive' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    const app = await buildApp()
    const withAuth = (builder: request.Test) => builder.set('x-user-session-token', 'sess')

    await withAuth(request(app).get('/external/gfs/capabilities?drive=archive')).expect(200)
    await withAuth(request(app).post('/external/gfs/uploads?drive=archive'))
      .send({ drive: 'archive', operation: 'create' })
      .expect(200)
    await withAuth(request(app).head(`/external/gfs/uploads/${uploadId}?drive=archive`)).expect(200)
    await withAuth(
      request(app).get(`/external/gfs/uploads/${uploadId}/status?drive=archive&limit=256`)
    ).expect(200)
    await withAuth(
      request(app)
        .put(`/external/gfs/uploads/${uploadId}/parts/0?drive=archive`)
        .set('content-type', 'application/offset+octet-stream')
        .set('upload-part-number', '0')
        .set('upload-offset', '0')
        .set('upload-chunk-length', '4')
        .set('upload-checksum', 'sha256 dGVzdA==')
    )
      .send(Buffer.from('test'))
      .expect(200)
    for (const action of ['pause', 'resume', 'complete']) {
      await withAuth(request(app).post(`/external/gfs/uploads/${uploadId}/${action}?drive=archive`))
        .send({})
        .expect(200)
    }
    await withAuth(request(app).delete(`/external/gfs/uploads/${uploadId}?drive=archive`)).expect(
      200
    )

    expect(fetchMock).toHaveBeenCalledTimes(9)
    expect(mockSignGfsToken).toHaveBeenCalledTimes(9)
    for (const [input] of mockSignGfsToken.mock.calls) {
      expect(input).toEqual({ subject: U1, drive: 'archive', scopes: ['gfs.write'] })
    }
    expect(fetchMock.mock.calls.map(call => String(call[0]))).toEqual([
      'http://gfsc-writer.gfs.svc:8087/v1/capabilities',
      'http://gfsc-writer.gfs.svc:8087/v1/uploads',
      `http://gfsc-writer.gfs.svc:8087/v1/uploads/${uploadId}`,
      `http://gfsc-writer.gfs.svc:8087/v1/uploads/${uploadId}/status?limit=256`,
      `http://gfsc-writer.gfs.svc:8087/v1/uploads/${uploadId}/parts/0`,
      `http://gfsc-writer.gfs.svc:8087/v1/uploads/${uploadId}/pause`,
      `http://gfsc-writer.gfs.svc:8087/v1/uploads/${uploadId}/resume`,
      `http://gfsc-writer.gfs.svc:8087/v1/uploads/${uploadId}/complete`,
      `http://gfsc-writer.gfs.svc:8087/v1/uploads/${uploadId}`,
    ])
  })
})

describe('PUT /external/gfs/grants (user delegation via existing engine)', () => {
  it('honors a user-session grant when the caller holds manage_acl (no-escalation OK)', async () => {
    auth()
    // The user holds manage_acl + read on R directly → may grant read.
    dbReturning([
      {
        subject_type: 'user',
        subject_id: U1,
        resource_id: R,
        permissions: ['manage_acl', 'read'],
        inherit: false,
      },
    ])
    const app = await buildApp()
    const res = await request(app)
      .put('/external/gfs/grants')
      .set('x-user-session-token', 'sess')
      .send({
        resourceId: R,
        subject: { type: 'user', id: U2 },
        permissions: ['read'],
        inherit: false,
      })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    // The INSERT recorded the caller as the user (granted_by user:user-1).
    const insert = mockQuery.mock.calls.find(c => String(c[0]).includes('INSERT INTO gfs_grants'))
    expect(insert?.[1]?.[6]).toBe(`user:${U1}`)
    const audit = mockQuery.mock.calls.find(c => String(c[0]).includes('INSERT INTO gfs_audit'))
    expect(audit?.[1]?.[1]).toBeNull()
    expect(audit?.[1]?.[8]).toBe(U1)
    expect(audit?.[1]?.[9]).toBe('user-session')
    expect(mockAppendPermissionEvents).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        operatorSub: U1,
        operatorKind: 'platform_user',
        changes: [
          expect.objectContaining({
            action: 'grant',
            resourceClass: 'gfs_folder_grant',
            outcome: 'committed',
          }),
        ],
      })
    )
  })

  it('honors grants held through any active team, not only the session teamId', async () => {
    auth()
    const teamGrants = [
      {
        subject_type: 'team',
        subject_id: T2,
        resource_id: R,
        permissions: ['manage_acl', 'read'],
        inherit: false,
      },
    ]
    mockQuery.mockImplementation(async (text: string, values?: unknown[]) => {
      const lifecycle = activeSessionLifecycleResult(text)
      if (lifecycle) return lifecycle
      if (text.includes('FROM team_members')) return { rows: [{ team_id: T2 }] }
      if (text.includes('authority_grants AS') && text.includes('authority_shares AS')) {
        return combinedAuthorityRow(teamGrants, values)
      }
      if (text.includes('WITH RECURSIVE chain'))
        return { rows: [{ resource_id: String(values?.[1]) }] }
      if (text.includes('FROM gfs_grants')) {
        const subjectTypes = (values?.[1] as string[]) ?? []
        const subjectIds = (values?.[2] as string[]) ?? []
        const wanted = new Set(subjectTypes.map((type, i) => `${type}:${subjectIds[i] ?? ''}`))
        return {
          rows: teamGrants.filter(row => wanted.has(`${row.subject_type}:${row.subject_id}`)),
        }
      }
      if (text.includes('FROM gfs_shares')) return { rows: [] }
      if (text.includes('INSERT INTO gfs_grants')) return { rows: [] }
      if (text.includes('INSERT INTO gfs_audit')) return { rows: [{ id: 'audit-2' }] }
      return { rows: [] }
    })

    const app = await buildApp()
    const res = await request(app)
      .put('/external/gfs/grants')
      .set('x-user-session-token', 'sess')
      .send({
        resourceId: R,
        subject: { type: 'user', id: U2 },
        permissions: ['read'],
        inherit: false,
      })

    expect(res.status).toBe(200)
    const insert = mockQuery.mock.calls.find(c => String(c[0]).includes('INSERT INTO gfs_grants'))
    expect(insert?.[1]?.[6]).toBe(`user:${U1}`)
  })

  it('rejects a non-UUID user subject id → 400 subject_invalid', async () => {
    auth()
    dbReturning([
      {
        subject_type: 'user',
        subject_id: U1,
        resource_id: R,
        permissions: ['manage_acl', 'read'],
        inherit: false,
      },
    ])
    const app = await buildApp()
    const res = await request(app)
      .put('/external/gfs/grants')
      .set('x-user-session-token', 'sess')
      .send({ resourceId: R, subject: { type: 'user', id: 'not-a-uuid' }, permissions: ['read'] })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('subject_invalid')
  })

  it('rejects a user granting TO the operator subject → 403 operator_grant_forbidden', async () => {
    auth()
    dbReturning([
      {
        subject_type: 'user',
        subject_id: U1,
        resource_id: R,
        permissions: ['manage_acl', 'read'],
        inherit: false,
      },
    ])
    const app = await buildApp()
    const res = await request(app)
      .put('/external/gfs/grants')
      .set('x-user-session-token', 'sess')
      .send({ resourceId: R, subject: { type: 'operator' }, permissions: ['read'], inherit: false })
    expect(res.status).toBe(403)
    expect(res.body.error).toBe('operator_grant_forbidden')
  })

  it('rejects escalation: user grants a bit it does NOT hold → 403', async () => {
    auth()
    // User holds manage_acl + read, but NOT write → cannot grant write.
    dbReturning([
      {
        subject_type: 'user',
        subject_id: U1,
        resource_id: R,
        permissions: ['manage_acl', 'read'],
        inherit: false,
      },
    ])
    const app = await buildApp()
    const res = await request(app)
      .put('/external/gfs/grants')
      .set('x-user-session-token', 'sess')
      .send({
        resourceId: R,
        subject: { type: 'user', id: U2 },
        permissions: ['write'],
        inherit: false,
      })
    expect(res.status).toBe(403)
    expect(res.body.error).toBe('escalation_rejected')
    expect(mockAppendPermissionEvents).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        changes: [expect.objectContaining({ outcome: 'rejected', authorizationDecision: 'deny' })],
      })
    )
  })
})

describe('POST /external/gfs/shares (user delegation via existing engine)', () => {
  it('persists the typed audit and normalized administrative event in the same transaction', async () => {
    auth()
    dbReturning([
      {
        subject_type: 'user',
        subject_id: U1,
        resource_id: R,
        permissions: ['share', 'read'],
        inherit: false,
      },
    ])
    const app = await buildApp()
    const res = await request(app)
      .post('/external/gfs/shares')
      .set('x-user-session-token', 'sess')
      .send({
        resourceId: R,
        subject: { type: 'user', id: U2 },
        permissions: ['read'],
        includeDescendants: false,
      })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      ok: true,
      resourceId: R,
      updated: [{ type: 'user', id: U2 }],
      count: 1,
    })
    expect(
      mockQuery.mock.calls.some(call => String(call[0]).includes('INSERT INTO gfs_shares'))
    ).toBe(true)
    expect(mockAppendPermissionEvents).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        operatorSub: U1,
        changes: [
          expect.objectContaining({
            resourceClass: 'gfs_share',
            outcome: 'committed',
            detailRef: 'gfs_permissions/read',
          }),
        ],
      })
    )
  })

  it.each([
    ['operator', { type: 'operator' }],
    ['context', { type: 'context', id: 'run-context' }],
  ])('preserves singular %s shares for an operator caller', async (_label, subject) => {
    dbReturning([])
    const app = await buildOperatorShareApp()

    const res = await request(app)
      .post('/gfs/shares')
      .send({
        resourceId: R,
        subject,
        permissions: ['read'],
        includeDescendants: false,
      })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, resourceId: R, updated: [subject], count: 1 })
    const mutations = mockQuery.mock.calls.filter(call =>
      String(call[0]).includes('INSERT INTO gfs_shares')
    )
    expect(mutations).toHaveLength(1)
    expect(mutations[0]?.[1]?.[2]).toEqual([subject.type])
    expect(mutations[0]?.[1]?.[3]).toEqual(['id' in subject ? subject.id : ''])
  })

  it('preserves the singular host share rejection for an operator caller', async () => {
    dbReturning([])
    const app = await buildOperatorShareApp()

    const res = await request(app)
      .post('/gfs/shares')
      .send({
        resourceId: R,
        subject: { type: 'host', id: H1 },
        permissions: ['read'],
        includeDescendants: false,
      })

    expect(res.status).toBe(403)
    expect(res.body).toEqual({
      error: 'share_to_agent_forbidden',
      message: 'share_to_agent_forbidden',
    })
    expect(
      mockQuery.mock.calls.some(call => String(call[0]).includes('INSERT INTO gfs_shares'))
    ).toBe(false)
    expect(mockAppendPermissionEvents).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        operatorSub: 'operator-share-test',
        operatorKind: 'control_admin',
        changes: [
          expect.objectContaining({
            outcome: 'rejected',
            authorizationDecision: 'deny',
            subject: { kind: 'service', id: `host:${H1}`, principalKind: 'host' },
          }),
        ],
      })
    )
  })
})

describe('GET /external/gfs/shares (delegation metadata parity)', () => {
  it('lists shares for an ordinary user with manage_acl and hides inaccessible/missing resources', async () => {
    auth()
    const item = {
      id: 'aaaaaaaa-0000-4000-8000-000000000001',
      drive: 'main',
      resource_id: R,
      subject_type: 'user',
      subject_id: U2,
      permissions: ['read'],
      include_descendants: true,
    }
    dbReturning(
      [
        {
          subject_type: 'user',
          subject_id: U1,
          resource_id: R,
          permissions: ['manage_acl'],
          inherit: false,
        },
      ],
      { grantListRows: [item] }
    )

    const allowed = await request(await buildApp())
      .get(`/external/gfs/shares?drive=main&resourceId=${R}`)
      .set('x-user-session-token', 'sess')
    expect(allowed.status).toBe(200)
    expect(allowed.body.items).toEqual([
      expect.objectContaining({
        id: item.id,
        resourceId: R,
        subject: { type: 'user', id: U2 },
        includeDescendants: true,
      }),
    ])

    mockQuery.mockReset()
    dbReturning([])
    const hidden = await request(await buildApp())
      .get(`/external/gfs/shares?drive=main&resourceId=${R2}`)
      .set('x-user-session-token', 'sess')
    expect(hidden.status).toBe(403)
    expect(hidden.body.error).toBe('manage_acl_required')
  })
})

describe('authenticated bulk grant/share transport', () => {
  const authority = (permissions: string[]) =>
    dbReturning([
      {
        subject_type: 'user',
        subject_id: U1,
        resource_id: R,
        permissions,
        inherit: false,
      },
    ])

  it('keeps singular grant responses compatible with the ordered result envelope', async () => {
    auth()
    authority(['manage_acl', 'read'])
    const app = await buildApp()

    const res = await request(app)
      .put('/external/gfs/grants')
      .set('x-user-session-token', 'sess')
      .send({
        resourceId: R,
        subject: { type: 'user', id: U2 },
        permissions: ['read'],
        inherit: false,
      })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      ok: true,
      resourceId: R,
      updated: [{ type: 'user', id: U2 }],
      count: 1,
    })
  })

  it('bulk grants user, team, and canonical host subjects in input order with one mutation', async () => {
    auth()
    authority(['manage_acl', 'read'])
    const app = await buildApp()
    const subjects = [
      { type: 'user', id: U2 },
      { type: 'team', id: T2 },
      { type: 'host', id: H1 },
    ]

    const res = await request(app)
      .put('/external/gfs/grants')
      .set('x-user-session-token', 'sess')
      .set('x-correlation-id', CORRELATION_ID)
      .send({ resourceId: R, subjects, permissions: ['read'], inherit: true })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, resourceId: R, updated: subjects, count: 3 })
    const mutations = mockQuery.mock.calls.filter(call =>
      String(call[0]).includes('INSERT INTO gfs_grants')
    )
    expect(mutations).toHaveLength(1)

    const audits = mockQuery.mock.calls.filter(call =>
      String(call[0]).includes('INSERT INTO gfs_audit')
    )
    expect(audits.map(call => call[1]?.[0])).toEqual([`user:${U2}`, `team:${T2}`, `host:${H1}`])
    expect(audits.map(call => call[1]?.[6])).toEqual([
      CORRELATION_ID,
      CORRELATION_ID,
      CORRELATION_ID,
    ])
    expect(mockAppendPermissionEvents).toHaveBeenCalledTimes(1)
    expect(mockAppendPermissionEvents).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        requestId: CORRELATION_ID,
        changes: [
          expect.objectContaining({ subject: { kind: 'user', id: U2 }, outcome: 'committed' }),
          expect.objectContaining({ subject: { kind: 'team', id: T2 }, outcome: 'committed' }),
          expect.objectContaining({
            subject: { kind: 'service', id: `host:${H1}`, principalKind: 'host' },
            outcome: 'committed',
          }),
        ],
      })
    )
  })

  it('bulk shares user and team subjects in input order with one mutation', async () => {
    auth()
    authority(['share', 'read'])
    const app = await buildApp()
    const subjects = [
      { type: 'team', id: T2 },
      { type: 'user', id: U2 },
    ]

    const res = await request(app)
      .post('/external/gfs/shares')
      .set('x-user-session-token', 'sess')
      .send({ resourceId: R, subjects, permissions: ['read'], includeDescendants: true })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, resourceId: R, updated: subjects, count: 2 })
    expect(
      mockQuery.mock.calls.filter(call => String(call[0]).includes('INSERT INTO gfs_shares'))
    ).toHaveLength(1)
    expect(mockAppendPermissionEvents).toHaveBeenCalledTimes(1)
    expect(mockAppendPermissionEvents.mock.calls[0]?.[1]?.changes).toHaveLength(2)
  })

  it.each([
    ['grant', 'put', '/external/gfs/grants', 'INSERT INTO gfs_grants', ['manage_acl', 'read']],
    ['share', 'post', '/external/gfs/shares', 'INSERT INTO gfs_shares', ['share', 'read']],
  ] as const)(
    'canonicalizes uppercase UUID subjects throughout a successful %s mutation',
    async (_label, method, path, mutationSql, heldPermissions) => {
      auth()
      authority([...heldPermissions])
      const app = await buildApp()

      const res = await request(app)
        [method](path)
        .set('x-user-session-token', 'sess')
        .send({
          resourceId: R,
          subjects: [
            { type: 'user', id: U2.toUpperCase() },
            { type: 'team', id: T2.toUpperCase() },
          ],
          permissions: ['read'],
        })

      expect(res.status).toBe(200)
      expect(res.body).toEqual({
        ok: true,
        resourceId: R,
        updated: [
          { type: 'user', id: U2 },
          { type: 'team', id: T2 },
        ],
        count: 2,
      })
      const mutation = mockQuery.mock.calls.find(call => String(call[0]).includes(mutationSql))
      expect(mutation?.[1]?.[3]).toEqual([U2, T2])
      const audits = mockQuery.mock.calls.filter(call =>
        String(call[0]).includes('INSERT INTO gfs_audit')
      )
      expect(audits.map(call => call[1]?.[0])).toEqual([`user:${U2}`, `team:${T2}`])
    }
  )

  it.each([
    ['grant', 'put', '/external/gfs/grants', 'INSERT INTO gfs_grants', ['manage_acl', 'read']],
    ['share', 'post', '/external/gfs/shares', 'INSERT INTO gfs_shares', ['share', 'read']],
  ] as const)(
    'rejects a mixed-case duplicate %s batch with the common structured error',
    async (_label, method, path, mutationSql, heldPermissions) => {
      auth()
      authority([...heldPermissions])
      const app = await buildApp()

      const res = await request(app)
        [method](path)
        .set('x-user-session-token', 'sess')
        .send({
          resourceId: R,
          subjects: [
            { type: 'user', id: U2 },
            { type: 'user', id: U2.toUpperCase() },
          ],
          permissions: ['read'],
        })

      expect(res.status).toBe(400)
      expect(res.body).toEqual({
        error: 'subjects_invalid',
        message: 'subjects_invalid',
        invalidIndexes: [1],
      })
      expect(mockQuery.mock.calls.some(call => String(call[0]).includes(mutationSql))).toBe(false)
      expect(mockAppendPermissionEvents).not.toHaveBeenCalled()
    }
  )

  it.each([
    ['grant with neither field', 'put', '/external/gfs/grants', {}],
    [
      'grant with both fields',
      'put',
      '/external/gfs/grants',
      { subject: { type: 'user', id: U2 }, subjects: [{ type: 'team', id: T2 }] },
    ],
    ['share with neither field', 'post', '/external/gfs/shares', {}],
    [
      'share with both fields',
      'post',
      '/external/gfs/shares',
      { subject: { type: 'user', id: U2 }, subjects: [{ type: 'team', id: T2 }] },
    ],
  ] as const)(
    'gives subject transport precedence for %s even when resourceId is invalid',
    async (_label, method, path, subjectFields) => {
      auth()
      mockQuery.mockImplementation(
        async (text: string) => activeSessionLifecycleResult(text) ?? { rows: [] }
      )
      const app = await buildApp()

      const res = await request(app)
        [method](path)
        .set('x-user-session-token', 'sess')
        .send({ resourceId: 'not-a-uuid', ...subjectFields, permissions: ['read'] })

      expect(res.status).toBe(400)
      expect(res.body).toEqual({ error: 'subjects_invalid', message: 'subjects_invalid' })
      expect(
        mockQuery.mock.calls.some(call => /INSERT INTO gfs_(?:grants|shares)/.test(String(call[0])))
      ).toBe(false)
      expect(mockAppendPermissionEvents).not.toHaveBeenCalled()
    }
  )

  it.each([
    ['grant', 'put', '/external/gfs/grants'],
    ['share', 'post', '/external/gfs/shares'],
  ] as const)(
    'serializes an invalid resource consistently for %s writes',
    async (_label, method, path) => {
      auth()
      mockQuery.mockImplementation(
        async (text: string) => activeSessionLifecycleResult(text) ?? { rows: [] }
      )
      const app = await buildApp()

      const res = await request(app)
        [method](path)
        .set('x-user-session-token', 'sess')
        .send({
          resourceId: 'not-a-uuid',
          subject: { type: 'user', id: U2 },
          permissions: ['read'],
        })

      expect(res.status).toBe(400)
      expect(res.body).toEqual({ error: 'resource_invalid', message: 'resource_invalid' })
      expect(
        mockQuery.mock.calls.some(call => /INSERT INTO gfs_(?:grants|shares)/.test(String(call[0])))
      ).toBe(false)
      expect(mockAppendPermissionEvents).not.toHaveBeenCalled()
    }
  )

  it.each([
    ['operator', { type: 'operator' }],
    ['context', { type: 'context', id: 'run-context' }],
  ])('rejects plural %s grants before mutation', async (_label, unsupported) => {
    auth()
    authority(['manage_acl', 'read'])
    const app = await buildApp()

    const res = await request(app)
      .put('/external/gfs/grants')
      .set('x-user-session-token', 'sess')
      .send({
        resourceId: R,
        subjects: [{ type: 'user', id: U2 }, unsupported],
        permissions: ['read'],
      })

    expect(res.status).toBe(400)
    expect(res.body).toMatchObject({ error: 'subjects_invalid', invalidIndexes: [1] })
    expect(
      mockQuery.mock.calls.some(call => String(call[0]).includes('INSERT INTO gfs_grants'))
    ).toBe(false)
    expect(mockAppendPermissionEvents).not.toHaveBeenCalled()
  })

  it.each([
    ['host', { type: 'host', id: H1 }],
    ['operator', { type: 'operator' }],
    ['context', { type: 'context', id: 'run-context' }],
  ])('rejects a %s in plural shares before mutation', async (_label, unsupported) => {
    auth()
    authority(['share', 'read'])
    const app = await buildApp()

    const res = await request(app)
      .post('/external/gfs/shares')
      .set('x-user-session-token', 'sess')
      .send({
        resourceId: R,
        subjects: [{ type: 'user', id: U2 }, unsupported],
        permissions: ['read'],
      })

    expect(res.status).toBe(400)
    expect(res.body).toMatchObject({ error: 'subjects_invalid', invalidIndexes: [1] })
    expect(
      mockQuery.mock.calls.some(call => String(call[0]).includes('INSERT INTO gfs_shares'))
    ).toBe(false)
    expect(mockAppendPermissionEvents).not.toHaveBeenCalled()
  })

  it('denies an entire mixed grant batch without mutation and records correlated denial evidence', async () => {
    auth()
    authority(['manage_acl'])
    const app = await buildApp()

    const res = await request(app)
      .put('/external/gfs/grants')
      .set('x-user-session-token', 'sess')
      .set('x-correlation-id', CORRELATION_ID)
      .send({
        resourceId: R,
        subjects: [
          { type: 'user', id: U2 },
          { type: 'host', id: H1 },
        ],
        permissions: ['manage_acl'],
      })

    expect(res.status).toBe(403)
    expect(res.body.error).toBe('agent_manager_forbidden')
    expect(
      mockQuery.mock.calls.some(call => String(call[0]).includes('INSERT INTO gfs_grants'))
    ).toBe(false)
    const audits = mockQuery.mock.calls.filter(call =>
      String(call[0]).includes('INSERT INTO gfs_audit')
    )
    expect(audits.map(call => [call[1]?.[0], call[1]?.[4], call[1]?.[6]])).toEqual([
      [`user:${U2}`, 'denied', CORRELATION_ID],
      [`host:${H1}`, 'denied', CORRELATION_ID],
    ])
    expect(mockAppendPermissionEvents).toHaveBeenCalledTimes(1)
    expect(mockAppendPermissionEvents.mock.calls[0]?.[1]?.changes).toEqual([
      expect.objectContaining({ outcome: 'rejected', authorizationDecision: 'deny' }),
      expect.objectContaining({ outcome: 'rejected', authorizationDecision: 'deny' }),
    ])
  })

  it('denies an entire plural grant batch when a managed first-party host exceeds read/write', async () => {
    auth()
    // The caller holds every requested bit, so the only thing standing between
    // this batch and a mutation is the managed first-party host permission cap.
    authority(['manage_acl', 'read', 'delete'])
    const app = await buildApp()

    const res = await request(app)
      .put('/external/gfs/grants')
      .set('x-user-session-token', 'sess')
      .set('x-correlation-id', CORRELATION_ID)
      .send({
        resourceId: R,
        subjects: [
          { type: 'user', id: U2 },
          { type: 'host', id: H1 },
        ],
        permissions: ['read', 'delete'],
      })

    expect(res.status).toBe(403)
    expect(res.body.error).toBe('managed_agent_permission_forbidden')
    expect(
      mockQuery.mock.calls.some(call => String(call[0]).includes('INSERT INTO gfs_grants'))
    ).toBe(false)
  })

  it('does not publish staged mutation or audit effects when event persistence fails', async () => {
    auth()
    authority(['manage_acl', 'read'])
    const attempted: string[] = []
    const committed: string[] = []
    mockWithTransaction.mockImplementation(
      async (
        work: (db: {
          query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[] }>
        }) => Promise<unknown>
      ) => {
        const staged: string[] = []
        const result = await work({
          query: async (text: string, values?: unknown[]) => {
            if (text.includes('INSERT INTO gfs_grants')) staged.push('grant')
            if (text.includes('INSERT INTO gfs_audit')) staged.push('audit')
            attempted.push(...staged.slice(attempted.length))
            return mockQuery(text, values)
          },
        })
        committed.push(...staged)
        return result
      }
    )
    mockAppendPermissionEvents.mockRejectedValueOnce(new Error('permission event write failed'))
    const app = await buildApp()

    const res = await request(app)
      .put('/external/gfs/grants')
      .set('x-user-session-token', 'sess')
      .send({
        resourceId: R,
        subjects: [
          { type: 'user', id: U2 },
          { type: 'team', id: T2 },
        ],
        permissions: ['read'],
      })

    expect(res.status).toBe(500)
    expect(attempted).toContain('grant')
    expect(attempted).toContain('audit')
    expect(committed).toEqual([])
  })
})

describe('GET /external/gfs/resources/:id/affordances', () => {
  it('returns the bits the caller holds + isOperator:false', async () => {
    auth()
    dbReturning([
      {
        subject_type: 'user',
        subject_id: U1,
        resource_id: R,
        permissions: ['read', 'manage_acl'],
        inherit: false,
      },
    ])
    const app = await buildApp()
    const res = await request(app)
      .get(`/external/gfs/resources/${R}/affordances`)
      .set('x-user-session-token', 'sess')
    expect(res.status).toBe(200)
    expect(res.body.isOperator).toBe(false)
    expect(new Set(res.body.held)).toEqual(new Set(['read', 'manage_acl']))
  })

  it('includes permissions held through any active team, not only the session teamId', async () => {
    auth()
    mockQuery.mockImplementation(async (text: string, values?: unknown[]) => {
      const lifecycle = activeSessionLifecycleResult(text)
      if (lifecycle) return lifecycle
      if (text.includes('FROM team_members')) return { rows: [{ team_id: T2 }] }
      if (text.includes('WITH RECURSIVE chain'))
        return { rows: [{ resource_id: String(values?.[1]) }] }
      if (text.includes('FROM gfs_grants')) {
        const subjectTypes = (values?.[1] as string[]) ?? []
        const subjectIds = (values?.[2] as string[]) ?? []
        const wanted = new Set(subjectTypes.map((type, i) => `${type}:${subjectIds[i] ?? ''}`))
        const rows = [
          {
            subject_type: 'team',
            subject_id: T2,
            resource_id: R,
            permissions: ['read', 'manage_acl'],
            inherit: false,
          },
        ]
        return { rows: rows.filter(row => wanted.has(`${row.subject_type}:${row.subject_id}`)) }
      }
      if (text.includes('FROM gfs_shares')) return { rows: [] }
      return { rows: [] }
    })

    const app = await buildApp()
    const res = await request(app)
      .get(`/external/gfs/resources/${R}/affordances`)
      .set('x-user-session-token', 'sess')

    expect(res.status).toBe(200)
    expect(res.body.isOperator).toBe(false)
    expect(new Set(res.body.held)).toEqual(new Set(['read', 'manage_acl']))
  })
})

describe('user resource mutations via gfsc proxy', () => {
  it('rejects non-session tokens on external mutation routes before minting a GFS token', async () => {
    mockVerifyExternalSessionToken.mockReturnValue(null)
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const app = await buildApp()
    const res = await request(app)
      .post(`/external/gfs/resources/${R}/children`)
      .set('x-user-session-token', 'operator-jwt')
      .send({ name: 'docs', kind: 'directory' })

    expect(res.status).toBe(401)
    expect(mockSignGfsToken).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects a mutation with no session header before minting or proxying', async () => {
    mockVerifyExternalSessionToken.mockReturnValue(null)
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const app = await buildApp()
    const res = await request(app).delete(`/external/gfs/resources/${R}`).send({ ifMatch: 1 })

    expect(res.status).toBe(401)
    expect(mockSignGfsToken).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('creates a child with a user gfs.write token', async () => {
    auth()
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true, data: { resourceId: R2 } }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        })
    )
    vi.stubGlobal('fetch', fetchMock)
    const app = await buildApp()
    const res = await request(app)
      .post(`/external/gfs/resources/${R}/children`)
      .set('x-user-session-token', 'sess')
      .send({ name: 'docs', kind: 'directory' })

    expect(res.status).toBe(201)
    expect(mockSignGfsToken).toHaveBeenCalledWith({
      subject: U1,
      drive: 'main',
      scopes: ['gfs.write'],
      authGeneration: 1,
      principalType: 'user',
    })
    expect(fetchMock).toHaveBeenCalledWith(
      'http://gfsc-writer.gfs.svc:8087/v1/resources/' + R_RID + '/children',
      {
        method: 'POST',
        headers: expect.objectContaining({ 'content-type': 'application/json' }),
        body: JSON.stringify({ name: 'docs', kind: 'directory' }),
        signal: expect.any(AbortSignal),
      }
    )
  })

  it('deletes a resource with a user gfs.delete token', async () => {
    auth()
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true, data: { deleted: true } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
    )
    vi.stubGlobal('fetch', fetchMock)
    const app = await buildApp()
    const res = await request(app)
      .delete(`/external/gfs/resources/${R}`)
      .set('x-user-session-token', 'sess')
      .send({ ifMatch: 3 })

    expect(res.status).toBe(200)
    expect(mockSignGfsToken).toHaveBeenCalledWith({
      subject: U1,
      drive: 'main',
      scopes: ['gfs.delete'],
      authGeneration: 1,
      principalType: 'user',
    })
    expect(fetchMock).toHaveBeenCalledWith(
      'http://gfsc-writer.gfs.svc:8087/v1/resources/' + R_RID,
      {
        method: 'DELETE',
        headers: expect.objectContaining({ 'content-type': 'application/json' }),
        body: JSON.stringify({ ifMatch: 3 }),
        signal: expect.any(AbortSignal),
      }
    )
  })

  it('returns 504 gfsc_timeout when the gfsc mutation fetch times out', async () => {
    auth()
    const fetchMock = vi.fn(async () => {
      const err = new Error('The operation was aborted due to timeout')
      err.name = 'TimeoutError'
      throw err
    })
    vi.stubGlobal('fetch', fetchMock)
    const app = await buildApp()
    const res = await request(app)
      .post(`/external/gfs/resources/${R}/children`)
      .set('x-user-session-token', 'sess')
      .send({ name: 'docs', kind: 'file', contentBase64: 'AAAA' })
    expect(res.status).toBe(504)
    expect(res.body).toEqual({ error: 'gfsc_timeout' })
  })

  it('returns 504 when gfsc sends mutation headers then stalls the response body', async () => {
    // The response-body read is bounded by the same deadline; a stall after
    // headers must classify as 504 (via the guarded text()), not reject uncaught
    // into a generic 500. The mock wires the deadline signal to the body stream
    // the way undici does, then never sends bytes.
    auth()
    ;(config as { gfscProxyTimeoutMs: number }).gfscProxyTimeoutMs = 20
    const fetchMock = vi.fn((_url: string, init: { signal: AbortSignal }) =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            pull(controller) {
              init.signal.addEventListener('abort', () => controller.error(init.signal.reason))
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      )
    )
    vi.stubGlobal('fetch', fetchMock)
    const app = await buildApp()
    const res = await request(app)
      .post(`/external/gfs/resources/${R}/children`)
      .set('x-user-session-token', 'sess')
      .send({ name: 'docs', kind: 'file', contentBase64: 'AAAA' })

    expect(res.status).toBe(504)
    expect(res.body).toEqual({ error: 'gfsc_timeout' })
  })

  it('forwards a gfsc 5xx on a user mutation verbatim (never a silent 500)', async () => {
    auth()
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: false, error: { code: 'internal' } }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        })
    )
    vi.stubGlobal('fetch', fetchMock)
    const app = await buildApp()
    const res = await request(app)
      .post(`/external/gfs/resources/${R}/children`)
      .set('x-user-session-token', 'sess')
      .send({ name: 'docs', kind: 'file', contentBase64: 'AAAA' })
    expect(res.status).toBe(500)
    expect(res.body).toEqual({ ok: false, error: { code: 'internal' } })
  })
})

describe('GET /external/gfs/resources', () => {
  it('lists readable direct user resources and active-team resources as Desktop entry points', async () => {
    auth()
    mockQuery.mockImplementation(async (text: string, values?: unknown[]) => {
      const lifecycle = activeSessionLifecycleResult(text)
      if (lifecycle) return lifecycle
      if (text.includes('FROM team_members')) return { rows: [{ team_id: T1 }] }
      if (text.includes('FROM gfs_grants') && text.includes('JOIN requested_subjects')) {
        expect(values?.[1]).toEqual(['user', 'team'])
        expect(values?.[2]).toEqual([U1, T1])
        return {
          rows: [
            {
              resource_id: R,
              drive: 'main',
              parent_resource_id: null,
              name: 'team-folder-tree',
              kind: 'directory',
              path_cache: '/team-folder-tree',
              version: 1,
              bytes: 0,
              sources: ['grant'],
              permissions: ['read'],
              covers_descendants: true,
            },
            {
              resource_id: R2,
              drive: 'main',
              parent_resource_id: R,
              name: 'external-file.pdf',
              kind: 'file',
              path_cache: '/other-org/external-file.pdf',
              version: 2,
              bytes: 128,
              sources: ['share'],
              permissions: ['read'],
              covers_descendants: false,
            },
          ],
        }
      }
      return { rows: [] }
    })
    const app = await buildApp()
    const res = await request(app)
      .get('/external/gfs/resources')
      .set('x-user-session-token', 'sess')
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.data.items).toEqual([
      expect.objectContaining({
        resourceId: R,
        name: 'team-folder-tree',
        kind: 'directory',
        sources: ['grant'],
        coversDescendants: true,
      }),
      expect.objectContaining({
        resourceId: R2,
        name: 'external-file.pdf',
        kind: 'file',
        sources: ['share'],
        coversDescendants: false,
      }),
    ])
  })
})

describe('per-agent delegation surface (guard + list + rate limit)', () => {
  const authority = (permissions: string[], opts: Parameters<typeof dbReturning>[1] = {}) =>
    dbReturning(
      [
        {
          subject_type: 'user',
          subject_id: U1,
          resource_id: R,
          permissions,
          inherit: false,
        },
      ],
      opts
    )
  const putGrants = (app: express.Express, body: Record<string, unknown>) =>
    request(app)
      .put('/external/gfs/grants')
      .set('x-user-session-token', 'sess')
      .send({ resourceId: R, permissions: ['read'], inherit: true, ...body })

  it('rejects a single valid-but-foreign host without indexes and writes nothing', async () => {
    auth()
    authority(['manage_acl', 'read'], { callerAgentNames: ['other-agent'] })
    const app = await buildApp()
    const res = await putGrants(app, { subject: { type: 'host', id: H1 } })
    expect(res.status).toBe(403)
    expect(res.body.error).toBe('foreign_agent_forbidden')
    expect(res.body.invalidIndexes).toBeUndefined()
    expect(
      mockQuery.mock.calls.filter(call => String(call[0]).includes('INSERT INTO gfs_grants'))
    ).toHaveLength(0)
  })

  it('rejects a plural body with the foreign host indexes and writes nothing', async () => {
    auth()
    authority(['manage_acl', 'read'], { callerAgentNames: ['agent-b'] })
    const app = await buildApp()
    const res = await putGrants(app, {
      subjects: [
        { type: 'user', id: U2 },
        { type: 'host', id: H1 },
        { type: 'host', id: '1st:mcp-host/agent-b' },
      ],
    })
    expect(res.status).toBe(403)
    expect(res.body.error).toBe('foreign_agent_forbidden')
    expect(res.body.invalidIndexes).toEqual([1])
    expect(
      mockQuery.mock.calls.filter(call => String(call[0]).includes('INSERT INTO gfs_grants'))
    ).toHaveLength(0)
  })

  it('leaves malformed host ids to the subjects_invalid contract', async () => {
    auth()
    authority(['manage_acl', 'read'], { callerAgentNames: [] })
    const app = await buildApp()
    const res = await putGrants(app, { subjects: [{ type: 'host', id: 'not-a-host' }] })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('subjects_invalid')
  })

  it('lists id-bearing grant rows for a manage_acl holder', async () => {
    auth()
    authority(['manage_acl'], {
      grantListRows: [
        {
          id: 'aaaa1111-0000-4000-8000-000000000001',
          drive: 'main',
          resource_id: R,
          subject_type: 'host',
          subject_id: H1,
          permissions: ['read', 'write'],
          inherit: true,
        },
      ],
    })
    const app = await buildApp()
    const res = await request(app)
      .get('/external/gfs/grants')
      .query({ drive: 'main', resourceId: R })
      .set('x-user-session-token', 'sess')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      items: [
        {
          id: 'aaaa1111-0000-4000-8000-000000000001',
          drive: 'main',
          resourceId: R,
          subject: { type: 'host', id: H1 },
          permissions: ['read', 'write'],
          inherit: true,
        },
      ],
    })
  })

  it('denies the grants list to a caller without manage_acl', async () => {
    auth()
    authority(['read', 'write'])
    const app = await buildApp()
    const res = await request(app)
      .get('/external/gfs/grants')
      .query({ drive: 'main', resourceId: R })
      .set('x-user-session-token', 'sess')
    expect(res.status).toBe(403)
    expect(res.body.error).toBe('manage_acl_required')
  })

  it('answers an unknown resource with the same 403 (no existence oracle)', async () => {
    auth()
    dbReturning([])
    const app = await buildApp()
    const res = await request(app)
      .get('/external/gfs/grants')
      .query({ drive: 'main', resourceId: R2 })
      .set('x-user-session-token', 'sess')
    expect(res.status).toBe(403)
    expect(res.body.error).toBe('manage_acl_required')
  })

  it('rate limits the grants mutation class before authority resolution', async () => {
    auth()
    authority(['manage_acl', 'read'], { rateLimitCount: 31 })
    const app = await buildApp()
    const res = await putGrants(app, { subject: { type: 'user', id: U2 } })
    expect(res.status).toBe(429)
    expect(res.body.error).toBe('Too Many Requests')
    expect(res.body.retryAfterSeconds).toBeGreaterThanOrEqual(1)
    const bucketCall = mockQuery.mock.calls.find(
      call =>
        String(call[0]).includes('rate_limit_buckets') &&
        String(call[1]?.[0]).startsWith('gfs-ext:pre:grants-mutation:session:')
    )
    expect(bucketCall?.[1]?.[0]).toMatch(/^gfs-ext:pre:grants-mutation:session:[0-9a-f]{64}$/)
  })

  it('keys the external delegation plane in a bucket DISTINCT from the admin plane for the same subject', async () => {
    // Same subject id (U1) is driven through BOTH planes; each plane's own
    // production getBucketKey closure runs and its bucket key is captured from
    // the rate_limit_buckets INSERT ([bucketKey, windowStartMs] → values[0]).
    // The PK of rate_limit_buckets is (bucket_key, window_start_ms), so distinct
    // keys are distinct token buckets — exhausting one can never throttle the
    // other for the same subject.
    auth()
    authority(['manage_acl', 'read'])
    const externalApp = await buildApp()
    await putGrants(externalApp, { subject: { type: 'user', id: U2 } })
    const externalKey = mockQuery.mock.calls.find(
      call =>
        String(call[0]).includes('rate_limit_buckets') &&
        String(call[1]?.[0]).startsWith('gfsgrants-ext:')
    )?.[1]?.[0]

    // Admin (operator) grants plane keyed off adminAuth.sub === U1 (same id).
    mockQuery.mockClear()
    const adminApp = await buildAdminGrantsApp(U1)
    await request(adminApp).get('/gfs/grants').query({ drive: 'main', resourceId: R })
    const adminKey = mockQuery.mock.calls.find(call =>
      String(call[0]).includes('rate_limit_buckets')
    )?.[1]?.[0]

    // Both planes emitted a bucket key for the same subject…
    expect(externalKey).toBe(`gfsgrants-ext:user:${U1}`)
    expect(adminKey).toBe(`gfsgrants:${U1}`)
    // …and they are DISTINCT buckets (never collide). The `-ext` separator means
    // the external key does not fall under the admin `gfsgrants:` namespace.
    expect(externalKey).not.toBe(adminKey)
    expect(String(externalKey).startsWith('gfsgrants-ext:')).toBe(true)
    expect(String(adminKey).startsWith('gfsgrants-ext:')).toBe(false)
    expect(String(adminKey).startsWith('gfsgrants:')).toBe(true)
  })

  it('keeps external ACL reads in a distinct read bucket from mutation delegation', async () => {
    auth()
    authority(['manage_acl', 'read'])
    const app = await buildApp()
    await request(app)
      .get('/external/gfs/grants')
      .query({ drive: 'main', resourceId: R })
      .set('x-user-session-token', 'sess')

    const readKey = mockQuery.mock.calls.find(
      call =>
        String(call[0]).includes('rate_limit_buckets') &&
        String(call[1]?.[0]).startsWith('gfsgrants-ext-read:')
    )?.[1]?.[0]

    expect(readKey).toBe(`gfsgrants-ext-read:user:${U1}`)
    expect(String(readKey).startsWith('gfsgrants-ext:')).toBe(false)
  })

  it('adjudicates only well-formed foreign hosts in foreignHostSubjectIndexes', async () => {
    const { foreignHostSubjectIndexes } = await import('../src/routes/external/gfs.js')
    const allowed = new Set([H1])
    expect(
      foreignHostSubjectIndexes(
        [
          { type: 'host', id: H1 },
          { type: 'host', id: '3rd:sandbox-recipes/tool' },
          { type: 'host', id: '1st:mcp-host/standalone' },
          { type: 'user', id: U2 },
          { type: 'host', id: 'garbage' },
          null,
        ],
        allowed
      )
    ).toEqual([1, 2])
  })
})

describe('user read proxy via gfsc (GET /external/gfs/proxy/:rid)', () => {
  const readPath = `/external/gfs/proxy/${R}`

  it('streams a 200 body and forwards content headers with a read gfs.read token', async () => {
    auth()
    const fetchMock = vi.fn(
      async () =>
        new Response('file-bytes-here', {
          status: 200,
          headers: {
            'content-type': 'text/plain',
            'content-length': '15',
            'content-disposition': 'attachment; filename="f.bin"',
          },
        })
    )
    vi.stubGlobal('fetch', fetchMock)
    const app = await buildApp()
    const res = await request(app).get(readPath).set('x-user-session-token', 'sess')

    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toBe('text/plain')
    expect(res.headers['content-length']).toBe('15')
    expect(res.headers['content-disposition']).toBe('attachment; filename="f.bin"')
    expect(res.text).toBe('file-bytes-here')
    expect(mockSignGfsToken).toHaveBeenCalledWith({
      subject: U1,
      drive: 'main',
      scopes: ['gfs.read'],
      authGeneration: 1,
      principalType: 'user',
    })
    expect(fetchMock).toHaveBeenCalledWith(
      `http://gfsc.gfs.svc:8087/v1/resources/${R}/content`,
      expect.objectContaining({ method: 'GET', signal: expect.any(AbortSignal) })
    )
  })

  it('returns 504 gfsc_timeout on a REAL header-deadline abort (AbortError, signal.aborted)', async () => {
    auth()
    ;(config as { gfscProxyTimeoutMs: number }).gfscProxyTimeoutMs = 20
    const fetchMock = vi.fn(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(init.signal.reason))
        })
    )
    vi.stubGlobal('fetch', fetchMock)
    const app = await buildApp()
    const res = await request(app).get(readPath).set('x-user-session-token', 'sess')

    expect(res.status).toBe(504)
    expect(res.body).toEqual({ error: 'gfsc_timeout' })
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true)
  })

  it('returns 502 gfsc_unreachable when the gfsc read fetch fails', async () => {
    auth()
    const fetchMock = vi.fn(async () => {
      throw new Error('connect ECONNREFUSED')
    })
    vi.stubGlobal('fetch', fetchMock)
    const app = await buildApp()
    const res = await request(app).get(readPath).set('x-user-session-token', 'sess')

    expect(res.status).toBe(502)
    expect(res.body).toEqual({ error: 'gfsc_unreachable' })
  })

  it('forwards a gfsc 5xx error body verbatim (never a silent 500)', async () => {
    auth()
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: false, error: { code: 'internal', message: 'boom' } }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        })
    )
    vi.stubGlobal('fetch', fetchMock)
    const app = await buildApp()
    const res = await request(app).get(readPath).set('x-user-session-token', 'sess')

    expect(res.status).toBe(500)
    expect(res.body).toEqual({ ok: false, error: { code: 'internal', message: 'boom' } })
  })
})
