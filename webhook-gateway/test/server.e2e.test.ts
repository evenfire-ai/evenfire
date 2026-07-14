import { createHmac } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import http, { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_BUDGETS, validateGatewayConfig } from '../src/config'
import { Metrics } from '../src/metrics'
import { start } from '../src/server'
import type { GatewayConfig } from '../src/types'

const SECRET = 'test-secret'

function freePort(): Promise<number> {
  return new Promise(resolve => {
    const s = http.createServer().listen(0, () => {
      const addr = s.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      s.close(() => resolve(port))
    })
  })
}

interface UpstreamRecord {
  method: string
  path: string
  headers: Record<string, string | string[] | undefined>
  body: Buffer
}

function startUpstream(port: number, status = 200, responseBody = 'ok'): {
  records: UpstreamRecord[]
  close: () => Promise<void>
} {
  const records: UpstreamRecord[] = []
  const handler = (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', c => chunks.push(c as Buffer))
    req.on('end', () => {
      records.push({
        method: req.method || 'POST',
        path: req.url || '/',
        headers: req.headers as UpstreamRecord['headers'],
        body: Buffer.concat(chunks),
      })
      res.writeHead(status, { 'content-type': 'text/plain' })
      res.end(responseBody)
    })
  }
  const server = http.createServer(handler).listen(port)
  return {
    records,
    close: () => new Promise<void>(r => server.close(() => r())),
  }
}

