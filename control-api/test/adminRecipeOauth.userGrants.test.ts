import { beforeEach, describe, expect, it, vi } from 'vitest'
import express, { type NextFunction, type Request, type Response } from 'express'
import request from 'supertest'
import { createAdminRecipeOauthRouter } from '../src/routes/admin/recipeOauth.js'
import { MockGateway } from './mockGateway.js'

// Mock the pool — same pattern as routes.adminRecipeOauth.test.ts
const mockPoolQuery = vi.fn()
vi.mock('../src/db.js', () => ({
  pool: {
    query: (...args: unknown[]) => mockPoolQuery(...args),
  },
}))

// Mock the store so we can assert calls without a real DB
const storeMock = vi.hoisted(() => ({
  listUserGrantsForClient: vi.fn(),
  deleteOAuthGrant: vi.fn(),
  oauthGrantExists: vi.fn(),
}))
vi.mock('../src/oauth/store.js', () => storeMock)

const SANDBOX_NS = 'sandbox-recipes'

// Inject a fake admin auth claim the way requireAuthForControlUI would —
// the router itself is mounted bare (auth is applied at the app.ts /admin
// boundary in production). Mirror makeAuthedApp from routes.adminRecipeOauth.test.ts.
function makeAuthedApp(gateway: MockGateway, adminSub = 'admin-alice') {
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
  app.use(createAdminRecipeOauthRouter(gateway as never))
  return app
}

describe('admin per-user grants', () => {
  let gateway: MockGateway
  let app: ReturnType<typeof makeAuthedApp>

  beforeEach(() => {
    gateway = new MockGateway(SANDBOX_NS)
    app = makeAuthedApp(gateway)
    vi.clearAllMocks()
    storeMock.listUserGrantsForClient.mockResolvedValue([])
    storeMock.deleteOAuthGrant.mockResolvedValue(undefined)
    storeMock.oauthGrantExists.mockResolvedValue(false)
    mockPoolQuery.mockReset()
    mockPoolQuery.mockResolvedValue({ rows: [], rowCount: 0 })
  })

  it('GET lists user grants for the client (namespace forced to sandbox)', async () => {
    storeMock.listUserGrantsForClient.mockResolvedValue([
      { userId: 'u1', background: true, updatedAt: new Date('2026-06-02') },
    ])
    const res = await request(app)
      .get('/admin/recipes/leadforge/oauth/google-gmail/user-grants')
      .expect(200)
    expect(res.body.users[0].userId).toBe('u1')
    expect(storeMock.listUserGrantsForClient).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        recipeNamespace: SANDBOX_NS,
        recipeName: 'leadforge',
        oauthClientId: 'google-gmail',
      })
    )
  })

  it('DELETE force-revokes a specific user grant', async () => {
    const res = await request(app)
      .delete('/admin/recipes/leadforge/oauth/google-gmail/user-grants/u1')
      .expect(204)
    expect(res.status).toBe(204)
    expect(storeMock.deleteOAuthGrant).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        grantKind: 'user',
        userId: 'u1',
        recipeNamespace: SANDBOX_NS,
        recipeName: 'leadforge',
        oauthClientId: 'google-gmail',
      })
    )
  })

  it('[SEC] GET forces namespace to sandbox-recipes (ignores any path-supplied namespace)', async () => {
    storeMock.listUserGrantsForClient.mockResolvedValue([])
    await request(app)
      .get('/admin/recipes/leadforge/oauth/google-gmail/user-grants')
      .expect(200)
    const call = storeMock.listUserGrantsForClient.mock.calls[0] as unknown[]
    const key = call[1] as { recipeNamespace: string }
    expect(key.recipeNamespace).toBe(SANDBOX_NS)
  })

  it('[SEC] DELETE forces namespace to sandbox-recipes', async () => {
    await request(app)
      .delete('/admin/recipes/leadforge/oauth/google-gmail/user-grants/u1')
      .expect(204)
    const call = storeMock.deleteOAuthGrant.mock.calls[0] as unknown[]
    const input = call[1] as { recipeNamespace: string }
    expect(input.recipeNamespace).toBe(SANDBOX_NS)
  })
})
