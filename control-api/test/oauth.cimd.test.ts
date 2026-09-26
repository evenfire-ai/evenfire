import { describe, expect, it } from 'vitest'
import express from 'express'
import request from 'supertest'
import { CIMD_ROUTE_PATH, buildCimdDocument, createCimdRouter } from '../src/oauth/cimd.js'

/**
 * CIMD document (spec 19 §5 C1, D-9 / S-6). Served read-only under /api/v1; the
 * `client_id` is byte-identical to the document's own URL (SEP-991). `getBaseUrl`
 * is injected so both the served document and the fail-closed 503 are exercised
 * without mutating the process config singleton.
 */
const ORIGIN = 'https://control.example.com'

function appWith(baseUrl: string) {
  const app = express()
  app.use('/api/v1', createCimdRouter({ getBaseUrl: () => baseUrl }))
  return app
}

describe('buildCimdDocument (frozen identity, S-6)', () => {
  it('client_id equals the document URL; redirect_uris carries the stable remote segment', () => {
    const doc = buildCimdDocument(ORIGIN)
    expect(doc.client_id).toBe('https://control.example.com/api/v1/.well-known/evenfire-mcp-client')
    expect(doc.redirect_uris).toEqual(['https://control.example.com/api/v1/oauth-callback/remote'])
    expect(doc.token_endpoint_auth_method).toBe('none')
    expect(doc.grant_types).toEqual(['authorization_code', 'refresh_token'])
    expect(doc.response_types).toEqual(['code'])
    expect(doc.application_type).toBe('web')
  })

  it('is frozen — no runtime mutation of the served identity', () => {
    const doc = buildCimdDocument(ORIGIN)
    expect(Object.isFrozen(doc)).toBe(true)
    expect(() => {
      // @ts-expect-error deliberate mutation attempt
      doc.client_id = 'https://evil.example.com'
    }).toThrow()
    expect(doc.client_id).toBe('https://control.example.com/api/v1/.well-known/evenfire-mcp-client')
  })
})

describe('createCimdRouter', () => {
  it('serves 200 + application/json with the frozen document', async () => {
    const res = await request(appWith(ORIGIN)).get('/api/v1/.well-known/evenfire-mcp-client')
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toMatch(/application\/json/)
    expect(res.headers['cache-control']).toMatch(/max-age=300/)
    expect(res.body).toEqual(buildCimdDocument(ORIGIN))
  })

  it('client_id is byte-identical to the fetch URL', async () => {
    const res = await request(appWith(ORIGIN)).get('/api/v1/.well-known/evenfire-mcp-client')
    expect(res.body.client_id).toBe(`${ORIGIN}/api/v1/.well-known/evenfire-mcp-client`)
  })

  it('two GETs return byte-identical bodies (S-6, no runtime drift)', async () => {
    const app = appWith(ORIGIN)
    const a = await request(app).get('/api/v1/.well-known/evenfire-mcp-client')
    const b = await request(app).get('/api/v1/.well-known/evenfire-mcp-client')
    expect(a.text).toBe(b.text)
  })

  it('fails closed with 503 when no base URL is configured', async () => {
    const res = await request(appWith('')).get('/api/v1/.well-known/evenfire-mcp-client')
    expect(res.status).toBe(503)
    expect(res.body).toEqual({ error: 'cimd_base_url_unconfigured' })
  })

  it('has NO write path — POST/PUT/DELETE are not routed (404/405, never mutate)', async () => {
    const app = appWith(ORIGIN)
    for (const method of ['post', 'put', 'delete', 'patch'] as const) {
      const res = await request(app)[method]('/api/v1/.well-known/evenfire-mcp-client')
      expect(res.status).not.toBe(200)
    }
  })

  it('normalizes a trailing slash in the configured base URL', async () => {
    const res = await request(appWith('https://control.example.com/')).get(
      '/api/v1/.well-known/evenfire-mcp-client'
    )
    expect(res.body.client_id).toBe(
      'https://control.example.com/api/v1/.well-known/evenfire-mcp-client'
    )
  })

  // N1: `CIMD_PUBLIC_PATH` embeds the `/api/v1` prefix that app.ts fixes with
  // `app.use('/api/v1', api)` + `api.use(createCimdRouter())`. If either side
  // drifts, the served `client_id` points at a path that is no longer routable.
  // This ties the served `client_id` path to the real mount: whatever path the
  // document advertises MUST resolve back to the document under the same mount.
  it("the served client_id path is routable under the real '/api/v1' mount", async () => {
    const app = express()
    // Mirror app.ts exactly: nested router mounted under the '/api/v1' prefix.
    const api = express.Router()
    api.use(createCimdRouter({ getBaseUrl: () => ORIGIN }))
    app.use('/api/v1', api)

    const doc = await request(app).get('/api/v1/.well-known/evenfire-mcp-client')
    expect(doc.status).toBe(200)

    // Drive the second GET from the advertised client_id, not a hardcoded path.
    const clientIdPath = new URL(doc.body.client_id).pathname
    expect(clientIdPath).toBe(`/api/v1${CIMD_ROUTE_PATH}`)
    const viaClientId = await request(app).get(clientIdPath)
    expect(viaClientId.status).toBe(200)
    expect(viaClientId.body).toEqual(doc.body)
  })
})
