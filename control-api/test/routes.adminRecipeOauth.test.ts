import { beforeEach, describe, expect, it, vi } from 'vitest'
import express, { type NextFunction, type Request, type Response } from 'express'
import request from 'supertest'
import { createAdminRecipeOauthRouter } from '../src/routes/admin/recipeOauth.js'
import { MockGateway } from './mockGateway.js'

const mockPoolQuery = vi.fn()

vi.mock('../src/db.js', () => ({
  pool: {
    query: (...args: unknown[]) => mockPoolQuery(...args),
  },
}))

const SANDBOX_NS = 'sandbox-recipes'

function b64(s: string): string {
  return Buffer.from(s).toString('base64')
}

// Inject a fake admin auth claim the way requireAuthForControlUI would —
// the router itself is mounted bare (auth is applied at the app.ts /admin
// boundary in production).
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

function seedRecipe(gateway: MockGateway, opts: { name: string; backgroundAccess?: boolean }) {
  return gateway.createResource(
    'workflowrecipes',
    {
      metadata: { name: opts.name },
      spec: {
        oauthClients: [
          {
            id: 'salesforce',
            provider: 'salesforce',
            clientIdRef: { name: 'sf-creds', key: 'client-id' },
            clientSecretRef: { name: 'sf-creds', key: 'client-secret' },
            scopes: ['api', 'refresh_token'],
            ...(opts.backgroundAccess ? { backgroundAccess: true } : {}),
          },
        ],
      },
    },
    SANDBOX_NS
  )
}

describe('routes/admin/recipeOauth', () => {
  let gateway: MockGateway
  let app: ReturnType<typeof makeAuthedApp>

  beforeEach(() => {
    gateway = new MockGateway(SANDBOX_NS)
    app = makeAuthedApp(gateway)
    mockPoolQuery.mockReset()
    mockPoolQuery.mockResolvedValue({ rows: [], rowCount: 0 })
  })

  describe('POST /admin/recipes/:name/oauth/:clientId/connect', () => {
    it('mints a service authorize URL when the client opted into backgroundAccess', async () => {
      await seedRecipe(gateway, { name: 'crm', backgroundAccess: true })
      gateway.seedSecret('sf-creds', SANDBOX_NS, {
        data: { 'client-id': b64('CID'), 'client-secret': b64('CSEC') },
      })
      const res = await request(app).post('/admin/recipes/crm/oauth/salesforce/connect').expect(200)
      expect(typeof res.body.authorizeUrl).toBe('string')
      expect(res.body.authorizeUrl).toContain('state=')
    })

    it('[SEC-4] rejects connect for a client that did not opt into backgroundAccess', async () => {
      await seedRecipe(gateway, { name: 'crm', backgroundAccess: false })
      gateway.seedSecret('sf-creds', SANDBOX_NS, {
        data: { 'client-id': b64('CID'), 'client-secret': b64('CSEC') },
      })
      const res = await request(app).post('/admin/recipes/crm/oauth/salesforce/connect').expect(400)
      expect(res.body.error).toBe('background_access_not_enabled')
    })

    it('returns 404 when the recipe does not exist', async () => {
      const res = await request(app)
        .post('/admin/recipes/missing/oauth/salesforce/connect')
        .expect(404)
      expect(res.body.error).toBe('recipe_not_found')
    })

    it('returns 503 integration_not_configured when the client Secret is absent', async () => {
      await seedRecipe(gateway, { name: 'crm', backgroundAccess: true })
      // No seedSecret — the K8s Secret is missing.
      const res = await request(app).post('/admin/recipes/crm/oauth/salesforce/connect').expect(503)
      expect(res.body.error).toBe('integration_not_configured')
    })

    it('rejects an invalid recipe name with 400', async () => {
      const res = await request(app)
        .post('/admin/recipes/Bad_Name/oauth/salesforce/connect')
        .expect(400)
      expect(res.body.error).toBe('invalid_request')
    })
  })

  describe('GET /admin/recipes/:name/oauth/:clientId/status', () => {
    it('reports connected:false when no service grant row exists', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 })
      const res = await request(app).get('/admin/recipes/crm/oauth/salesforce/status').expect(200)
      expect(res.body).toEqual({ connected: false })
    })

    it('reports connected:true when a service grant row exists', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [{ exists: 1 }], rowCount: 1 })
      const res = await request(app).get('/admin/recipes/crm/oauth/salesforce/status').expect(200)
      expect(res.body).toEqual({ connected: true })
      const [sql, params] = mockPoolQuery.mock.calls[0] as [string, unknown[]]
      expect(sql).toContain("grant_kind = 'service'")
      expect(sql).toContain('user_id IS NULL')
      expect(params).toEqual(['recipe', SANDBOX_NS, 'crm', 'salesforce'])
    })
  })

  describe('DELETE /admin/recipes/:name/oauth/:clientId/grant', () => {
    it('deletes the service grant and returns 204', async () => {
      await request(app).delete('/admin/recipes/crm/oauth/salesforce/grant').expect(204)
      const [sql, params] = mockPoolQuery.mock.calls[0] as [string, unknown[]]
      expect(sql).toContain('DELETE FROM oauth_grants')
      expect(sql).toContain("grant_kind = 'service'")
      expect(params).toEqual(['recipe', SANDBOX_NS, 'crm', 'salesforce'])
    })
  })
})
