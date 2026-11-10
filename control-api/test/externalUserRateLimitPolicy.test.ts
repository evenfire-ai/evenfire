import { describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { requireAuthenticatedExternalUserRateLimitContext } from '../src/middleware/externalUserRateLimitPolicy.js'

describe('authenticated external user context', () => {
  it('fails closed when trusted context is absent', async () => {
    const handler = vi.fn((_req, res) => res.status(204).end())
    const app = express()
    app.get('/protected', requireAuthenticatedExternalUserRateLimitContext, handler)

    await request(app).get('/protected').expect(401)
    expect(handler).not.toHaveBeenCalled()
  })

  it('continues when a trusted user context is present', async () => {
    const handler = vi.fn((_req, res) => res.status(204).end())
    const app = express()
    app.use((req, _res, next) => {
      ;(req as express.Request & { externalAuth?: { userId: string } }).externalAuth = {
        userId: 'server-user',
      }
      next()
    })
    app.get('/protected', requireAuthenticatedExternalUserRateLimitContext, handler)

    await request(app).get('/protected').expect(204)
    expect(handler).toHaveBeenCalledOnce()
  })
})
