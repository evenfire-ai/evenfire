import { describe, expect, it } from 'vitest'
import express from 'express'
import request from 'supertest'
import { requireMcpHostJwt } from '../src/middleware/mcpHostJwtAuth.js'
import { issueMcpHostAccessJwt, issueMcpHostRefreshJwt } from '../src/utils/auth/mcpHostJwtToken.js'

function makeApp() {
  const app = express()
  app.use(express.json())
  app.post('/test', requireMcpHostJwt, (req, res) => {
    res.json({
      namespace: req.mcpHostJwt!.recipeNamespace,
      recipe: req.mcpHostJwt!.recipeName,
      scope: req.mcpHostJwt!.scope,
    })
  })
  return app
}

describe('mcpHostJwtAuth middleware', () => {
  it('rejects requests without token', async () => {
    const app = makeApp()
    const res = await request(app).post('/test').send({})
    expect(res.status).toBe(401)
  })

  it('rejects invalid token', async () => {
    const app = makeApp()
    const res = await request(app)
      .post('/test')
      .set('Authorization', 'Bearer invalid-token')
      .send({})
    expect(res.status).toBe(401)
  })

  it('accepts valid workflow access token and sets req.mcpHostJwt', async () => {
    const app = makeApp()
    const { token } = issueMcpHostAccessJwt('ns1', 'recipe1')
    const res = await request(app).post('/test').set('Authorization', `Bearer ${token}`).send({})
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      namespace: 'ns1',
      recipe: 'recipe1',
      scope: 'workflow:approval:request',
    })
  })

  it('rejects workflow refresh token (wrong scope)', async () => {
    const app = makeApp()
    const { token } = issueMcpHostRefreshJwt('ns1', 'recipe1')
    const res = await request(app).post('/test').set('Authorization', `Bearer ${token}`).send({})
    expect(res.status).toBe(401)
  })
})
