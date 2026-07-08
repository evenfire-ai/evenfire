import { describe, expect, it } from 'vitest'
import express from 'express'
import request from 'supertest'
import { correlationIdMiddleware } from '../src/middleware/correlationId.js'

/**
 * Correlation-ID middleware must:
 *   1. Generate a UUIDv4 when no x-correlation-id header arrives.
 *   2. Respect a valid incoming UUID v1-v5 header (propagation).
 *   3. Reject malformed header values and fall back to a freshly generated id.
 *   4. Echo the resolved id on the response via `x-correlation-id`.
 *   5. Attach a child logger and the id to the request object.
 */
describe('correlationIdMiddleware', () => {
  function buildApp(sink: { seenId?: string; seenLog?: unknown } = {}): express.Application {
    const app = express()
    app.use(correlationIdMiddleware)
    app.get('/echo', (req, res) => {
      sink.seenId = req.correlationId
      sink.seenLog = req.log
      res.status(200).json({ id: req.correlationId ?? null })
    })
    return app
  }

  const UUID_ANY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

  it('generates a UUIDv4 when no x-correlation-id header is provided', async () => {
    const sink: { seenId?: string } = {}
    const app = buildApp(sink)
    const res = await request(app).get('/echo')
    expect(res.status).toBe(200)
    expect(typeof res.body.id).toBe('string')
    expect(res.body.id).toMatch(UUID_ANY_RE)
    expect(res.headers['x-correlation-id']).toBe(res.body.id)
    expect(sink.seenId).toBe(res.body.id)
  })

  it('respects a valid incoming UUID in x-correlation-id header', async () => {
    const inbound = '11111111-2222-4333-8444-555555555555' // valid v4
    const app = buildApp()
    const res = await request(app).get('/echo').set('x-correlation-id', inbound)
    expect(res.status).toBe(200)
    expect(res.body.id).toBe(inbound)
    expect(res.headers['x-correlation-id']).toBe(inbound)
  })

  it('rejects malformed x-correlation-id and generates a fresh UUID', async () => {
    const app = buildApp()
    const res = await request(app).get('/echo').set('x-correlation-id', 'not-a-uuid-at-all')
    expect(res.status).toBe(200)
    expect(res.body.id).not.toBe('not-a-uuid-at-all')
    expect(res.body.id).toMatch(UUID_ANY_RE)
    expect(res.headers['x-correlation-id']).toBe(res.body.id)
  })

  it('attaches a child logger (req.log) scoped to the correlation id', async () => {
    const sink: { seenLog?: unknown } = {}
    const app = buildApp(sink)
    await request(app).get('/echo')
    expect(sink.seenLog).toBeDefined()
    // pino child loggers expose `info`, `warn`, `error` as functions.
    const log = sink.seenLog as { info?: unknown; warn?: unknown; error?: unknown }
    expect(typeof log.info).toBe('function')
    expect(typeof log.warn).toBe('function')
    expect(typeof log.error).toBe('function')
  })

  it('each request gets an independent UUID', async () => {
    const app = buildApp()
    const r1 = await request(app).get('/echo')
    const r2 = await request(app).get('/echo')
    expect(r1.body.id).not.toBe(r2.body.id)
  })
})
