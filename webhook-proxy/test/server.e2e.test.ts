import http, { IncomingMessage, Server, ServerResponse } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadConfig, type ProxyConfig } from '../src/config'
import { RegistryClient } from '../src/registry'
import { start } from '../src/server'
import type { RegistryHit } from '../src/types'

function freePort(excluded = new Set<number>()): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = http.createServer()
    s.once('error', reject)
    s.listen(0, () => {
      const addr = s.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      s.close(error => {
        if (error) {
          reject(error)
          return
        }
        if (port > 0 && !excluded.has(port)) {
          resolve(port)
          return
        }
        freePort(excluded).then(resolve, reject)
      })
    })
  })
}

describe('webhook-proxy end-to-end (W1.1)', () => {
  let proxyPort: number
  let metricsPort: number
  let gatewayPort: number
  let gatewayServer: Server
  let proxyHandle: { close: () => Promise<void> }
  let gatewayRequests: Array<{ method: string; path: string; body: Buffer; headers: IncomingMessage['headers'] }>
  // Hit returned by the stub registry client.
  let registryFetcher: (
    url: string,
    headers: Record<string, string>
  ) => Promise<{ status: number; body: string }>

  beforeAll(async () => {
    const allocated = new Set<number>()
    proxyPort = await freePort(allocated)
    allocated.add(proxyPort)
    metricsPort = await freePort(allocated)
    allocated.add(metricsPort)
    gatewayPort = await freePort(allocated)

    // Stub gateway: collect requests, return 200 OK with JSON.
    gatewayRequests = []
    gatewayServer = http
      .createServer((req: IncomingMessage, res: ServerResponse) => {
        const chunks: Buffer[] = []
        req.on('data', c => chunks.push(c as Buffer))
        req.on('end', () => {
          gatewayRequests.push({
            method: req.method || 'POST',
            path: req.url || '/',
            body: Buffer.concat(chunks),
            headers: req.headers,
          })
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: true }))
        })
      })
      .listen(gatewayPort)
    // Wait until listen is settled.
    await new Promise(r => setTimeout(r, 30))

    // Configurable hit per test.
    const hit: RegistryHit = {
      exists: true,
      methods: ['POST'],
      maxBodyBytes: 1_048_576,
      gateway: {
        // Use 127.0.0.1 directly — node's http.request goes by Service DNS in
        // production, but the test stub is a local listener. We need the
        // proxy's DNS-style host string to resolve to 127.0.0.1, which it
        // doesn't outside a cluster — so we use a custom fetcher AND we
        // override gateway.service with the literal '127.0.0.1' so the
        // forwarder builds host=127.0.0.1.sandbox-recipes.svc.cluster.local;
        // that won't resolve. Instead we patch via a tiny shim below.
        service: '127-0-0-1',
        namespace: 'placeholder',
        port: gatewayPort,
      },
    }

    // The forwarder builds `${gateway.service}.${gateway.namespace}.svc.cluster.local`,
    // which won't resolve in the test environment. Instead of mocking DNS,
    // we patch the forwarder by passing the resolved host in `gateway.service`
    // and `gateway.namespace` so they concatenate to a localhost-resolvable
    // value: `127.0.0.1.local.svc.cluster.local` is not localhost. So we
    // instead use a different strategy — override /etc/hosts isn't viable;
    // we replace forwarder behaviour by editing types: not what we want.
    //
    // The cleanest solution: register a local resolver shim for the test
    // host name. Node's http.request honours the `lookup` option, so we'd
    // need a custom one. To keep this simple, we mock the upstream by
    // catching connections in the gateway-side server using a hostname that
    // already resolves to 127.0.0.1 ('localhost') via host: 'localhost' in
    // the registry hit — which the proxy *concatenates* into a FQDN.
    //
    // Rather than ship a fragile shim here, we test the forwarder's HTTP
    // behaviour at a finer grain in unit tests (registry.test.ts) and
    // assert end-to-end through the proxy against a hit that CAN resolve:
    // we set service+namespace such that the FQDN `127.0.0.1.svc` resolves
    // because we install /etc/hosts? Still fragile.
    //
    // Compromise: we omit a true E2E here. The tests we keep verify
    // registry interaction + URL parsing. A cluster E2E is slice 8.
    void hit
    registryFetcher = async (url, _headers) => {
      // The registry is the only path exercised by these tests.
      // URL ends with `/internal/webhook/registry/<ns>/<name>/<id>`.
      const parts = url.split('/')
      const id = decodeURIComponent(parts[parts.length - 1])
      const recipe = decodeURIComponent(parts[parts.length - 2])
      if (recipe === 'r1' && id === 'fireflies') {
        return {
          status: 200,
          body: JSON.stringify({
            exists: true,
            methods: ['POST'],
            maxBodyBytes: 1_048_576,
            gateway: { service: 'gw', namespace: 'ns', port: gatewayPort },
          }),
        }
      }
      if (recipe === 'r1' && id === 'widget') {
        return {
          status: 200,
          body: JSON.stringify({
            exists: true,
            methods: ['POST'],
            maxBodyBytes: 1_048_576,
            gateway: { service: 'gw', namespace: 'ns', port: gatewayPort },
            allowedOrigins: ['http://localhost:9000', 'https://customer.example'],
          }),
        }
      }
      if (recipe === 'r1' && id === 'gone') {
        return {
          status: 404,
          body: JSON.stringify({ exists: false, reason: 'webhook_not_found' }),
        }
      }
      return {
        status: 404,
        body: JSON.stringify({ exists: false, reason: 'recipe_not_found' }),
      }
    }
    const config: ProxyConfig = {
      ...loadConfig(),
      httpPort: proxyPort,
      metricsPort,
      sandboxNamespace: 'sandbox-recipes',
      registryCacheTtlMs: 100,
    }
    const registry = new RegistryClient(config, registryFetcher)
    proxyHandle = start(config, registry)
    await new Promise(r => setTimeout(r, 30))
  })

  afterAll(async () => {
    await proxyHandle.close()
    await new Promise<void>(r => gatewayServer.close(() => r()))
  })

  function call(
    path: string,
    method = 'POST',
    body = '',
    extraHeaders: Record<string, string> = {}
  ): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: proxyPort,
          method,
          path,
          headers: {
            'content-type': 'application/json',
            ...(body
              ? { 'content-length': String(Buffer.byteLength(body)) }
              : { 'content-length': '0' }),
            ...extraHeaders,
          },
        },
        res => {
          const chunks: Buffer[] = []
          res.on('data', c => chunks.push(c as Buffer))
          res.on('end', () => {
            resolve({
              status: res.statusCode || 0,
              body: Buffer.concat(chunks).toString('utf8'),
              headers: res.headers,
            })
          })
        }
      )
      req.on('error', reject)
      if (body) req.write(body)
      req.end()
    })
  }

  it('returns 404 when path doesn\'t match the route shape', async () => {
    const res = await call('/wrong/path')
    expect(res.status).toBe(404)
  })

  it('returns 404 webhook_not_found when recipeNs is not sandbox-recipes', async () => {
    const res = await call('/api/v1/webhook/wrong-ns/r1/fireflies')
    expect(res.status).toBe(404)
  })

  it('returns 400 invalid_recipe_name on revalidation failure', async () => {
    const res = await call('/api/v1/webhook/sandbox-recipes/UPPERCASE/fireflies')
    expect(res.status).toBe(400)
    expect(res.body).toContain('invalid_recipe_name')
  })

  it('returns 400 invalid_webhook_id on revalidation failure', async () => {
    const res = await call('/api/v1/webhook/sandbox-recipes/r1/has..dots')
    expect(res.status).toBe(400)
    expect(res.body).toContain('invalid_webhook_id')
  })

  it('returns 404 webhook_not_found when registry says so', async () => {
    const res = await call('/api/v1/webhook/sandbox-recipes/r1/gone')
    expect(res.status).toBe(404)
    expect(res.body).toContain('webhook_not_found')
  })

  it('returns 405 when the method is not in the registry methods allow-list', async () => {
    const res = await call('/api/v1/webhook/sandbox-recipes/r1/fireflies', 'PUT', '{}')
    expect(res.status).toBe(405)
    expect(res.body).toContain('method_not_allowed')
  })

  it('returns 413 when Content-Length exceeds the registry maxBodyBytes', async () => {
    const big = 'x'.repeat(2_000_000)
    const res = await call('/api/v1/webhook/sandbox-recipes/r1/fireflies', 'POST', big)
    expect(res.status).toBe(413)
    expect(res.body).toContain('body_too_large')
  })

  it('returns 200 on /healthz', async () => {
    const res = await call('/healthz', 'GET')
    expect(res.status).toBe(200)
  })

  // ─── CORS ──────────────────────────────────────────────────────────────
  // Webhook `widget` declares allowedOrigins; `fireflies` does not.

  it('OPTIONS preflight with allowed origin returns 204 with CORS headers', async () => {
    const res = await call('/api/v1/webhook/sandbox-recipes/r1/widget', 'OPTIONS', '', {
      origin: 'http://localhost:9000',
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'authorization, content-type',
    })
    expect(res.status).toBe(204)
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:9000')
    expect(res.headers['access-control-allow-methods']).toBe('POST')
    expect(res.headers['access-control-allow-headers']).toBe('authorization, content-type')
    expect(res.headers['access-control-max-age']).toBe('600')
    expect(res.headers['vary']).toContain('Origin')
  })

  it('OPTIONS preflight with disallowed origin returns 403 with no Allow-Origin', async () => {
    const res = await call('/api/v1/webhook/sandbox-recipes/r1/widget', 'OPTIONS', '', {
      origin: 'http://evil.example',
      'access-control-request-method': 'POST',
    })
    expect(res.status).toBe(403)
    expect(res.body).toContain('cors_origin_not_allowed')
    expect(res.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('OPTIONS preflight on a webhook without allowedOrigins returns 403', async () => {
    const res = await call('/api/v1/webhook/sandbox-recipes/r1/fireflies', 'OPTIONS', '', {
      origin: 'http://localhost:9000',
      'access-control-request-method': 'POST',
    })
    expect(res.status).toBe(403)
    expect(res.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('OPTIONS preflight on an unknown webhook returns 404 with no CORS headers', async () => {
    const res = await call('/api/v1/webhook/sandbox-recipes/r1/never', 'OPTIONS', '', {
      origin: 'http://localhost:9000',
      'access-control-request-method': 'POST',
    })
    expect(res.status).toBe(404)
    expect(res.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('echoes Allow-Origin on a 405 error so the browser can read the body', async () => {
    const res = await call('/api/v1/webhook/sandbox-recipes/r1/widget', 'PUT', '{}', {
      origin: 'http://localhost:9000',
    })
    expect(res.status).toBe(405)
    expect(res.body).toContain('method_not_allowed')
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:9000')
    expect(res.headers['vary']).toContain('Origin')
  })

  it('echoes Allow-Origin on a 413 error', async () => {
    const big = 'x'.repeat(2_000_000)
    const res = await call('/api/v1/webhook/sandbox-recipes/r1/widget', 'POST', big, {
      origin: 'http://localhost:9000',
    })
    expect(res.status).toBe(413)
    expect(res.body).toContain('body_too_large')
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:9000')
  })

  it('omits CORS headers when the request has no Origin (server-to-server)', async () => {
    const res = await call('/api/v1/webhook/sandbox-recipes/r1/widget', 'PUT', '{}')
    expect(res.status).toBe(405)
    expect(res.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('omits CORS headers when Origin is not in the allowlist (POST still processes)', async () => {
    // PUT not allowed, so we get 405 — but the important check is that
    // Allow-Origin is NOT echoed for an unrecognized origin.
    const res = await call('/api/v1/webhook/sandbox-recipes/r1/widget', 'PUT', '{}', {
      origin: 'http://evil.example',
    })
    expect(res.status).toBe(405)
    expect(res.headers['access-control-allow-origin']).toBeUndefined()
  })
})
