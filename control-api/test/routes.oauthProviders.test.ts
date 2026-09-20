import { describe, expect, it } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createAdminOauthProvidersRouter } from '../src/routes/admin/oauthProviders.js'

function makeApp() {
  const app = express()
  app.use(express.json())
  app.use(createAdminOauthProvidersRouter())
  app.use(
    (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ error: err instanceof Error ? err.message : 'unknown' })
    }
  )
  return app
}

describe('GET /admin/oauth/providers/:id/credential-manifest', () => {
  it('returns the manifest for a known baked provider', async () => {
    const res = await request(makeApp())
      .get('/admin/oauth/providers/google/credential-manifest')
      .expect(200)
    expect(res.body.provider).toBe('google')
    expect(Array.isArray(res.body.fields)).toBe(true)
    const names = res.body.fields.map((f: { name: string }) => f.name)
    expect(names).toContain('client_id')
    expect(names).toContain('client_secret')
  })

  it('404s for an unknown provider id', async () => {
    const res = await request(makeApp())
      .get('/admin/oauth/providers/not-a-provider/credential-manifest')
      .expect(404)
    expect(res.body.error).toMatch(/Unknown OAuth provider/)
  })

  it("404s for the 'generic' sentinel (Slice 1 serves only the 8 baked)", async () => {
    await request(makeApp()).get('/admin/oauth/providers/generic/credential-manifest').expect(404)
  })
})
