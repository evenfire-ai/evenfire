import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'

// Contract test for the PUBLIC wire shape of GET /api/v1/oauth/grants (spec 04
// U2). This anchors the EXACT key set the browser receives: the route projects
// through an explicit allowlist, so a new field added upstream by control-api
// must not silently leak here. If control-api's contract genuinely grows a
// field, this test is the deliberate gate that must be updated with it.
//
// T1 note: the real producer of this shape is control-api's
// `listUserOAuthGrants` → `/external/oauth/grants`, which is not stood up inside
// external-rest-api's unit env. The canonical key set below is therefore derived
// from control-api's `UserGrantSummary`/`GrantView` (owner-generalised in spec 04
// U1), and the fixture deliberately includes an EXTRA `accessToken`-like key to
// prove the allowlist strips anything the canonical set does not name.

// Auth is not the subject here — inject a passthrough so the route runs.
vi.mock('../../middleware/auth.js', () => ({
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
    next(),
  extractAuthToken: () => 'SESSION_JWT',
}))

const serviceMock = vi.hoisted(() => ({
  listOauthGrants: vi.fn(),
  revokeOauthGrant: vi.fn(),
}))
vi.mock('../../services/oauthGrantsService.js', () => serviceMock)

const GRANT_VIEW_KEYS = [
  'ownerKind',
  'recipeNamespace',
  'recipeName',
  'oauthClientId',
  'provider',
  'background',
  'updatedAt',
  'mcpServerName',
].sort()

async function makeApp() {
  const { createOauthGrantsRouter } = await import('../oauthGrants.js')
  const app = express()
  app.use(express.json())
  app.use(createOauthGrantsRouter())
  return app
}

describe('GET /oauth/grants — public wire contract (allowlist)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('projects an mcpserver grant to EXACTLY the GrantView keys, dropping unknown fields', async () => {
    serviceMock.listOauthGrants.mockResolvedValue({
      grants: [
        {
          ownerKind: 'mcpserver',
          recipeNamespace: 'mcp-servers',
          recipeName: 'gdrive',
          oauthClientId: 'self://url',
          provider: 'remote',
          background: false,
          updatedAt: '2026-09-01T00:00:00.000Z',
          mcpServerName: 'gdrive',
          // Anything not on the allowlist must NOT reach the browser.
          accessToken: 'SECRET-SHOULD-NOT-LEAK',
          refreshToken: 'SECRET-SHOULD-NOT-LEAK',
        },
      ],
    })
    const res = await request(await makeApp()).get('/oauth/grants')
    expect(res.status).toBe(200)
    expect(res.body.grants).toHaveLength(1)
    expect(Object.keys(res.body.grants[0]).sort()).toEqual(GRANT_VIEW_KEYS)
    expect(res.body.grants[0].mcpServerName).toBe('gdrive')
  })

  it('omits mcpServerName for a recipe grant (7 keys) and drops unknown fields', async () => {
    serviceMock.listOauthGrants.mockResolvedValue({
      grants: [
        {
          ownerKind: 'recipe',
          recipeNamespace: 'sandbox-recipes',
          recipeName: 'leadforge',
          oauthClientId: 'google-gmail',
          provider: 'google',
          background: true,
          updatedAt: '2026-09-01T00:00:00.000Z',
          leakedInternalId: 'nope',
        },
      ],
    })
    const res = await request(await makeApp()).get('/oauth/grants')
    expect(res.status).toBe(200)
    const keys = Object.keys(res.body.grants[0]).sort()
    expect(keys).toEqual(GRANT_VIEW_KEYS.filter(k => k !== 'mcpServerName'))
    expect(res.body.grants[0]).not.toHaveProperty('mcpServerName')
    expect(res.body.grants[0]).not.toHaveProperty('leakedInternalId')
  })
})
