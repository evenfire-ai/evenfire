import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express, { type NextFunction, type Request, type Response } from 'express'
import request from 'supertest'
import { config } from '../src/config.js'
import { rootLogger } from '../src/observability/logger.js'
import { createAdminMcpServerOauthRouter } from '../src/routes/admin/mcpServerOauth.js'

// Mock the pool — same pattern as adminRecipeOauth.userGrants.test.ts.
const mockPoolQuery = vi.fn()
vi.mock('../src/db.js', () => ({
  pool: {
    query: (...args: unknown[]) => mockPoolQuery(...args),
  },
}))

// Mock the store so we can assert calls without a real DB.
const storeMock = vi.hoisted(() => ({
  listUserGrantsForServer: vi.fn(),
  deleteOAuthGrant: vi.fn(),
}))
vi.mock('../src/oauth/store.js', () => storeMock)

const MCP_NS = config.mcpServersNamespace

// Capture the module child logger's info(...) — the factory builds
// `rootLogger.child({ module: 'admin-mcpserver-oauth' })` at router-create time,
// so a spy on `rootLogger.child` installed before makeAuthedApp intercepts it.
const infoSpy = vi.fn()
const fakeChild = {
  info: infoSpy,
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  fatal: vi.fn(),
  child() {
    return fakeChild
  },
}

function makeAuthedApp(adminSub = 'admin-alice') {
  const app = express()
  app.use(express.json())
  app.use(
    (
      req: Request & {
        adminAuth?: { sub: string; role: string; jti: string; exp: number; typ: 'user' }
      },
      _res: Response,
      next: NextFunction
    ) => {
      req.adminAuth = {
        sub: adminSub,
        role: 'admin',
        jti: 'test-jti',
        exp: 9999999999,
        typ: 'user',
      }
      next()
    }
  )
  app.use(createAdminMcpServerOauthRouter())
  return app
}

function auditPayload(): Record<string, unknown> | undefined {
  const call = infoSpy.mock.calls.find(
    ([obj]) =>
      obj &&
      typeof obj === 'object' &&
      (obj as { event?: unknown }).event === 'oauth_user_grant_force_revoked'
  )
  return call?.[0] as Record<string, unknown> | undefined
}

describe('admin mcp-server per-user grants (DEC-R2)', () => {
  let childSpy: ReturnType<typeof vi.spyOn>
  let app: ReturnType<typeof makeAuthedApp>

  beforeEach(() => {
    vi.clearAllMocks()
    childSpy = vi.spyOn(rootLogger, 'child').mockReturnValue(fakeChild as never)
    storeMock.listUserGrantsForServer.mockResolvedValue([])
    storeMock.deleteOAuthGrant.mockResolvedValue(0)
    mockPoolQuery.mockReset()
    mockPoolQuery.mockResolvedValue({ rows: [], rowCount: 0 })
    app = makeAuthedApp()
  })

  afterEach(() => {
    childSpy.mockRestore()
  })

  it('GET lists the server user grants (namespace forced to mcp-servers)', async () => {
    storeMock.listUserGrantsForServer.mockResolvedValue([
      {
        userId: 'u1',
        oauthClientId: 'self://url',
        background: false,
        updatedAt: new Date('2026-06-02'),
      },
    ])
    const res = await request(app).get('/admin/mcp-servers/gdrive/oauth/user-grants').expect(200)
    expect(res.body.users[0]).toMatchObject({ userId: 'u1', oauthClientId: 'self://url' })
    expect(typeof res.body.users[0].updatedAt).toBe('string')
    expect(storeMock.listUserGrantsForServer).toHaveBeenCalledWith(expect.anything(), {
      namespace: MCP_NS,
      name: 'gdrive',
    })
  })

  it('GET rejects a non-RFC1123 server name with 400', async () => {
    await request(app).get('/admin/mcp-servers/Bad_Name/oauth/user-grants').expect(400)
    expect(storeMock.listUserGrantsForServer).not.toHaveBeenCalled()
  })

  it('DELETE force-revokes by (name, userId) + body oauthClientId; namespace forced; ownerKind mcpserver', async () => {
    const res = await request(app)
      .delete('/admin/mcp-servers/gdrive/oauth/user-grants/u1')
      .send({ oauthClientId: 'https://as.example/.well-known/oauth' })
      .expect(204)
    expect(res.status).toBe(204)
    expect(storeMock.deleteOAuthGrant).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        grantKind: 'user',
        ownerKind: 'mcpserver',
        recipeNamespace: MCP_NS,
        recipeName: 'gdrive',
        userId: 'u1',
        oauthClientId: 'https://as.example/.well-known/oauth',
      })
    )
  })

  it('DELETE emits the oauth_user_grant_force_revoked audit with owner_kind mcpserver', async () => {
    await request(app)
      .delete('/admin/mcp-servers/gdrive/oauth/user-grants/u1')
      .send({ oauthClientId: 'self://url' })
      .expect(204)
    expect(auditPayload()).toMatchObject({
      event: 'oauth_user_grant_force_revoked',
      ownerKind: 'mcpserver',
      mcpServerNamespace: MCP_NS,
      mcpServerName: 'gdrive',
      oauthClientId: 'self://url',
      targetUserId: 'u1',
      adminUserId: 'admin-alice',
    })
  })

  it('DELETE without a body oauthClientId is 400 and never touches the store', async () => {
    await request(app).delete('/admin/mcp-servers/gdrive/oauth/user-grants/u1').send({}).expect(400)
    expect(storeMock.deleteOAuthGrant).not.toHaveBeenCalled()
  })

  it('DELETE rejects a non-RFC1123 server name with 400', async () => {
    await request(app)
      .delete('/admin/mcp-servers/Bad_Name/oauth/user-grants/u1')
      .send({ oauthClientId: 'self://url' })
      .expect(400)
    expect(storeMock.deleteOAuthGrant).not.toHaveBeenCalled()
  })
})
