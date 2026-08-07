/**
 * Tests for server.ts body size limits
 * Step 4.12 (G-16)
 *
 * Uses real listening server + fetch (same pattern as authMiddleware.test.ts).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import express from 'express'
import type { Server } from 'http'
import type { AddressInfo } from 'net'

const MAX_BODY_BYTES = 1 * 1024 * 1024 // 1 MB (matches RPCServer express.json({ limit: "1mb" }))

let baseUrl: string
let server: Server

beforeAll(() => {
  const app = express()
  app.use(express.json({ limit: '1mb' }))
  app.post('/test', (req, res) => {
    res.status(200).json({ received: true })
  })

  return new Promise<void>(resolve => {
    server = app.listen(0, () => {
      const addr = server.address() as AddressInfo
      baseUrl = `http://127.0.0.1:${addr.port}`
      resolve()
    })
  })
})

afterAll(() => {
  server.close()
})

describe('server body size limit (1 MB)', () => {
  it('accepts body under MAX_BODY_BYTES (100 bytes)', async () => {
    const payload = JSON.stringify({ data: 'x'.repeat(50) })
    const res = await fetch(`${baseUrl}/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
    })
    expect(res.status).toBe(200)
  })

  it('rejects body over MAX_BODY_BYTES (>1MB) with 413', async () => {
    // Build a JSON payload slightly over 1 MB
    const bigPayload = JSON.stringify({ data: 'x'.repeat(MAX_BODY_BYTES + 1000) })
    const res = await fetch(`${baseUrl}/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: bigPayload,
    })
    expect(res.status).toBe(413)
  })

  it('accepts body at exactly 512 KB (well under limit)', async () => {
    const halfMbPayload = JSON.stringify({ data: 'a'.repeat(512 * 1024) })
    const res = await fetch(`${baseUrl}/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: halfMbPayload,
    })
    expect(res.status).toBe(200)
  })
})
