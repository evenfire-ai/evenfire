import { describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../app.js'

vi.mock('../authToken.js', () => ({ verifyRpcToken: vi.fn() }))
vi.mock('../services/mcpProxyService.js', () => ({ resolveHostConnectionForUser: vi.fn() }))

// Desktop sends up to 8 MB of base64 images inline in the message JSON
// (COMPOSER_MAX_TOTAL_IMAGE_BASE64_BYTES); the parser must admit that plus text.
const IMAGE_BUDGET_BYTES = 8 * 1024 * 1024
const BODY_LIMIT_BYTES = 10 * 1024 * 1024

function jsonBody(dataBase64Length: number): string {
  return JSON.stringify({
    content: 'describe these images',
    attachments: [{ kind: 'image', dataBase64: 'A'.repeat(dataBase64Length) }],
  })
}

describe('rpc-proxy JSON body limit', () => {
  it('parses a body carrying the full 8 MB image budget', async () => {
    // An unrouted path: reaching the 404 handler proves the body was parsed.
    const res = await request(createApp())
      .post('/api/v1/body-limit-probe')
      .set('content-type', 'application/json')
      .send(jsonBody(IMAGE_BUDGET_BYTES))

    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'Not Found' })
  })

  it('refuses a body over 10 MB before routing', async () => {
    const body = jsonBody(BODY_LIMIT_BYTES)
    expect(body.length).toBeGreaterThan(BODY_LIMIT_BYTES)

    const res = await request(createApp())
      .post('/api/v1/body-limit-probe')
      .set('content-type', 'application/json')
      .send(body)

    // The app's error handler maps every non-timeout error, including
    // body-parser's PayloadTooLargeError, to 500.
    expect(res.status).toBe(500)
    expect(res.body).toEqual({
      error: 'Internal Server Error',
      message: 'request entity too large',
    })
  })
})
