import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { randomUUID } from 'node:crypto'
import request from 'supertest'

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  sign: vi.fn(),
  link: vi.fn(),
  active: vi.fn(),
  events: vi.fn(),
}))
const USER = '11111111-1111-4111-8111-111111111111'
const ADMIN = '22222222-2222-4222-8222-222222222222'
const RESOURCE = '33333333-3333-4333-8333-333333333333'

vi.mock('../src/config.js', () => ({
  config: {
    desktopGfsOperatorLinkingEnabled: true,
    hostsNamespace: 'mcp-host',
    gfscBaseUrl: 'http://gfsc.test',
    gfscWriteBaseUrl: 'http://writer.test',
    gfscProxyTimeoutMs: 10_000,
    gfsUploadMaxPartBytes: 16 * 1024 * 1024,
    externalGfsIngressRlPerMin: 1800,
    externalGfsTokenUserRlPerMin: 100,
    externalGfsGrantsReadRlPerMin: 45,
    externalGfsSharesReadRlPerMin: 35,
    externalGfsOperationRlPerMin: 30,
  },
}))
vi.mock('../src/db.js', () => ({
  pool: { query: mocks.query },
  withTransaction: (work: (db: { query: typeof mocks.query }) => Promise<unknown>) =>
    work({ query: mocks.query }),
}))
vi.mock('../src/auth/gfsToken.js', () => ({
  GFS_DELETE_SCOPE: 'gfs.delete',
  GFS_READ_SCOPE: 'gfs.read',
  GFS_WRITE_SCOPE: 'gfs.write',
  GFS_SCOPES: ['gfs.read', 'gfs.write', 'gfs.delete', 'gfs.manage_acl', 'gfs.share'],
  signGfsToken: mocks.sign,
}))
vi.mock('../src/services/gfsDesktopOperatorLinkService.js', () => ({
  gfsDesktopOperatorLinkService: {
    resolveActiveLink: mocks.link,
    isDesktopUserActive: mocks.active,
  },
  GfsDesktopOperatorLinkError: class GfsDesktopOperatorLinkError extends Error {
    code = 'resolution_failed'
  },
}))
vi.mock('../src/middleware/externalSessionAuth.js', () => ({
  requireValidExternalSessionToken: (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
  ) => {
    if (req.header('x-test-session') !== 'present')
      return res.status(401).json({ error: 'Unauthorized' })
    ;(req as express.Request & { externalAuth: unknown }).externalAuth = {
      userId: USER,
      teamId: null,
      role: 'member',
      authGeneration: 1,
    }
    next()
  },
}))
vi.mock('../src/middleware/externalGfsRateLimit.js', () => ({
  externalGfsClassRlPerMin: () => 150,
  externalGfsPreResolutionRateLimit: (_req: unknown, _res: unknown, next: () => void) => next(),
  externalGfsResolvedOperationRateLimit: (_req: unknown, _res: unknown, next: () => void) => next(),
  externalGfsResolvedActorBucketKey: (_kind: unknown, authority: { tokenSubject: string }) =>
    authority.tokenSubject,
  externalGfsTokenUserBucketKey: (id: string) => id,
  externalGfsSourceIp: () => '127.0.0.1',
  reportEdgeBackstopDenial: vi.fn(),
}))
vi.mock('../src/middleware/rateLimitMiddleware.js', () => ({
  rateLimitMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}))
vi.mock('../src/services/directory/index.js', () => ({
  getUserAgents: vi.fn().mockResolvedValue({ agentNames: ['my-agent'] }),
}))
vi.mock('../src/services/tracing/controlApiPermissionEvents.js', () => ({
  appendControlApiPermissionEventsInTransaction: mocks.events,
}))
vi.mock('../src/middleware/controlUIAuth.js', () => ({
  requireAuthForControlUI: (_req: unknown, _res: unknown, next: () => void) => next(),
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
      req.gfsUploadDeclaredBytes = Number(req.headers['content-length'])
      next()
    },
  }
})

let permissions = ['read', 'manage_acl']
let home: Record<string, unknown> | null
async function buildApp() {
  const { createExternalGfsRouter } = await import('../src/routes/external/gfs.js')
  const app = express()
  app.use(express.json())
  app.use(createExternalGfsRouter())
  return app
}

