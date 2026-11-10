import { describe, expect, it } from 'vitest'
import request from 'supertest'
import { createApp } from '../src/app.js'
import { config } from '../src/config.js'
import { PROFILE_SESSION_COOKIE } from '../src/sessionCookie.js'

describe('external-rest-api app wiring', () => {
  it('accepts JSON bodies above the former 1 MiB parser limit', async () => {
    const app = createApp()
    const payload = 'x'.repeat(1024 * 1024 + 64 * 1024)

    await request(app).post('/does-not-exist').send({ payload }).expect(404)
  })

  it('returns 413 when a JSON body exceeds the configured parser limit', async () => {
    const previousLimit = config.jsonBodyLimit
    config.jsonBodyLimit = '1kb'
    try {
      const app = createApp()
      const payload = 'x'.repeat(2048)

      await request(app).post('/does-not-exist').send({ payload }).expect(413)
    } finally {
      config.jsonBodyLimit = previousLimit
    }
  })

  it('keeps malformed upload IDs on the binary route instead of the JSON parser', async () => {
    const app = createApp()
    await request(app)
      .put('/api/v1/me/gfs/uploads/not-a-uuid/parts/0')
      .set('content-type', 'application/json')
      .send(Buffer.from([0xff, 0x00, 0x01]))
      // Auth is intentionally the first route-level response. A 400 JSON
      // parser error here would prove the binary bypass regressed.
      .expect(401)
  })

  it('mounts the browser-mutation guard on the real app', async () => {
    const previousCorsOrigin = config.corsOrigin
    config.corsOrigin = ['https://profile.example']
    try {
      const app = createApp()
      const sessionCookie = `${PROFILE_SESSION_COOKIE}=x`

      // Witness: a trusted-origin mutation passes the guard and reaches routing.
      const trusted = await request(app)
        .post('/does-not-exist')
        .set('origin', 'https://profile.example')
        .set('cookie', sessionCookie)
      expect(trusted.status).toBe(404)
      expect(trusted.body).toEqual({ error: 'Not Found' })

      // The unrouted path comes first: only the guard can answer it with 403 (without the
      // guard it gets the witness's 404), so a missing guard fails here before the logout
      // handler, which calls control-api, can run.
      for (const path of ['/does-not-exist', '/api/v1/auth/logout']) {
        const untrustedOrigin = await request(app)
          .post(path)
          .set('origin', 'https://evil.example')
          .set('cookie', sessionCookie)
        expect(untrustedOrigin.status).toBe(403)
        expect(untrustedOrigin.body).toMatchObject({ error: { code: 'forbidden' } })

        const crossSite = await request(app)
          .post(path)
          .set('sec-fetch-site', 'cross-site')
          .set('cookie', sessionCookie)
        expect(crossSite.status).toBe(403)
        expect(crossSite.body).toMatchObject({ error: { code: 'forbidden' } })
      }
    } finally {
      config.corsOrigin = previousCorsOrigin
    }
  })
})
