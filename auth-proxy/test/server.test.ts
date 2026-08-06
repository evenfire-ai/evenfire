import { afterEach, describe, expect, it } from 'vitest'
import http, { IncomingMessage, ServerResponse } from 'node:http'
import { AuthProxyConfig } from '../src/config'
import { buildUpstreamUrl, parseCallbackRoute, start } from '../src/server'

const openHandles: Array<{ close: () => Promise<void> }> = []

afterEach(async () => {
  await Promise.all(openHandles.splice(0).map(handle => handle.close()))
})

describe('auth-proxy callback routing', () => {
  it('forwards Microsoft identity-provider callbacks with service-token auth', async () => {
    const seen: Array<{ method: string; url: string; auth: string; service: string }> = []
    const upstream = await startFakeUpstream((req, res) => {
      seen.push({
        method: req.method || '',
        url: req.url || '',
        auth: String(req.headers.authorization || ''),
        service: String(req.headers['x-service-token'] || ''),
      })
      res.writeHead(303, {
        location: 'http://127.0.0.1:3000/settings/integrations?connected=microsoft',
      })
      res.end()
    })
    openHandles.push(upstream)

    const proxy = start({
      ...testConfig,
      controlApiBaseUrl: `http://127.0.0.1:${upstream.port}/api/v1`,
    })
    openHandles.push(proxy)

    const res = await fetch(
      `http://127.0.0.1:${await waitForPort(proxy.httpPort)}/api/v1/identity-provider-callback/microsoft?code=CODE&state=STATE`,
      { redirect: 'manual' }
    )

    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe(
      'http://127.0.0.1:3000/settings/integrations?connected=microsoft'
    )
    expect(seen).toEqual([
      {
        method: 'GET',
        url: '/api/v1/internal/auth-callback/identity-provider-callback/microsoft?code=CODE&state=STATE',
        auth: 'Bearer test-auth-proxy-token',
        service: 'auth-proxy',
      },
    ])
  })

  it('forwards recipe OAuth callbacks without decoding the registered client segment', async () => {
    const seen: string[] = []
    const upstream = await startFakeUpstream((req, res) => {
      seen.push(req.url || '')
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<p>ok</p>')
    })
    openHandles.push(upstream)

    const proxy = start({
      ...testConfig,
      controlApiBaseUrl: `http://127.0.0.1:${upstream.port}/api/v1`,
    })
    openHandles.push(proxy)

    const res = await fetch(
      `http://127.0.0.1:${await waitForPort(proxy.httpPort)}/api/v1/oauth-callback/weird%2Fid?state=S&code=C&scope=a%20b`
    )

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('<p>ok</p>')
    expect(seen).toEqual([
      '/api/v1/internal/auth-callback/oauth-callback/weird%2Fid?state=S&code=C&scope=a%20b',
    ])
  })

  it('does not behave like a general reverse proxy', async () => {
    const proxy = start(testConfig)
    openHandles.push(proxy)

    const res = await fetch(
      `http://127.0.0.1:${await waitForPort(proxy.httpPort)}/api/v1/auth/providers`
    )

    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'not_found' })
  })

  it('rejects non-GET callback requests without forwarding upstream', async () => {
    const proxy = start(testConfig)
    openHandles.push(proxy)

    const res = await fetch(
      `http://127.0.0.1:${await waitForPort(proxy.httpPort)}/api/v1/identity-provider-callback/microsoft?code=CODE&state=STATE`,
      { method: 'POST' }
    )

    expect(res.status).toBe(405)
    expect(await res.json()).toEqual({ error: 'method_not_allowed' })
  })

  it('returns a stable 502 when the upstream cannot be reached', async () => {
    const proxy = start({ ...testConfig, controlApiBaseUrl: 'http://127.0.0.1:1/api/v1' })
    openHandles.push(proxy)

    const res = await fetch(
      `http://127.0.0.1:${await waitForPort(proxy.httpPort)}/api/v1/identity-provider-callback/microsoft?code=CODE&state=STATE`
    )

    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ error: 'upstream_unavailable' })
  })

  it('returns a stable 504 when the upstream times out', async () => {
    const upstream = await startFakeUpstream(() => {
      // Intentionally leave the response open until auth-proxy aborts the request.
    })
    openHandles.push(upstream)

    const proxy = start({
      ...testConfig,
      controlApiBaseUrl: `http://127.0.0.1:${upstream.port}/api/v1`,
      upstreamTimeoutMs: 10,
    })
    openHandles.push(proxy)

    const res = await fetch(
      `http://127.0.0.1:${await waitForPort(proxy.httpPort)}/api/v1/identity-provider-callback/microsoft?code=CODE&state=STATE`
    )

    expect(res.status).toBe(504)
    expect(await res.json()).toEqual({ error: 'upstream_timeout' })
  })

  it('rejects upstream callback responses that exceed the configured body limit', async () => {
    const upstream = await startFakeUpstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('abcdef')
    })
    openHandles.push(upstream)

    const proxy = start({
      ...testConfig,
      controlApiBaseUrl: `http://127.0.0.1:${upstream.port}/api/v1`,
      maxResponseBytes: 3,
    })
    openHandles.push(proxy)

    const res = await fetch(
      `http://127.0.0.1:${await waitForPort(proxy.httpPort)}/api/v1/identity-provider-callback/microsoft?code=CODE&state=STATE`
    )

    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ error: 'upstream_response_too_large' })
  })

  it('returns a stable 500 shape for unexpected handler failures', async () => {
    const proxy = start({
      ...testConfig,
      get upstreamTimeoutMs() {
        throw new Error('unexpected test failure')
      },
    } as AuthProxyConfig)
    openHandles.push(proxy)

    const res = await fetch(
      `http://127.0.0.1:${await waitForPort(proxy.httpPort)}/api/v1/identity-provider-callback/microsoft?code=CODE&state=STATE`
    )

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'internal_error' })
  })
})

