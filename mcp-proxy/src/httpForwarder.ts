import http, { ClientRequest, IncomingMessage, ServerResponse } from 'node:http'
import https from 'node:https'

export interface ForwarderConfig {
  requestTimeout: number
  maxResponseSize: number
  maxBufferSize: number
  allowLoopbackTargets?: boolean
}

export class HttpForwarderError extends Error {
  constructor(readonly code: 'invalid_target' | 'invalid_headers') {
    super(code)
    this.name = 'HttpForwarderError'
  }
}

const REQUEST_HEADERS = [
  'authorization',
  'accept',
  'content-type',
  'mcp-session-id',
  'mcp-protocol-version',
  'last-event-id',
] as const

const RESPONSE_HEADERS = [
  'content-type',
  'content-length',
  'cache-control',
  'last-event-id',
  'mcp-session-id',
  'mcp-protocol-version',
  'retry',
] as const

function connectionTokens(headers: IncomingMessage['headers']): Set<string> {
  const value = headers.connection
  const values = Array.isArray(value) ? value : value ? [value] : []
  return new Set(
    values
      .flatMap(item => item.split(','))
      .map(item => item.trim().toLowerCase())
      .filter(Boolean)
  )
}

export function validateInternalTarget(
  backendUrl: string,
  allowLoopback = false
): URL {
  let parsed: URL
  try {
    parsed = new URL(backendUrl)
  } catch {
    throw new HttpForwarderError('invalid_target')
  }
  const host = parsed.hostname.toLowerCase()
  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1'
  const serviceHost = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.mcp-server\.svc\.cluster\.local$/.test(host)
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    (!serviceHost && !(allowLoopback && loopback)) ||
    parsed.username ||
    parsed.password ||
    parsed.hash ||
    parsed.search ||
    !parsed.pathname.startsWith('/') ||
    (parsed.port && (!/^\d+$/.test(parsed.port) || Number(parsed.port) < 1 || Number(parsed.port) > 65_535))
  ) {
    throw new HttpForwarderError('invalid_target')
  }
  return parsed
}

function responseHeaders(source: IncomingMessage['headers']): Record<string, string> {
  const result: Record<string, string> = {}
  const blocked = connectionTokens(source)
  for (const name of RESPONSE_HEADERS) {
    if (blocked.has(name)) continue
    const value = source[name]
    if (typeof value === 'string') result[name] = value
  }
  return result
}

export class HttpForwarder {
  constructor(private readonly config: ForwarderConfig) {}

  async forward(
    req: IncomingMessage,
    res: ServerResponse,
    backendUrl: string,
    body: Buffer
  ): Promise<void> {
    const parsed = validateInternalTarget(backendUrl, this.config.allowLoopbackTargets)
    const headers = this.buildHeaders(req, parsed.host, body)
    const requestModule = parsed.protocol === 'https:' ? https : http

    await new Promise<void>(resolve => {
      let settled = false
      let aborted = req.aborted || Boolean(req.socket?.destroyed) || res.destroyed
      let proxyReq: ClientRequest | undefined
      let abortHandler: (() => void) | undefined
      let responseCloseHandler: (() => void) | undefined
      const finish = () => {
        if (settled) return
        settled = true
        if (abortHandler) req.off('aborted', abortHandler)
        if (responseCloseHandler) res.off('close', responseCloseHandler)
        resolve()
      }
      const fail = (status: number, error: string) => {
        if (aborted) {
          finish()
          return
        }
        if (!res.headersSent) {
          res.writeHead(status, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store, private',
            Pragma: 'no-cache',
            'X-Content-Type-Options': 'nosniff',
          })
          res.end(JSON.stringify({ error }))
        } else {
          res.end()
        }
        finish()
      }

      abortHandler = () => {
        aborted = true
        proxyReq?.destroy()
        finish()
      }
      responseCloseHandler = () => {
        if (res.writableEnded) return
        aborted = true
        proxyReq?.destroy()
        finish()
      }
      req.once('aborted', abortHandler)
      res.once('close', responseCloseHandler)
      if (aborted) {
        finish()
        return
      }

      proxyReq = requestModule.request(
        {
          hostname: parsed.hostname,
          port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
          path: parsed.pathname,
          method: req.method,
          headers,
          timeout: this.config.requestTimeout,
        },
        proxyRes => {
          const contentLength = Number(proxyRes.headers['content-length'] ?? 0)
          if (Number.isFinite(contentLength) && contentLength > this.config.maxResponseSize) {
            proxyReq?.destroy()
            fail(503, 'authorization_unavailable')
            return
          }

          let committed = false
          let totalSize = 0
          let bufferedSize = 0
          const buffer: Buffer[] = []
          const commit = () => {
            if (committed) return
            committed = true
            res.writeHead(proxyRes.statusCode ?? 502, responseHeaders(proxyRes.headers))
            for (const chunk of buffer) res.write(chunk)
            buffer.length = 0
            bufferedSize = 0
          }

          proxyRes.on('data', chunk => {
            const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
            totalSize += part.length
            if (totalSize > this.config.maxResponseSize) {
              proxyRes.destroy()
              if (!committed) fail(503, 'authorization_unavailable')
              else {
                res.end()
                finish()
              }
              return
            }
            if (!committed) {
              buffer.push(part)
              bufferedSize += part.length
              if (bufferedSize >= this.config.maxBufferSize) commit()
            } else {
              res.write(part)
            }
          })
          proxyRes.once('data', () => {
            if (!committed) process.nextTick(commit)
          })
          proxyRes.on('end', () => {
            if (!committed) commit()
            res.end()
            finish()
          })
          proxyRes.on('error', () => fail(503, 'authorization_unavailable'))
        }
      )

      if (aborted) {
        proxyReq.destroy()
        finish()
        return
      }
      proxyReq.on('error', () => fail(503, 'authorization_unavailable'))
      proxyReq.on('timeout', () => {
        proxyReq.destroy()
        fail(503, 'authorization_unavailable')
      })
      proxyReq.end(body)
    })
  }

  private buildHeaders(
    req: IncomingMessage,
    backendHost: string,
    body: Buffer
  ): Record<string, string> {
    const result: Record<string, string> = {}
    const blocked = connectionTokens(req.headers)
    for (const name of REQUEST_HEADERS) {
      if (blocked.has(name)) continue
      const value = req.headers[name]
      if (Array.isArray(value)) throw new HttpForwarderError('invalid_headers')
      if (typeof value === 'string') result[name] = value
    }
    result.host = backendHost
    result['content-length'] = String(body.length)
    return result
  }
}
