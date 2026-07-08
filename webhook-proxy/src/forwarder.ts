import http, { IncomingMessage, ServerResponse } from 'node:http'
import type { RegistryHit } from './types'

export interface ForwardOptions {
  upstreamTimeoutMs: number
}

/**
 * Stream the inbound request through to the per-recipe gateway. The
 * proxy does NOT buffer the body — that would defeat the stream-large-
 * webhooks design and force an unnecessary memory hit. The gateway is
 * the one that has to read the raw body anyway (for HMAC).
 *
 * Header sanitation is intentionally minimal:
 *   - drop `Cookie` (defense in depth; webhooks don't use cookies)
 *   - drop hop-by-hop headers
 *   - rewrite Host to the gateway's address
 * X-Clerum-* injection / strip is the GATEWAY's job, not the proxy's.
 * The proxy must not introduce identity headers that the gateway
 * could later mis-trust.
 */
const DROP_HEADERS = new Set<string>([
  'cookie',
  'host',
  'connection',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
])

export async function forward(
  hit: RegistryHit,
  inbound: IncomingMessage,
  outbound: ServerResponse,
  opts: ForwardOptions
): Promise<{ status: number }> {
  const path = `/${encodeURIComponent(extractWebhookIdFromInbound(inbound))}`
  const headers = sanitizeHeaders(inbound.headers, hit.gateway.service)
  return new Promise(resolve => {
    const upstream = http.request(
      {
        host: `${hit.gateway.service}.${hit.gateway.namespace}.svc.cluster.local`,
        port: hit.gateway.port,
        path,
        method: inbound.method,
        headers,
        timeout: opts.upstreamTimeoutMs,
      },
      upstreamRes => {
        if (outbound.headersSent || outbound.writableEnded) {
          upstreamRes.resume()
          resolve({ status: 499 })
          return
        }
        const status = upstreamRes.statusCode || 502
        outbound.writeHead(status, filterUpstreamHeaders(upstreamRes.headers))
        upstreamRes.pipe(outbound)
        upstreamRes.on('end', () => resolve({ status }))
        upstreamRes.on('error', () => {
          if (!outbound.writableEnded) outbound.end()
          resolve({ status })
        })
      }
    )
    upstream.on('error', err => {
      if (!outbound.headersSent) {
        outbound.writeHead(502, { 'content-type': 'application/json' })
        outbound.end(JSON.stringify({ error: 'gateway_unreachable', detail: err.message }))
      } else if (!outbound.writableEnded) {
        outbound.end()
      }
      resolve({ status: 502 })
    })
    upstream.on('timeout', () => {
      upstream.destroy()
      if (!outbound.headersSent) {
        outbound.writeHead(504, { 'content-type': 'application/json' })
        outbound.end(JSON.stringify({ error: 'gateway_timeout' }))
      } else if (!outbound.writableEnded) {
        outbound.end()
      }
      resolve({ status: 504 })
    })
    inbound.on('aborted', () => {
      if (!upstream.destroyed) upstream.destroy()
    })
    inbound.pipe(upstream)
  })
}

export async function forwardToBaseUrl(
  baseUrl: string,
  inbound: IncomingMessage,
  outbound: ServerResponse,
  opts: ForwardOptions
): Promise<{ status: number }> {
  const base = new URL(baseUrl)
  const inboundUrl = new URL(inbound.url || '/', `${base.protocol}//${base.host}`)
  const headers = sanitizeHeaders(inbound.headers, base.host)
  return new Promise(resolve => {
    const upstream = http.request(
      {
        host: base.hostname,
        port: base.port ? Number(base.port) : 80,
        path: `${inboundUrl.pathname}${inboundUrl.search}`,
        method: inbound.method,
        headers,
        timeout: opts.upstreamTimeoutMs,
      },
      upstreamRes => {
        if (outbound.headersSent || outbound.writableEnded) {
          upstreamRes.resume()
          resolve({ status: 499 })
          return
        }
        const status = upstreamRes.statusCode || 502
        outbound.writeHead(status, filterUpstreamHeaders(upstreamRes.headers))
        upstreamRes.pipe(outbound)
        upstreamRes.on('end', () => resolve({ status }))
        upstreamRes.on('error', () => {
          if (!outbound.writableEnded) outbound.end()
          resolve({ status })
        })
      }
    )
    upstream.on('error', err => {
      if (!outbound.headersSent) {
        outbound.writeHead(502, { 'content-type': 'application/json' })
        outbound.end(JSON.stringify({ error: 'reader_unreachable', detail: err.message }))
      } else if (!outbound.writableEnded) {
        outbound.end()
      }
      resolve({ status: 502 })
    })
    upstream.on('timeout', () => {
      upstream.destroy()
      if (!outbound.headersSent) {
        outbound.writeHead(504, { 'content-type': 'application/json' })
        outbound.end(JSON.stringify({ error: 'reader_timeout' }))
      } else if (!outbound.writableEnded) {
        outbound.end()
      }
      resolve({ status: 504 })
    })
    inbound.on('aborted', () => {
      if (!upstream.destroyed) upstream.destroy()
    })
    inbound.pipe(upstream)
  })
}

function sanitizeHeaders(
  inbound: IncomingMessage['headers'],
  gatewayHost: string
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [rawKey, rawValue] of Object.entries(inbound)) {
    if (rawValue === undefined) continue
    const key = rawKey.toLowerCase()
    if (DROP_HEADERS.has(key)) continue
    out[key] = Array.isArray(rawValue) ? rawValue.join(', ') : String(rawValue)
  }
  out['host'] = gatewayHost
  return out
}

function filterUpstreamHeaders(headers: IncomingMessage['headers']): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {}
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue
    const lower = k.toLowerCase()
    if (DROP_HEADERS.has(lower)) continue
    out[lower] = v
  }
  return out
}

function extractWebhookIdFromInbound(req: IncomingMessage): string {
  // We've already validated the URL shape upstream — this is just a
  // best-effort segmentation for the forward path. Server.ts attaches
  // the webhookId via (req as any).webhookId before calling forward();
  // we rely on that to avoid re-parsing here.
  const id = (req as IncomingMessage & { webhookId?: string }).webhookId
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error('forward(): missing webhookId on request')
  }
  return id
}