beforeEach(() => {
  permissions = ['read', 'manage_acl']
  home = {
    state: 'ready',
    drive: 'archive',
    resource_id: RESOURCE,
    conflict_code: null,
    path_cache: '/Users/owner',
  }
  mocks.query.mockReset()
  mocks.link.mockReset().mockResolvedValue({
    desktopUserId: USER,
    controlAdminId: ADMIN,
    source: 'initial_setup',
    lineageId: '55555555-5555-4555-8555-555555555555',
    generation: 1,
    desktopUserGeneration: 1,
    controlAdminGeneration: 1,
  })
  mocks.active.mockReset().mockResolvedValue(true)
  // The signer is an external boundary in this route test; no credential is persisted.
  mocks.sign.mockReset().mockReturnValue({ token: randomUUID(), expiresInSeconds: 300 })
  mocks.events.mockReset().mockResolvedValue(null)
  mocks.query.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM team_members')) return { rows: [] }
    if (sql.includes('FROM gfs_user_homes h')) return { rows: home ? [home] : [] }
    if (sql.includes('pg_advisory_xact_lock')) return { rows: [] }
    if (sql.includes('FROM gfs_user_homes WHERE resource_id'))
      return {
        rows: home ? [{ user_id: USER, state: home.state, conflict_code: home.conflict_code }] : [],
      }
    if (sql.includes('AS protected')) return { rows: [{ protected: false }] }
    if (sql.includes('authority_grants AS'))
      return {
        rows: [
          {
            ancestors: [RESOURCE],
            grants: [
              {
                subject_type: 'user',
                subject_id: USER,
                resource_id: RESOURCE,
                permissions,
                inherit: true,
              },
            ],
            shares: [],
          },
        ],
      }
    if (sql.includes('WITH RECURSIVE chain')) return { rows: [{ resource_id: RESOURCE }] }
    if (sql.includes('FROM gfs_grants g'))
      return {
        rows: [
          {
            subject_type: 'user',
            subject_id: USER,
            resource_id: RESOURCE,
            permissions,
            inherit: true,
          },
        ],
      }
    if (sql.includes('FROM gfs_shares')) return { rows: [] }
    if (sql.includes('INSERT INTO gfs_grants')) return { rows: [] }
    if (sql.includes('INSERT INTO gfs_audit')) return { rows: [{ id: '1' }] }
    throw new Error('unexpected database query in authority test')
  })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: unknown, options?: RequestInit) => {
      if (options?.body && typeof options.body !== 'string') {
        for await (const _chunk of options.body as unknown as AsyncIterable<Uint8Array>) {
          /* consume the part */
        }
      }
      return new Response('payload', { status: 200, headers: { 'content-type': 'text/plain' } })
    })
  )
})
afterEach(() => vi.unstubAllGlobals())