describe('webhook-gateway end-to-end (W1.1)', () => {
  let dir: string
  let secretPath: string
  let upstreamPort: number
  let httpPort: number
  let metricsPort: number
  let upstream: ReturnType<typeof startUpstream>
  let gateway: { close: () => Promise<void> }
  let metrics: Metrics

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'wh-gw-e2e-'))
    secretPath = join(dir, 'signing-secret')
    writeFileSync(secretPath, SECRET, 'utf8')

    upstreamPort = await freePort()
    httpPort = await freePort()
    metricsPort = await freePort()

    upstream = startUpstream(upstreamPort)
    metrics = new Metrics()
    const config: GatewayConfig = validateGatewayConfig({
      webhooks: {
        fireflies: {
          id: 'fireflies',
          methods: ['POST'],
          maxBodyBytes: 1_048_576,
          verification: {
            scheme: 'hmac-sha256-body',
            signatureHeader: 'X-Hub-Signature-256',
            signaturePrefix: 'sha256=',
            signatureEncoding: 'hex',
            secretPath,
          },
          upstream: { host: '127.0.0.1', port: upstreamPort, path: '/handler' },
        },
      },
    })
    gateway = start({
      config,
      metrics,
      recipeNamespace: 'sandbox-recipes',
      recipeName: 'foo',
      budgets: { ...DEFAULT_BUDGETS, totalTimeoutMs: 10_000 },
      options: {
        httpPort,
        metricsPort,
        budgets: DEFAULT_BUDGETS,
        configPath: '',
        debug: false,
      },
    })
    // Tiny grace period for listen() to settle.
    await new Promise(r => setTimeout(r, 30))
  })

  afterAll(async () => {
    await gateway.close()
    await upstream.close()
    rmSync(dir, { recursive: true, force: true })
  })

  function postWebhook(
    body: string,
    sigOverride?: string,
    extraHeaders?: Record<string, string>,
    pathOverride?: string
  ): Promise<{ status: number; body: string }> {
    const sig = sigOverride ?? `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: httpPort,
          method: 'POST',
          path: pathOverride ?? '/fireflies',
          headers: {
            'content-type': 'application/json',
            'x-hub-signature-256': sig,
            'content-length': String(Buffer.byteLength(body)),
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
            })
          })
        }
      )
      req.on('error', reject)
      req.write(body)
      req.end()
    })
  }

  it('verifies + forwards a Fireflies-shaped POST end-to-end', async () => {
    const body = JSON.stringify({ event: 'meeting.created', id: 'mt-123' })
    const result = await postWebhook(body)
    expect(result.status).toBe(200)
    expect(result.body).toBe('ok')
    expect(upstream.records).toHaveLength(1)
    const rec = upstream.records[0]
    // Body forwarded byte-identical.
    expect(rec.body.toString('utf8')).toBe(body)
    // Headers stripped + injected.
    expect(rec.headers['x-hub-signature-256']).toBeUndefined()
    expect(rec.headers['authorization']).toBeUndefined()
    expect(rec.headers['cookie']).toBeUndefined()
    expect(rec.headers['x-clerum-webhook-id']).toBe('fireflies')
    expect(rec.headers['x-clerum-webhook-recipe']).toBe('sandbox-recipes/foo')
    expect(rec.headers['x-clerum-webhook-verified-at']).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/
    )
    // Provider headers preserved.
    expect(rec.headers['content-type']).toBe('application/json')
  })

  it('rejects a forged signature with 401', async () => {
    const result = await postWebhook('{"x":1}', 'sha256=' + 'a'.repeat(64))
    expect(result.status).toBe(401)
    expect(result.body).toContain('invalid_signature')
  })

  it('strips client-supplied X-Clerum-* before forwarding', async () => {
    upstream.records.length = 0
    const body = '{"x":2}'
    const result = await postWebhook(body, undefined, {
      'x-clerum-user': 'attacker',
      'X-CLERUM-Webhook-Verified-At': '1970-01-01T00:00:00Z',
    })
    expect(result.status).toBe(200)
    const rec = upstream.records[upstream.records.length - 1]
    expect(rec.headers['x-clerum-user']).toBeUndefined()
    expect(rec.headers['x-clerum-webhook-verified-at']).not.toBe('1970-01-01T00:00:00Z')
  })

  it('rejects an unknown webhookId with 404', async () => {
    const result = await postWebhook('{"x":3}', undefined, {}, '/unknown-id')
    expect(result.status).toBe(404)
    expect(result.body).toContain('webhook_not_found')
  })

  it('rejects a webhookId that fails the route regex with 400', async () => {
    // %2e%2e gets URL-decoded to '..' by Node's parser, which fails WEBHOOK_ID_RE.
    const result = await postWebhook('{"x":4}', undefined, {}, '/%2e%2e')
    expect(result.status).toBe(400)
    expect(result.body).toContain('invalid_webhook_id')
  })

  it('rejects a body larger than maxBodyBytes with 413', async () => {
    // First make the gateway think the request is huge via Content-Length header.
    const big = 'x'.repeat(2_000_000)
    const result = await postWebhook(big)
    expect(result.status).toBe(413)
    expect(result.body).toContain('body_too_large')
  })

  it('serves /metrics on the metrics port with the new metric names', async () => {
    const text = await new Promise<string>((resolve, reject) => {
      http
        .get({ host: '127.0.0.1', port: metricsPort, path: '/metrics' }, res => {
          const chunks: Buffer[] = []
          res.on('data', c => chunks.push(c as Buffer))
          res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
        })
        .on('error', reject)
    })
    expect(text).toContain('webhook_gateway_requests_total')
    expect(text).toContain('webhook_gateway_verify_total')
  })

  it('responds 200 on /healthz on both ports', async () => {
    const probe = (port: number) =>
      new Promise<number>((resolve, reject) => {
        http
          .get({ host: '127.0.0.1', port, path: '/healthz' }, res => {
            res.resume()
            resolve(res.statusCode || 0)
          })
          .on('error', reject)
      })
    expect(await probe(httpPort)).toBe(200)
    expect(await probe(metricsPort)).toBe(200)
  })
})

describe('webhook-gateway dormant (Phase 2)', () => {
  let httpPort: number
  let metricsPort: number
  let gateway: { close: () => Promise<void> }
  let metrics: Metrics

  beforeAll(async () => {
    httpPort = await freePort()
    metricsPort = await freePort()
    metrics = new Metrics()
    const config: GatewayConfig = validateGatewayConfig({
      webhooks: {
        fireflies: {
          id: 'fireflies',
          methods: ['POST'],
          maxBodyBytes: 1_048_576,
          verification: {
            scheme: 'hmac-sha256-body',
            signatureHeader: 'X-Hub-Signature-256',
            signaturePrefix: 'sha256=',
            signatureEncoding: 'hex',
            // secretPath would normally point at /run/secrets/...; for a
            // dormant entry the file may not exist. The server should
            // short-circuit before any verifier touches this path.
            secretPath: '/nonexistent/secret',
          },
          upstream: { host: '127.0.0.1', port: 1, path: '/handler' },
          dormant: true,
          dormantSecretName: 'fireflies-creds',
        },
      },
    })
    gateway = start({
      config,
      metrics,
      recipeNamespace: 'sandbox-recipes',
      recipeName: 'dormant-recipe',
      budgets: { ...DEFAULT_BUDGETS, totalTimeoutMs: 10_000 },
      options: {
        httpPort,
        metricsPort,
        budgets: DEFAULT_BUDGETS,
        configPath: '',
        debug: false,
      },
    })
    await new Promise(r => setTimeout(r, 30))
  })

  afterAll(async () => {
    await gateway.close()
  })

  function postDormant(method = 'POST'): Promise<{
    status: number
    body: string
    headers: http.IncomingHttpHeaders
  }> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: httpPort,
          method,
          path: '/fireflies',
          headers: { 'content-type': 'application/json' },
        },
        res => {
          const chunks: Buffer[] = []
          res.on('data', c => chunks.push(c as Buffer))
          res.on('end', () =>
            resolve({
              status: res.statusCode || 0,
              body: Buffer.concat(chunks).toString('utf8'),
              headers: res.headers,
            })
          )
        }
      )
      req.on('error', reject)
      req.write('{}')
      req.end()
    })
  }

  it('returns 410 + X-Clerum-Webhook-State: dormant on inbound POST', async () => {
    const result = await postDormant('POST')
    expect(result.status).toBe(410)
    expect(result.headers['x-clerum-webhook-state']).toBe('dormant')
    const body = JSON.parse(result.body)
    expect(body.error).toBe('integration_not_configured')
    expect(body.integration).toBe('fireflies')
    expect(body.hint).toMatch(/fireflies-creds/)
  })

  it('short-circuits dormant even when the verifier secret file is missing', async () => {
    // Implicit in the test above: secretPath points at /nonexistent. If
    // the dormant short-circuit fires after the verifier, this fails with
    // 500 verifier_misconfigured. Asserting 410 alone is the contract;
    // re-running explicitly here documents the invariant.
    const result = await postDormant('POST')
    expect(result.status).toBe(410)
  })
})
