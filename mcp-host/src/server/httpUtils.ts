import * as http from 'http'

// V14 fix: restrict CORS to configured origin — wildcard allows any page to call
// this API, which is a security risk if the mcp-host is ever reachable from browser context.
function getAllowedOrigins(): Set<string> {
  return new Set(
    (process.env.CLERUM_ALLOWED_ORIGINS || '')
      .split(',')
      .map(o => o.trim())
      .filter(Boolean)
  )
}

export { getAllowedOrigins }

export function setCorsHeaders(res: http.ServerResponse, origin?: string): void {
  const origins = getAllowedOrigins()
  if (origin && origins.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
}

export function json(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(payload))
}

export function unauthorized(res: http.ServerResponse, error = 'Unauthorized'): void {
  json(res, 401, { error })
}

export function forbidden(res: http.ServerResponse, error = 'Forbidden'): void {
  json(res, 403, { error })
}

export function badRequest(res: http.ServerResponse, error: string): void {
  json(res, 400, { error })
}

const DEFAULT_MAX_BODY_BYTES = 1 * 1024 * 1024 // 1MB — prevents OOM from oversized payloads

export function readBody(
  req: http.IncomingMessage,
  maxBytes = DEFAULT_MAX_BODY_BYTES
): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ''
    let size = 0
    let settled = false
    req.on('data', (chunk: Buffer) => {
      if (settled) return
      size += chunk.length
      if (size > maxBytes) {
        settled = true
        req.destroy()
        reject(new Error(`Request body exceeds ${maxBytes} bytes`))
        return
      }
      body += chunk
    })
    req.on('end', () => {
      if (!settled) {
        settled = true
        resolve(body)
      }
    })
    req.on('error', err => {
      if (!settled) {
        settled = true
        reject(err)
      }
    })
  })
}
