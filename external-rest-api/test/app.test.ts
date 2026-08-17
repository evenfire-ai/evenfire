import { describe, it } from 'vitest'
import request from 'supertest'
import { createApp } from '../src/app.js'
import { config } from '../src/config.js'

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
})
