import { describe, expect, it, vi } from 'vitest'
import express from 'express'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import { config } from '../src/config.js'
import { requireInternalControlJwt } from '../src/middleware/internalControlJwt.js'

function internalControlSecretForIssuer(iss: string): string {
  return iss === 'hcc'
    ? config.internalControlJwtHccHmacSecret
    : config.internalControlJwtWrcHmacSecret
}

function signInternalControlJwt(
  iss: string,
  overrides: { audience?: string; secret?: string; expiresIn?: number } = {}
): string {
  return jwt.sign(
    {
      iss,
      aud: overrides.audience ?? 'control-api',
      sub: `${iss}-provisioner`,
    },
    overrides.secret ?? internalControlSecretForIssuer(iss),
    {
      algorithm: 'HS256',
      expiresIn: overrides.expiresIn ?? 60,
      jwtid: `${iss}-middleware-${Date.now()}`,
    }
  )
}

function makeApp() {
  const app = express()
  app.use(express.json())
  app.post('/test', requireInternalControlJwt, (req, res) => {
    res.json({
      iss: req.internalControl!.iss,
      sub: req.internalControl!.sub,
      jti: req.internalControl!.jti,
    })
  })
  return app
}

function makeLoggedApp(info: ReturnType<typeof vi.fn>) {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.log = { info } as never
    next()
  })
  app.post('/test', requireInternalControlJwt, (_req, res) => {
    res.json({ ok: true })
  })
  return app
}

describe('internalControlJwt middleware', () => {
  it('rejects requests without bearer token', async () => {
    const app = makeApp()
    const res = await request(app).post('/test').send({})
    expect(res.status).toBe(401)
  })

  it('accepts a valid HS256 InternalControl JWT', async () => {
    const app = makeApp()
    const token = signInternalControlJwt('wrc')

    const res = await request(app).post('/test').set('Authorization', `Bearer ${token}`).send({})

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      iss: 'wrc',
      sub: 'wrc-provisioner',
    })
    expect(res.body.jti).toBeTruthy()
  })

  it('logs authenticated InternalControl JWT metadata when a request logger exists', async () => {
    const info = vi.fn()
    const app = makeLoggedApp(info)
    const token = signInternalControlJwt('hcc')

    const res = await request(app).post('/test').set('Authorization', `Bearer ${token}`).send({})

    expect(res.status).toBe(200)
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'internal_control_jwt_authenticated',
        iss: 'hcc',
        sub: 'hcc-provisioner',
      }),
      'internal control jwt authenticated'
    )
  })

  it('rejects a signed JWT with wrong audience', async () => {
    const app = makeApp()
    const token = signInternalControlJwt('wrc', { audience: 'wrong-aud' })

    const res = await request(app).post('/test').set('Authorization', `Bearer ${token}`).send({})

    expect(res.status).toBe(401)
  })

  it('rejects a signed JWT with wrong HMAC secret', async () => {
    const app = makeApp()
    const token = signInternalControlJwt('wrc', { secret: 'wrong-secret' })

    const res = await request(app).post('/test').set('Authorization', `Bearer ${token}`).send({})

    expect(res.status).toBe(401)
  })

  it('rejects an HCC issuer token signed with the WRC key', async () => {
    const app = makeApp()
    const token = signInternalControlJwt('hcc', {
      secret: config.internalControlJwtWrcHmacSecret,
    })

    const res = await request(app).post('/test').set('Authorization', `Bearer ${token}`).send({})

    expect(res.status).toBe(401)
  })

  it('rejects legacy static bearer values', async () => {
    const app = makeApp()

    const res = await request(app)
      .post('/test')
      .set('Authorization', 'Bearer legacy-static-provisioner-token')
      .send({})

    expect(res.status).toBe(401)
  })
})
