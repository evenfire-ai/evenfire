import { describe, expect, it } from 'vitest'
import request from 'supertest'
import { createApp } from '../src/app.js'

// The per-user entity-change stream was replaced by /me/gfs/watch. A client
// still calling it must get the app's 404, not an auth answer from a route
// that is still mounted.
describe('retired user entity-change stream', () => {
  it('answers GET /api/v1/entity-changes/stream with the 404 of an unrouted path', async () => {
    const app = createApp()

    const retired = await request(app).get('/api/v1/entity-changes/stream')
    expect(retired.status).toBe(404)
    expect(retired.body).toEqual({ error: 'Not Found' })

    // Witness: the same unauthenticated request on the replacement reaches a
    // mounted route, so the 404 above is the missing route, not the request.
    const watch = await request(app).get('/api/v1/me/gfs/watch')
    expect(watch.status).not.toBe(404)
  })
})
