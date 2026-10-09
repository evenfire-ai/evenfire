import { afterEach, describe, expect, it, vi } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import request from 'supertest'
import { createApp } from '../../app.js'
import * as client from '../../controlApiClient.js'

describe('oauth-callback passthrough', () => {
  it('relays control-api response (status, content-type, HTML body) and forwards the raw query verbatim', async () => {
    const spy = vi.spyOn(client, 'controlApiPassthroughGet').mockResolvedValue({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: '<html><body>connected</body></html>',
    })

    const res = await request(createApp()).get(
      '/api/v1/oauth-callback/google-gmail?state=STATE_VALUE&code=CODE_VALUE&scope=a%20b'
    )

    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toContain('text/html')
    expect(res.text).toBe('<html><body>connected</body></html>')
    // Exact path + raw query string so the signed `state` and `code` are untouched.
    expect(spy).toHaveBeenCalledWith(
      '/oauth-callback/google-gmail',
      '?state=STATE_VALUE&code=CODE_VALUE&scope=a%20b'
    )
    spy.mockRestore()
  })

  it('is PUBLIC — no Authorization header required (auth is the signed state)', async () => {
    const spy = vi.spyOn(client, 'controlApiPassthroughGet').mockResolvedValue({
      status: 400,
      contentType: 'application/json; charset=utf-8',
      body: '{"error":"missing_code_or_state"}',
    })

    // No .set('Authorization', ...) — must still reach the handler (not 401).
    const res = await request(createApp()).get('/api/v1/oauth-callback/google-gmail')

    expect(res.status).toBe(400)
    expect(spy).toHaveBeenCalledWith('/oauth-callback/google-gmail', '')
    spy.mockRestore()
  })

  it('relays a control-api error status (e.g. invalid_state) unchanged', async () => {
    vi.spyOn(client, 'controlApiPassthroughGet').mockResolvedValue({
      status: 400,
      contentType: 'application/json; charset=utf-8',
      body: '{"error":"invalid_state"}',
    })

    const res = await request(createApp()).get(
      '/api/v1/oauth-callback/google-gmail?state=bad&code=c'
    )

    expect(res.status).toBe(400)
    expect(JSON.parse(res.text)).toEqual({ error: 'invalid_state' })
  })

  it('url-encodes the oauthClientId path segment', async () => {
    const spy = vi
      .spyOn(client, 'controlApiPassthroughGet')
      .mockResolvedValue({ status: 200, contentType: 'text/html', body: 'ok' })

    await request(createApp()).get('/api/v1/oauth-callback/weird%2Fid?code=c&state=s')

    expect(spy).toHaveBeenCalledWith('/oauth-callback/weird%2Fid', '?code=c&state=s')
    spy.mockRestore()
  })
})

// supertest resolves the URL through WHATWG URL, which collapses `%2e%2e` dot
// segments before sending. A proxy or a hand-crafted request does not, so the
// rejection cases go out over a raw socket with the path exactly as written.
async function rawGet(path: string): Promise<{ status: number }> {
  const server = createApp().listen(0)
  try {
    await new Promise<void>(resolve => server.once('listening', resolve))
    const { port } = server.address() as AddressInfo
    return await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path, method: 'GET' }, res => {
        res.resume()
        res.on('end', () => resolve({ status: res.statusCode ?? 0 }))
      })
      req.on('error', reject)
      req.end()
    })
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
}

