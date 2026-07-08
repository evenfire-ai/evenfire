import { describe, expect, it, vi } from 'vitest'
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
