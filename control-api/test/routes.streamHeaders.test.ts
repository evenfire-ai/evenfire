import { describe, expect, it } from 'vitest'
import express from 'express'
import request from 'supertest'
import { setStreamHeaders } from '../src/routes/streamHeaders.js'

describe('setStreamHeaders', () => {
  it('commits a 200 NDJSON stream that proxies must neither buffer nor transform', async () => {
    const app = express()
    app.get('/stream', (_req, res) => {
      setStreamHeaders(res)
      expect(res.headersSent).toBe(true)
      res.end('{"type":"ready"}\n')
    })
    const response = await request(app).get('/stream')
    expect(response.status).toBe(200)
    expect(response.headers['content-type']).toBe('application/x-ndjson; charset=utf-8')
    expect(response.headers['cache-control']).toBe('no-cache, no-transform')
    expect(response.headers['x-accel-buffering']).toBe('no')
    expect(response.text).toBe('{"type":"ready"}\n')
  })
})
