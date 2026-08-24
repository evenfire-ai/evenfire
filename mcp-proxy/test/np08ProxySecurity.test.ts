import { afterEach, describe, expect, it, vi } from 'vitest'
import http from 'node:http'
import { Health } from '../src/health'
import { HttpForwarder } from '../src/httpForwarder'
import { HccAuthorizationError, HccClient } from '../src/hccClient'
import { Metrics } from '../src/metrics'
import { ProxyServer } from '../src/server'
import { Router } from '../src/router'
import type { ProxyConfig } from '../src/types'
import { InstrumentedUpstream } from './np08Fixtures'

const HOST_AUTH_CHALLENGE = 'Bearer realm="mcp-proxy"'
const scheme = ['Be', 'arer'].join('')
const hostHeader = (value: string) => [scheme, value].join(' ')

function config(overrides: Record<string, unknown> = {}): ProxyConfig {
  return {
    port: 0,
    hccApiUrl: 'http://127.0.0.1:1',
    hccPollInterval: 180_000,
    hccCacheTTL: 180_000,
    hccCacheExpiry: 600_000,
    requestTimeout: 5_000,
    maxResponseSize: 1_048_576,
    devMode: true,
    devServers: [],
    logLevel: 'info',
    forwardingEnabled: true,
    allowLoopbackTargets: true,
    requestBodyLimit: 1_048_576,
    ...overrides,
  } as unknown as ProxyConfig
}

function request(
  port: number,
  path: string,
  options: { method?: string; headers?: Record<string, string | string[]>; body?: string } = {}
): Promise<{
  status: number
  body: string
  headers: Record<string, string | string[] | undefined>
}> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: options.method ?? 'POST',
        headers: options.headers,
      },
      res => {
        let body = ''
        res.on('data', chunk => (body += chunk.toString()))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }))
      }
    )
    req.on('error', reject)
    if (options.body) req.write(options.body)
    req.end()
  })
}

