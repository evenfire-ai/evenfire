import { describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../src/app.js'
import { MockGateway } from './mockGateway.js'

const uiAuth = vi.hoisted(() => ({
  requireAuthForControlUI: vi.fn((req: any, _res: any, next: any) => {
    req.adminAuth = { sub: 'operator', role: 'admin', jti: 'test-jti', exp: 9999999999 }
    next()
  }),
}))

vi.mock('../src/middleware/controlUIAuth.js', () => uiAuth)

describe('app GFS auth boundary', () => {
  it('returns 404 for unknown authenticated GFS UI paths before the internal service gate', async () => {
    const app = createApp(new MockGateway('mcp-server') as never)

    const res = await request(app).get('/api/v1/gfs?resourceDrive=main')

    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'Not Found' })
    expect(uiAuth.requireAuthForControlUI).toHaveBeenCalled()
  })
})
