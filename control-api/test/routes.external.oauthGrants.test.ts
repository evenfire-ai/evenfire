import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { config } from '../src/config.js'
import { createExternalOauthGrantsRouter } from '../src/routes/external/oauthGrants.js'

// Mock the pool used inside the router (no real DB needed).
vi.mock('../src/db.js', () => ({
  pool: { query: vi.fn() },
}))

// Mock the store so we can assert calls without a real DB.
const storeMock = vi.hoisted(() => ({
  listUserOAuthGrants: vi.fn(),
  deleteOAuthGrant: vi.fn(),
}))
vi.mock('../src/oauth/store.js', () => storeMock)

// Mirror the exact pattern from routes.external.workflowApprovalMediums.test.ts:
// mock requireValidExternalSessionToken to inject req.externalAuth.
vi.mock('../src/middleware/externalSessionAuth.js', () => ({
  requireValidExternalSessionToken: (
    req: express.Request,
    _res: express.Response,
    next: express.NextFunction
  ) => {
    ;(req as express.Request & { externalAuth?: { userId: string } }).externalAuth = {
      userId: 'user-1',
    }
    next()
  },
}))

function makeApp() {
  const app = express()
  app.use(express.json())
  app.use(createExternalOauthGrantsRouter())
  app.use(
    (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
    }
  )
  return app
}

describe('/external/oauth/grants', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    storeMock.listUserOAuthGrants.mockResolvedValue([])
    storeMock.deleteOAuthGrant.mockResolvedValue(undefined)
  })

  // T3 (route wiring): fails at the parent sha, where GET calls
  // listUserOAuthGrants(db, userId) with only two args (recipe-only) — so the
  // 'all' assertion below is not satisfied.
  it("GET lists the caller's grants of BOTH owners (ownerKind='all', userId from session)", async () => {
    storeMock.listUserOAuthGrants.mockResolvedValue([
      {
        ownerKind: 'recipe',
        recipeNamespace: 'sandbox-recipes',
        recipeName: 'leadforge',
        oauthClientId: 'google-gmail',
        provider: 'google',
        background: true,
        updatedAt: new Date('2026-06-01'),
      },
      {
        ownerKind: 'mcpserver',
        recipeNamespace: config.mcpServersNamespace,
        recipeName: 'gdrive',
        oauthClientId: 'self://url',
        provider: 'remote',
        background: false,
        updatedAt: new Date('2026-06-02'),
        mcpServerName: 'gdrive',
      },
    ])
    const res = await request(makeApp()).get('/external/oauth/grants')
    expect(res.status).toBe(200)
    expect(storeMock.listUserOAuthGrants).toHaveBeenCalledWith(expect.anything(), 'user-1', 'all')
    expect(res.body.grants[0]).toMatchObject({ ownerKind: 'recipe', recipeName: 'leadforge' })
    expect(res.body.grants[0]).not.toHaveProperty('mcpServerName')
    expect(res.body.grants[1]).toMatchObject({
      ownerKind: 'mcpserver',
      recipeName: 'gdrive',
      mcpServerName: 'gdrive',
    })
  })

  it('DELETE (default ownerKind) revokes the recipe grant, namespace forced to sandbox (userId from session)', async () => {
    const res = await request(makeApp()).delete(
      '/external/oauth/grants/anything-here/leadforge/google-gmail'
    )
    expect(res.status).toBe(204)
    expect(storeMock.deleteOAuthGrant).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        grantKind: 'user',
        ownerKind: 'recipe',
        userId: 'user-1',
        // Forced server-side, NOT taken from the vestigial path namespace.
        recipeNamespace: config.sandboxNamespace,
        recipeName: 'leadforge',
        oauthClientId: 'google-gmail',
      })
    )
  })

  // T3 (route wiring): fails at the parent sha, where DELETE never reads
  // ?ownerKind and never passes ownerKind to deleteOAuthGrant (defaults recipe)
  // nor forces the mcp-server namespace.
  it('DELETE ?ownerKind=mcpserver revokes the mcpserver grant, namespace forced to mcp-servers', async () => {
    const selfUrl = encodeURIComponent('https://as.example/.well-known/x')
    const res = await request(makeApp()).delete(
      `/external/oauth/grants/anything-here/gdrive/${selfUrl}?ownerKind=mcpserver`
    )
    expect(res.status).toBe(204)
    expect(storeMock.deleteOAuthGrant).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        grantKind: 'user',
        ownerKind: 'mcpserver',
        userId: 'user-1',
        recipeNamespace: config.mcpServersNamespace,
        recipeName: 'gdrive',
        // Arbitrary self-URL coordinate arrives as one decoded path segment.
        oauthClientId: 'https://as.example/.well-known/x',
      })
    )
  })

  it('DELETE with an invalid ownerKind is rejected 400 and never touches the store', async () => {
    const res = await request(makeApp()).delete(
      '/external/oauth/grants/anything/gdrive/client?ownerKind=bogus'
    )
    expect(res.status).toBe(400)
    expect(storeMock.deleteOAuthGrant).not.toHaveBeenCalled()
  })
})
