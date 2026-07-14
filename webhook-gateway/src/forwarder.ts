import http, { IncomingHttpHeaders, ServerResponse } from 'node:http'
import type { WebhookConfigEntry } from './types'

export interface ForwardResult {
  status: number
  /** Total time we held the connection to the handler workload (ms). */
  durationMs: number
}

export interface ForwardOptions {
  /** Bytes the verifier already validated. Forwarded byte-identical. */
  body: Buffer
  /** Sanitised header set — already stripped + injected by `headers.ts`. */
  headers: Record<string, string>
  /** Method on the inbound request (POST or GET). */
  method: 'POST' | 'GET'
  /** Forwarder-side request budget. Independent of total request lifetime. */
  upstreamTimeoutMs: number
}

/**
 * Forward a verified request to the handler workload and stream the
 * response back to `res`. Body is buffered (the verifier already read
 * it fully) so we always know Content-Length; we set it explicitly so
 * the upstream sees a well-formed request and never has to chunked-decode.
 */
export function forwardVerified(
  entry: WebhookConfigEntry,
  options: ForwardOptions,
  res: ServerResponse
): Promise<ForwardResult> {
  return new Promise<ForwardResult>(resolve => {
    const start = Date.now()
    const headers = { ...options.headers, 'content-length': String(options.body.length) }
    const upstream = http.request(
      {
        host: entry.upstream.host,
        port: entry.upstream.port,
        path: entry.upstream.path,
        method: options.method,
        headers,
        timeout: options.upstreamTimeoutMs,
      },
      upstreamRes => {
        if (res.headersSent || res.writableEnded) {
          // Inbound client gave up before we got a response. Drain upstream
          // so it doesn't block, then emit our own outcome (caller maps to 499).
          upstreamRes.resume()
          resolve({ status: 499, durationMs: Date.now() - start })
          return
        }
        const status = upstreamRes.statusCode || 502
        const responseHeaders = filterUpstreamHeaders(upstreamRes.headers)
        res.writeHead(status, responseHeaders)
        upstreamRes.pipe(res)
        upstreamRes.on('end', () => {
          resolve({ status, durationMs: Date.now() - start })
        })
        upstreamRes.on('error', () => {
          // Headers already sent — best we can do is end the stream.
          if (!res.writableEnded) res.end()
          resolve({ status, durationMs: Date.now() - start })
        })
      }
    )
    upstream.on('error', err => {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'upstream_error', message: err.message }))
      } else if (!res.writableEnded) {
        res.end()
      }
      resolve({ status: 502, durationMs: Date.now() - start })
    })
    upstream.on('timeout', () => {
      upstream.destroy()
      if (!res.headersSent) {
        res.writeHead(504, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'gateway_timeout' }))
      } else if (!res.writableEnded) {
        res.end()
      }
      resolve({ status: 504, durationMs: Date.now() - start })
    })
    upstream.write(options.body)
    upstream.end()
  })
}

/**
 * Drop hop-by-hop headers from the upstream response so the gateway
 * doesn't accidentally re-emit Connection/TE/Keep-Alive.
 */
function filterUpstreamHeaders(headers: IncomingHttpHeaders): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {}
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue
    const lower = k.toLowerCase()
    if (lower === 'connection' || lower === 'transfer-encoding' || lower === 'keep-alive') continue
    out[lower] = v
  }
  return out
}