describe('oauth-callback passthrough — per-server remote route', () => {
  const NONCE = '3f2b8c1e-9a4d-4e7f-8b21-5c6d7e8f9a0b'

  afterEach(() => {
    vi.restoreAllMocks()
  })

  function mockControlApi() {
    return vi
      .spyOn(client, 'controlApiPassthroughGet')
      .mockResolvedValue({ status: 200, contentType: 'text/html', body: 'ok' })
  }

  it('forwards a one-segment per-server callback to the exact path with the raw query', async () => {
    const spy = mockControlApi()

    const res = await request(createApp()).get(
      '/api/v1/oauth-callback/remote/atlassian?state=S&code=C&scope=a%20b'
    )

    expect(res.status).toBe(200)
    expect(res.text).toBe('ok')
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy).toHaveBeenCalledWith(
      '/oauth-callback/remote/atlassian',
      '?state=S&code=C&scope=a%20b'
    )
    spy.mockRestore()
  })

  it('forwards a two-segment (serverName + installNonce) callback to the exact path', async () => {
    const spy = mockControlApi()

    const res = await request(createApp()).get(
      `/api/v1/oauth-callback/remote/my-server-1/${NONCE}?state=S&code=C`
    )

    expect(res.status).toBe(200)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy).toHaveBeenCalledWith(
      `/oauth-callback/remote/my-server-1/${NONCE}`,
      '?state=S&code=C'
    )
    spy.mockRestore()
  })

  it('preserves a repeated iss verbatim so control-api can reject it', async () => {
    const spy = mockControlApi()

    await request(createApp()).get(
      `/api/v1/oauth-callback/remote/atlassian/${NONCE}?code=C&state=S&iss=a&iss=b`
    )

    expect(spy).toHaveBeenCalledWith(
      `/oauth-callback/remote/atlassian/${NONCE}`,
      '?code=C&state=S&iss=a&iss=b'
    )
    spy.mockRestore()
  })

  it('accepts a 63-char server name (RFC 1123 label upper bound)', async () => {
    const spy = mockControlApi()
    const name = `a${'b'.repeat(61)}c`

    const res = await request(createApp()).get(`/api/v1/oauth-callback/remote/${name}?code=C`)

    expect(res.status).toBe(200)
    expect(spy).toHaveBeenCalledWith(`/oauth-callback/remote/${name}`, '?code=C')
    spy.mockRestore()
  })

  it('keeps the shared remote callback on the one-segment route', async () => {
    const spy = mockControlApi()

    await request(createApp()).get(
      '/api/v1/oauth-callback/remote?code=C&state=S&iss=https%3A%2F%2Fas'
    )

    expect(spy).toHaveBeenCalledWith(
      '/oauth-callback/remote',
      '?code=C&state=S&iss=https%3A%2F%2Fas'
    )
    spy.mockRestore()
  })

  const rejected: Array<[string, string]> = [
    ['encoded slash traversal', '/api/v1/oauth-callback/remote/..%2Fadmin?code=C'],
    [
      'encoded slash traversal after a valid name',
      `/api/v1/oauth-callback/remote/foo/..%2F..%2Fadmin?code=C`,
    ],
    ['encoded dot-dot', '/api/v1/oauth-callback/remote/%2e%2e?code=C'],
    ['encoded dot-dot as nonce', '/api/v1/oauth-callback/remote/foo/%2e%2e?code=C'],
    ['double-encoded slash', '/api/v1/oauth-callback/remote/foo%252Fbar?code=C'],
    ['double-encoded slash as nonce', `/api/v1/oauth-callback/remote/foo/${NONCE}%252F?code=C`],
    ['uppercase UUID nonce', `/api/v1/oauth-callback/remote/foo/${NONCE.toUpperCase()}?code=C`],
    ['non-UUID nonce', '/api/v1/oauth-callback/remote/foo/not-a-uuid?code=C'],
    ['UUID without hyphens', `/api/v1/oauth-callback/remote/foo/${NONCE.replace(/-/g, '')}?code=C`],
    ['uppercase server name', '/api/v1/oauth-callback/remote/Atlassian?code=C'],
    ['leading hyphen', '/api/v1/oauth-callback/remote/-foo?code=C'],
    ['trailing hyphen', '/api/v1/oauth-callback/remote/foo-?code=C'],
    ['64-char server name', `/api/v1/oauth-callback/remote/${'a'.repeat(64)}?code=C`],
    ['empty server name before a nonce', `/api/v1/oauth-callback/remote//${NONCE}?code=C`],
    ['dot in server name', '/api/v1/oauth-callback/remote/foo.bar?code=C'],
    ['underscore in server name', '/api/v1/oauth-callback/remote/foo_bar?code=C'],
    ['extra third segment', `/api/v1/oauth-callback/remote/foo/${NONCE}/extra?code=C`],
  ]

  it.each(rejected)('404s without contacting control-api: %s', async (_label, url) => {
    const spy = mockControlApi()

    const res = await rawGet(url)

    expect(res.status).toBe(404)
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('CIMD client metadata document passthrough', () => {
  // The public URL a remote AS fetches, which is also our CIMD client_id. Must stay
  // equal to control-api's CIMD_PUBLIC_PATH (control-api/src/oauth/cimdIdentity.ts).
  const CIMD_URL = '/api/v1/.well-known/evenfire-mcp-client'

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // Liveness witness for the negative cases: the route is registered and forwards,
  // so their 404 comes from the rejection, not from a missing route.
  async function expectCimdRouteLive(spy: ReturnType<typeof mockControlApi>) {
    const res = await request(createApp()).get(CIMD_URL)
    expect(res.status).toBe(200)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy).toHaveBeenCalledWith('/.well-known/evenfire-mcp-client', '')
  }

  function mockControlApi() {
    return vi.spyOn(client, 'controlApiPassthroughGet').mockResolvedValue({
      status: 200,
      contentType: 'application/json; charset=utf-8',
      body: '{"client_id":"https://api.example.com/api/v1/.well-known/evenfire-mcp-client"}',
    })
  }

  it('is PUBLIC and relays the document (status, content-type, body) unchanged', async () => {
    const spy = mockControlApi()

    // No Authorization header: a remote AS fetches this anonymously.
    const res = await request(createApp()).get(CIMD_URL)

    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toContain('application/json')
    expect(res.text).toBe(
      '{"client_id":"https://api.example.com/api/v1/.well-known/evenfire-mcp-client"}'
    )
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy).toHaveBeenCalledWith('/.well-known/evenfire-mcp-client', '')
  })

  it('never forwards a client-supplied query string', async () => {
    const spy = mockControlApi()

    await request(createApp()).get(`${CIMD_URL}?x=1&redirect=https://evil.example`)

    expect(spy).toHaveBeenCalledWith('/.well-known/evenfire-mcp-client', '')
  })

  it('relays a control-api error status unchanged (e.g. 503 base URL unconfigured)', async () => {
    vi.spyOn(client, 'controlApiPassthroughGet').mockResolvedValue({
      status: 503,
      contentType: 'application/json; charset=utf-8',
      body: '{"error":"cimd_base_url_unconfigured"}',
    })

    const res = await request(createApp()).get(CIMD_URL)

    expect(res.status).toBe(503)
    expect(JSON.parse(res.text)).toEqual({ error: 'cimd_base_url_unconfigured' })
  })

  it.each(['post', 'put', 'delete', 'patch'] as const)(
    'does not route %s (read-only document)',
    async method => {
      const spy = mockControlApi()
      await expectCimdRouteLive(spy)

      const res = await request(createApp())[method](CIMD_URL)

      expect(res.status).toBe(404)
      expect(spy).toHaveBeenCalledTimes(1)
    }
  )

  const rejected: Array<[string, string]> = [
    ['extra segment', `${CIMD_URL}/extra`],
    ['traversal after the document', `${CIMD_URL}/..%2F..%2Fadmin`],
    ['other well-known document', '/api/v1/.well-known/openid-configuration'],
    ['sibling name', `${CIMD_URL}-x`],
  ]

  it.each(rejected)('404s without contacting control-api: %s', async (_label, url) => {
    const spy = mockControlApi()
    await expectCimdRouteLive(spy)

    const res = await rawGet(url)

    expect(res.status).toBe(404)
    expect(spy).toHaveBeenCalledTimes(1)
  })
})
