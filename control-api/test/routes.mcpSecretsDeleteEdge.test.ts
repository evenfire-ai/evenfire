import { afterEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { config } from '../src/config.js'
import { createMcpSecretDeleteEdgeRateLimit } from '../src/routes/admin/secrets.js'

vi.mock('../src/services/rateLimiterService.js', () => ({ checkAndIncrement: vi.fn() }))

function edgeApp(adminSub?: string) {
  const instance = express()
  instance.use((req, _res, next) => {
    if (adminSub) {
      ;(req as express.Request & { adminAuth?: { sub: string } }).adminAuth = { sub: adminSub }
    }
    next()
  })
  instance.use(createMcpSecretDeleteEdgeRateLimit())
  // Counts the requests the edge admitted, so each denial is paired with the
  // admissions that preceded it.
  const admitted = { count: 0 }
  instance.delete('/edge', (_req, res) => {
    admitted.count += 1
    res.json({ ok: true })
  })
  return { instance, admitted }
}

describe('MCP Secret delete edge rate limit', () => {
  const original = config.adminConnectorDeleteEdgePerMin

  afterEach(() => {
    config.adminConnectorDeleteEdgePerMin = original
    vi.useRealTimers()
  })

  it('resets an admin principal on the calendar minute, like the delete ledger', async () => {
    config.adminConnectorDeleteEdgePerMin = 2
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-01-01T00:00:50.000Z'))
    const { instance, admitted } = edgeApp('admin-a')

    await request(instance).delete('/edge').expect(200)
    await request(instance).delete('/edge').expect(200)
    await request(instance).delete('/edge').expect(429)
    expect(admitted.count).toBe(2)

    // Ten seconds later the ledger's calendar minute has turned; the edge in
    // front of it must admit the same admin again.
    vi.setSystemTime(new Date('2026-01-01T00:01:00.500Z'))
    await request(instance).delete('/edge').expect(200)
    expect(admitted.count).toBe(3)
  })

  it('keeps the first-hit window for the anonymous source-IP fallback', async () => {
    config.adminConnectorDeleteEdgePerMin = 1
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-01-01T00:00:50.000Z'))
    const { instance, admitted } = edgeApp()

    await request(instance).delete('/edge').expect(200)
    await request(instance).delete('/edge').expect(429)
    // The calendar minute turning does not reset a source-IP key.
    vi.setSystemTime(new Date('2026-01-01T00:01:00.500Z'))
    await request(instance).delete('/edge').expect(429)
    expect(admitted.count).toBe(1)

    vi.setSystemTime(new Date('2026-01-01T00:01:50.500Z'))
    await request(instance).delete('/edge').expect(200)
    expect(admitted.count).toBe(2)
  })
})