describe('external GFS user authority selector', () => {
  const cases = [
    {
      name: 'token',
      method: 'post',
      path: '/external/gfs/token',
      body: { drive: 'archive', scopes: ['gfs.read'] },
      defaultPrincipal: 'user',
    },
    {
      name: 'JSON affordances',
      method: 'get',
      path: `/external/gfs/resources/${RESOURCE}/affordances?drive=archive`,
    },
    {
      name: 'upload metadata',
      method: 'post',
      path: '/external/gfs/uploads?drive=archive',
      body: { drive: 'archive', operation: 'create' },
      defaultPrincipal: 'user',
    },
    {
      name: 'upload part stream',
      method: 'put',
      path: `/external/gfs/uploads/${RESOURCE}/parts/0?drive=archive`,
      part: true,
      defaultPrincipal: 'user',
    },
    {
      name: 'byte proxy',
      method: 'get',
      path: `/external/gfs/proxy/${RESOURCE}?drive=archive`,
      defaultPrincipal: 'control-admin',
    },
    {
      name: 'mutation proxy',
      method: 'post',
      path: `/external/gfs/resources/${RESOURCE}/children?drive=archive`,
      body: { name: 'file', kind: 'file' },
      defaultPrincipal: 'control-admin',
    },
  ] as const

  it.each(cases)('selects a user and rejects unknown values for $name', async route => {
    const app = await buildApp()
    const send = (selector?: string, authenticated = true) => {
      let req = request(app)[route.method](route.path)
      if (authenticated) req = req.set('x-test-session', 'present')
      if (selector !== undefined) req = req.set('X-Evenfire-Gfs-Authority', selector)
      if ('part' in route && route.part)
        req = req
          .set('content-type', 'application/offset+octet-stream')
          .set('upload-chunk-length', '4')
          .send(Buffer.from('test'))
      else if ('body' in route) req = req.send(route.body)
      return req
    }
    const chosen = await send('user')
    expect(chosen.status).toBe(200)
    if ('defaultPrincipal' in route)
      expect(mocks.sign.mock.lastCall?.[0]).toMatchObject({ subject: USER, principalType: 'user' })
    if (route.name === 'JSON affordances')
      expect(chosen.body).toEqual({ held: ['read', 'manage_acl'], isOperator: false })

    const signedBefore = mocks.sign.mock.calls.length
    const invalid = await send('operator')
    expect(invalid.status).toBe(400)
    expect(invalid.body).toEqual({ error: 'invalid_gfs_authority' })
    expect(mocks.sign).toHaveBeenCalledTimes(signedBefore)
    expect((await send('operator', false)).status).toBe(401)

    const absent = await send()
    expect(absent.status).toBe(200)
    if ('defaultPrincipal' in route)
      expect(mocks.sign.mock.lastCall?.[0]).toMatchObject({
        principalType: route.defaultPrincipal,
        subject: route.defaultPrincipal === 'user' ? USER : ADMIN,
      })
    if (route.name === 'JSON affordances') expect(absent.body).toMatchObject({ isOperator: true })
  })

  it('reads the stored drive and current held permissions for the user home', async () => {
    const app = await buildApp()
    const get = () =>
      request(app)
        .get('/external/gfs/home')
        .set('x-test-session', 'present')
        .set('X-Evenfire-Gfs-Authority', 'user')
    const first = await get()
    expect(first.status).toBe(200)
    expect(first.body).toEqual({
      state: 'ready',
      drive: 'archive',
      path: '/Users/owner',
      resourceId: RESOURCE,
      heldPermissions: ['read', 'manage_acl'],
    })
    permissions = ['read']
    expect((await get()).body.heldPermissions).toEqual(['read'])
    expect(mocks.link).not.toHaveBeenCalled()
    home = {
      state: 'pending',
      drive: null,
      resource_id: null,
      conflict_code: null,
      path_cache: null,
    }
    expect((await get()).body).toEqual({
      state: 'pending',
      drive: null,
      path: null,
      resourceId: null,
      heldPermissions: [],
    })
    home = {
      state: 'conflict',
      drive: 'archive',
      resource_id: null,
      conflict_code: 'path_conflict',
      path_cache: null,
      conflict_detail: { resourceIds: [RESOURCE] },
    }
    const conflict = await get()
    expect(conflict.body).toMatchObject({
      state: 'conflict',
      conflictCode: 'path_conflict',
      heldPermissions: [],
    })
    expect(conflict.body).not.toHaveProperty('conflictDetail')
    expect(conflict.body).not.toHaveProperty('conflict_detail')
    home = null
    expect((await get()).status).toBe(404)
  })

  it('uses user-session audit attribution and applies the own-agent guard to a linked operator', async () => {
    const app = await buildApp()
    const put = (subject: { type: string; id: string }) =>
      request(app)
        .put('/external/gfs/grants')
        .set('x-test-session', 'present')
        .set('X-Evenfire-Gfs-Authority', 'user')
        .send({
          drive: 'archive',
          resourceId: RESOURCE,
          subject,
          permissions: ['read'],
          inherit: false,
        })
    expect((await put({ type: 'host', id: '1st:mcp-host/my-agent' })).status).toBe(200)
    const audit = mocks.query.mock.calls.find(call =>
      String(call[0]).includes('INSERT INTO gfs_audit')
    )
    expect(audit?.[1]?.[8]).toBe(USER)
    expect(audit?.[1]?.[9]).toBe('user-session')
    const writesBefore = mocks.query.mock.calls.filter(call =>
      String(call[0]).includes('INSERT INTO gfs_grants')
    ).length
    const foreign = await put({ type: 'host', id: '1st:mcp-host/foreign-agent' })
    expect(foreign.status).toBe(403)
    expect(foreign.body.error).toBe('foreign_agent_forbidden')
    expect(
      mocks.query.mock.calls.filter(call => String(call[0]).includes('INSERT INTO gfs_grants'))
    ).toHaveLength(writesBefore)
  })
})
