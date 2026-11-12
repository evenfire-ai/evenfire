import { afterEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../src/app.js'
import { config } from '../src/config.js'

// The remote MCP-OAuth CIMD client_id is `<public origin>/api/v1/.well-known/evenfire-mcp-client`
// (control-api/src/oauth/cimdIdentity.ts). A remote Authorization Server fetches it over
// the public internet, and this gateway is the public hop in front of control-api, so the
// document must be relayed here without a user session.
const CIMD_PATH = '/api/v1/.well-known/evenfire-mcp-client'

const CIMD_BODY = JSON.stringify({
  client_id: `https://example.test${CIMD_PATH}`,
  client_name: 'Evenfire',
  redirect_uris: ['https://example.test/api/v1/oauth-callback/remote'],
  token_endpoint_auth_method: 'none',
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  application_type: 'web',
})

function stubControlApi() {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(CIMD_BODY, {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    })
  )
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('CIMD document passthrough', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('relays the control-api document to an unauthenticated GET', async () => {
    const fetchMock = stubControlApi()
    const res = await request(createApp()).get(CIMD_PATH).expect(200)

    expect(res.headers['content-type']).toContain('application/json')
    expect(res.body).toEqual(JSON.parse(CIMD_BODY))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const base = config.controlApiBaseUrl.replace(/\/+$/, '')
    expect(fetchMock.mock.calls[0][0]).toBe(`${base}/.well-known/evenfire-mcp-client`)
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'GET' })
  })

  it('never forwards a caller-supplied query string', async () => {
    const fetchMock = stubControlApi()
    await request(createApp()).get(`${CIMD_PATH}?x=1&redirect=../admin`).expect(200)

    const base = config.controlApiBaseUrl.replace(/\/+$/, '')
    expect(fetchMock.mock.calls[0][0]).toBe(`${base}/.well-known/evenfire-mcp-client`)
  })

  it('relays a control-api failure status verbatim', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'cimd_base_url_unconfigured' }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      })
    )
    vi.stubGlobal('fetch', fetchMock)

    const res = await request(createApp()).get(CIMD_PATH).expect(503)
    expect(res.body).toEqual({ error: 'cimd_base_url_unconfigured' })
  })

  it('does not expose any other method or sibling path', async () => {
    const fetchMock = stubControlApi()
    const app = createApp()

    await request(app).post(CIMD_PATH).send({}).expect(404)
    await request(app).get('/api/v1/.well-known/evenfire-mcp-client/extra').expect(404)
    await request(app).get('/api/v1/.well-known/other').expect(404)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
