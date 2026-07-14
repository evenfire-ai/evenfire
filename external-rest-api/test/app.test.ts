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
})