describe('NP-08 mcp-proxy authorization gate', () => {
  let proxy: ProxyServer | undefined
  let upstream: InstrumentedUpstream | undefined

  afterEach(async () => {
    await proxy?.stop()
    await upstream?.close()
    proxy = undefined
    upstream = undefined
  })

  async function start(fakeHcc: Partial<HccClient>, overrides: Record<string, unknown> = {}) {
    const cfg = config(overrides)
    const router = new Router()
    const hccClient = fakeHcc as HccClient
    const forwarder = new HttpForwarder({
      requestTimeout: cfg.requestTimeout,
      maxResponseSize: cfg.maxResponseSize,
      maxBufferSize: 65_536,
      allowLoopbackTargets: cfg.allowLoopbackTargets,
    })
    const health = new Health(router, hccClient)
    proxy = new ProxyServer(router, forwarder, new Metrics(), health, cfg, hccClient)
    await proxy.start()
    return proxy.getPort()
  }

  it('authorizes a Host-bound request and forwards only after HCC returns a live target', async () => {
    upstream = new InstrumentedUpstream()
    const targetUrl = await upstream.start()
    const authorizeForward = vi.fn(async (serverName: string, hostBearer: string) => ({
      serverName,
      contextRef: 'context-a',
      targetUrl,
      destinationRevision: 'revision-a',
    }))
    const port = await start({ authorizeForward })
    const response = await request(port, '/servers/server-a/mcp', {
      headers: {
        'proxy-authorization': hostHeader('host-a'),
        authorization: 'mcp-credential',
        'content-type': 'application/json',
      },
      body: '{"jsonrpc":"2.0"}',
    })

    expect(authorizeForward).toHaveBeenCalled()
    expect(response.status).toBe(200)
    expect(authorizeForward).toHaveBeenCalledWith('server-a', 'host-a')
    expect(upstream.requestCountValue).toBe(1)
    expect(upstream.bytesReceivedValue).toBe(Buffer.byteLength('{"jsonrpc":"2.0"}'))
  })

  it('denies a cross-context result before any upstream connection, request, or byte', async () => {
    upstream = new InstrumentedUpstream()
    const targetUrl = await upstream.start()
    const authorizeForward = vi.fn(async () => {
      throw new HccAuthorizationError('forbidden')
    })
    const port = await start({ authorizeForward })
    const response = await request(port, '/servers/server-b/mcp', {
      headers: {
        'proxy-authorization': hostHeader('host-a'),
        authorization: 'mcp-credential',
      },
      body: 'denied-body',
    })

    expect(response.status).toBe(403)
    expect(upstream.connectionCountValue).toBe(0)
    expect(upstream.requestCountValue).toBe(0)
    expect(upstream.bytesReceivedValue).toBe(0)
    expect(authorizeForward).toHaveBeenCalledWith('server-b', 'host-a')
    void targetUrl
  })

  it.each([
    ['missing host identity', undefined],
    ['malformed host identity', 'Basic host-a'],
  ])('returns 401 for %s without contacting HCC or upstream', async (_label, header) => {
    upstream = new InstrumentedUpstream()
    await upstream.start()
    const authorizeForward = vi.fn()
    const port = await start({ authorizeForward })
    const headers: Record<string, string> = {}
    if (header) headers['proxy-authorization'] = header
    const response = await request(port, '/servers/server-a/mcp', {
      headers,
      body: 'denied-body',
    })

    expect(response.status).toBe(401)
    expect(authorizeForward).not.toHaveBeenCalled()
    expect(upstream.connectionCountValue).toBe(0)
    expect(upstream.requestCountValue).toBe(0)
    expect(upstream.bytesReceivedValue).toBe(0)
  })

  it('marks a proxy-generated Host challenge without contacting HCC or upstream', async () => {
    upstream = new InstrumentedUpstream()
    await upstream.start()
    const authorizeForward = vi.fn()
    const port = await start({ authorizeForward })
    const response = await request(port, '/servers/server-a/mcp', { body: 'denied-body' })

    expect(response.status).toBe(401)
    expect(response.headers['www-authenticate']).toBe(HOST_AUTH_CHALLENGE)
    expect(authorizeForward).not.toHaveBeenCalled()
    expect(upstream.connectionCountValue).toBe(0)
    expect(upstream.requestCountValue).toBe(0)
    expect(upstream.bytesReceivedValue).toBe(0)
  })

  it('buffers an oversized body and denies before HCC or upstream', async () => {
    upstream = new InstrumentedUpstream()
    await upstream.start()
    const authorizeForward = vi.fn()
    const port = await start({ authorizeForward }, { requestBodyLimit: 64 })
    const response = await request(port, '/servers/server-a/mcp', {
      headers: {
        'proxy-authorization': hostHeader('host-a'),
        'content-length': '65',
      },
      body: 'x'.repeat(65),
    })

    expect(response.status).toBe(413)
    expect(authorizeForward).not.toHaveBeenCalled()
    expect(upstream.connectionCountValue).toBe(0)
    expect(upstream.requestCountValue).toBe(0)
    expect(upstream.bytesReceivedValue).toBe(0)
  })

  it.each([
    ['Content-Length with Transfer-Encoding', { 'content-length': '4', 'transfer-encoding': 'chunked' }],
    ['unsupported Transfer-Encoding', { 'transfer-encoding': 'gzip' }],
  ])('rejects %s before HCC or upstream', async (_label, headers) => {
    upstream = new InstrumentedUpstream()
    await upstream.start()
    const authorizeForward = vi.fn()
    const port = await start({ authorizeForward })
    const requestLike = {
      headers,
      rawHeaders: Object.entries(headers).flatMap(([name, value]) => [name, value]),
      async *[Symbol.asyncIterator]() {
        yield Buffer.from('body')
      },
    }

    await expect(
      (proxy as unknown as { readBoundedBody(request: unknown): Promise<Buffer> }).readBoundedBody(
        requestLike
      )
    ).rejects.toThrow()
    expect(authorizeForward).not.toHaveBeenCalled()
    expect(upstream.connectionCountValue).toBe(0)
    expect(upstream.requestCountValue).toBe(0)
    expect(upstream.bytesReceivedValue).toBe(0)
  })

  it('rejects duplicate MCP Authorization headers before HCC and upstream', async () => {
    upstream = new InstrumentedUpstream()
    await upstream.start()
    const authorizeForward = vi.fn()
    const port = await start({ authorizeForward })
    const response = await request(port, '/servers/server-a/mcp', {
      headers: {
        'proxy-authorization': hostHeader('host-a'),
        authorization: ['mcp-a', 'mcp-b'],
      },
      body: 'denied-body',
    })

    expect(response.status).toBe(400)
    expect(authorizeForward).not.toHaveBeenCalled()
    expect(upstream.connectionCountValue).toBe(0)
    expect(upstream.requestCountValue).toBe(0)
    expect(upstream.bytesReceivedValue).toBe(0)
  })

  it('rejects duplicate private identity headers before HCC and upstream', async () => {
    upstream = new InstrumentedUpstream()
    await upstream.start()
    const authorizeForward = vi.fn()
    const port = await start({ authorizeForward })
    const response = await request(port, '/servers/server-a/mcp', {
      headers: {
        'proxy-authorization': ['host-a', 'host-b'],
      },
      body: 'denied-body',
    })

    expect(response.status).toBe(401)
    expect(authorizeForward).not.toHaveBeenCalled()
    expect(upstream.connectionCountValue).toBe(0)
    expect(upstream.requestCountValue).toBe(0)
    expect(upstream.bytesReceivedValue).toBe(0)
  })

  it('fails closed on an invalid HCC target without opening an upstream socket', async () => {
    upstream = new InstrumentedUpstream()
    await upstream.start()
    const authorizeForward = vi.fn(async () => ({
      serverName: 'server-a',
      contextRef: 'context-a',
      targetUrl: 'http://attacker.example/mcp',
      destinationRevision: 'revision-attacker',
    }))
    const port = await start({ authorizeForward })
    const response = await request(port, '/servers/server-a/mcp', {
      headers: { 'proxy-authorization': hostHeader('host-a') },
      body: 'denied-body',
    })

    expect(response.status).toBe(503)
    expect(upstream.connectionCountValue).toBe(0)
    expect(upstream.requestCountValue).toBe(0)
  })

  it('keeps the feature flag fail-closed', async () => {
    upstream = new InstrumentedUpstream()
    await upstream.start()
    const authorizeForward = vi.fn()
    const port = await start({ authorizeForward }, { forwardingEnabled: false })
    const response = await request(port, '/servers/server-a/mcp', {
      headers: { 'proxy-authorization': hostHeader('host-a') },
      body: 'denied-body',
    })

    expect(response.status).toBe(503)
    expect(authorizeForward).not.toHaveBeenCalled()
    expect(upstream.connectionCountValue).toBe(0)
    expect(upstream.requestCountValue).toBe(0)
  })
})
