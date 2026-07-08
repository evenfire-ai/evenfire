import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import type { AuthedRequest } from '../src/middleware/auth.js'
import { requireAuth, requireSelf } from '../src/middleware/auth.js'

const authTokenMock = vi.hoisted(() => ({
  verifyToken: vi.fn(),
}))

vi.mock('../src/authToken.js', () => authTokenMock)

describe('middleware/auth', () => {
  const claims = {
    userId: 'user-1',
    email: 'user@example.com',
    teamId: 'team-1',
    role: 'member' as const,
    exp: 9999999999,
  }

  beforeEach(() => {
    authTokenMock.verifyToken.mockReset()
  })

  it('rejects missing bearer token', async () => {
    const app = express()
    app.get('/protected', requireAuth, (_req, res) => res.status(200).json({ ok: true }))

    await request(app).get('/protected').expect(401)
    expect(authTokenMock.verifyToken).not.toHaveBeenCalled()
  })

  it('rejects oversized bearer token', async () => {
    const app = express()
    app.get('/protected', requireAuth, (_req, res) => res.status(200).json({ ok: true }))

    await request(app)
      .get('/protected')
      .set('authorization', `Bearer ${'a'.repeat(4097)}`)
      .expect(401)

    expect(authTokenMock.verifyToken).not.toHaveBeenCalled()
  })

  it('rejects invalid bearer token', async () => {
    authTokenMock.verifyToken.mockReturnValueOnce(null)

    const app = express()
    app.get('/protected', requireAuth, (_req, res) => res.status(200).json({ ok: true }))

    await request(app).get('/protected').set('authorization', 'Bearer bad-token').expect(401)
  })

  it('accepts valid bearer token and attaches claims', async () => {
    authTokenMock.verifyToken.mockReturnValueOnce(claims)

    const app = express()
    app.get('/protected', requireAuth, (req: AuthedRequest, res) => {
      res.status(200).json({
        userId: req.auth?.userId,
        teamId: req.auth?.teamId,
      })
    })

    const response = await request(app)
      .get('/protected')
      .set('authorization', 'Bearer good-token')
      .expect(200)

    expect(response.body).toEqual({
      userId: 'user-1',
      teamId: 'team-1',
    })
    expect(authTokenMock.verifyToken).toHaveBeenCalledWith('good-token')
  })

  it('accepts the HttpOnly profile session cookie and attaches claims', async () => {
    authTokenMock.verifyToken.mockReturnValueOnce(claims)

    const app = express()
    app.get('/protected', requireAuth, (req: AuthedRequest, res) => {
      res.status(200).json({
        userId: req.auth?.userId,
        teamId: req.auth?.teamId,
      })
    })

    const response = await request(app)
      .get('/protected')
      .set('cookie', 'profile_session=cookie-token')
      .expect(200)

    expect(response.body).toEqual({
      userId: 'user-1',
      teamId: 'team-1',
    })
    expect(authTokenMock.verifyToken).toHaveBeenCalledWith('cookie-token')
  })

  it('prefers bearer tokens over profile cookies for Desktop App callers', async () => {
    authTokenMock.verifyToken.mockReturnValueOnce(claims)

    const app = express()
    app.get('/protected', requireAuth, (req: AuthedRequest, res) => {
      res.status(200).json({ userId: req.auth?.userId })
    })

    await request(app)
      .get('/protected')
      .set('authorization', 'Bearer desktop-token')
      .set('cookie', 'profile_session=browser-cookie-token')
      .expect(200)

    expect(authTokenMock.verifyToken).toHaveBeenCalledWith('desktop-token')
  })

  it('requireSelf forbids modifying another user', async () => {
    authTokenMock.verifyToken.mockReturnValue(claims)

    const app = express()
    app.use(express.json())
    app.put('/me/profile', requireAuth, requireSelf('userId'), (_req, res) =>
      res.status(200).json({ ok: true })
    )

    await request(app)
      .put('/me/profile')
      .set('authorization', 'Bearer good-token')
      .send({ userId: 'user-2' })
      .expect(403)
  })
})