describe('route parsing', () => {
  it('builds the expected internal callback URLs', () => {
    expect(
      buildUpstreamUrl('http://control-api:8090/api/v1/', {
        kind: 'identity-provider',
        query: '?code=CODE&state=STATE',
      })
    ).toBe(
      'http://control-api:8090/api/v1/internal/auth-callback/identity-provider-callback/microsoft?code=CODE&state=STATE'
    )
    expect(
      buildUpstreamUrl('http://control-api:8090/api/v1', {
        kind: 'oauth',
        oauthClientId: 'google-gmail',
        query: '?state=S',
      })
    ).toBe(
      'http://control-api:8090/api/v1/internal/auth-callback/oauth-callback/google-gmail?state=S'
    )
  })

  it('accepts only callback paths', () => {
    expect(parseCallbackRoute('/api/v1/oauth-callback/google-gmail?code=C')).toEqual({
      kind: 'oauth',
      oauthClientId: 'google-gmail',
      query: '?code=C',
    })
    expect(parseCallbackRoute('/api/v1/identity-provider-callback/microsoft?state=a?b')).toEqual({
      kind: 'identity-provider',
      query: '?state=a?b',
    })
    expect(parseCallbackRoute('/api/v1/auth/providers')).toBeNull()
  })
})

const testConfig: AuthProxyConfig = {
  httpPort: 0,
  metricsPort: 0,
  controlApiBaseUrl: 'http://127.0.0.1:1/api/v1',
  controlApiServiceToken: 'test-auth-proxy-token',
  controlApiServiceName: 'auth-proxy',
  upstreamTimeoutMs: 5_000,
  maxResponseBytes: 1_048_576,
}

async function startFakeUpstream(
  handler: (req: IncomingMessage, res: ServerResponse) => void
): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer(handler)
  await new Promise<void>(resolve => server.listen(0, resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fake upstream did not bind')
  return {
    port: address.port,
    close: () =>
      new Promise(resolve => {
        server.close(() => resolve())
      }),
  }
}

async function waitForPort(readPort: () => number): Promise<number> {
  for (let i = 0; i < 20; i += 1) {
    const port = readPort()
    if (port > 0) return port
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('server did not bind a port')
}
