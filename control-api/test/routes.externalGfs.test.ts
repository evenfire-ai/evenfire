import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'

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
  },
}))
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
const H1 = '1st:mcp-host/standalone'
const CORRELATION_ID = '55555555-eeee-4eee-8eee-555555555555'
const SESSION = {
  userId: U1,
  email: 'u@example.com',
  teamId: T1,
  role: 'member' as const,
  exp: Math.floor(Date.now() / 1000) + 3600,
}
const R = '11111111-1111-1111-1111-111111111111'
const R2 = '22222222-2222-2222-2222-222222222222'
const R_RID = R.replace(/-/g, '')

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

beforeEach(() => {
  mockVerifyExternalSessionToken.mockReset()
  mockSignGfsToken.mockReset()
  mockQuery.mockReset()
  mockAppendPermissionEvents.mockReset()
  mockWithTransaction.mockReset()
  mockWithTransaction.mockImplementation(
    async (work: (db: { query: typeof mockQuery }) => Promise<unknown>) =>
      work({ query: mockQuery })
  )
  mockAppendPermissionEvents.mockResolvedValue(null)
  mockSignGfsToken.mockReturnValue({ token: 'gfs-user-token', expiresInSeconds: 300 })
})
afterEach(() => vi.unstubAllGlobals())

const auth = () => mockVerifyExternalSessionToken.mockReturnValue(SESSION)

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
function dbReturning(grants: Record<string, unknown>[]) {
  mockQuery.mockImplementation(async (text: string, values?: unknown[]) => {
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
    })
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
      mockQuery.mockResolvedValue({ rows: [] })
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
      mockQuery.mockResolvedValue({ rows: [] })
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
    })
    expect(fetchMock).toHaveBeenCalledWith(
      'http://gfsc-writer.gfs.svc:8087/v1/resources/' + R_RID + '/children',
      {
        method: 'POST',
        headers: expect.objectContaining({ 'content-type': 'application/json' }),
        body: JSON.stringify({ name: 'docs', kind: 'directory' }),
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
    })
    expect(fetchMock).toHaveBeenCalledWith(
      'http://gfsc-writer.gfs.svc:8087/v1/resources/' + R_RID,
      {
        method: 'DELETE',
        headers: expect.objectContaining({ 'content-type': 'application/json' }),
        body: JSON.stringify({ ifMatch: 3 }),
      }
    )
  })
})

describe('GET /external/gfs/resources', () => {
  it('lists readable direct user resources and active-team resources as Desktop entry points', async () => {
    auth()
    mockQuery.mockImplementation(async (text: string, values?: unknown[]) => {
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
