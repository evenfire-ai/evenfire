import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const CONTROL_API_INTERNAL_URL = process.env.CONTROL_API_INTERNAL_URL || 'http://127.0.0.1:8090'
const CONTROL_API_PROXY_TIMEOUT_MS = 30_000

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'content-length',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

function buildUpstreamUrl(req: NextRequest, path: string[]): string {
  const base = CONTROL_API_INTERNAL_URL.replace(/\/$/, '')
  return `${base}/${path.join('/')}${req.nextUrl.search}`
}

function copyRequestHeaders(req: NextRequest): Headers {
  const headers = new Headers()
  req.headers.forEach((value, key) => {
    if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
      headers.set(key, value)
    }
  })
  return headers
}

function copyResponseHeaders(source: Headers): Headers {
  const headers = new Headers()
  source.forEach((value, key) => {
    if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
      headers.set(key, value)
    }
  })
  return headers
}

async function proxyControlApi(
  req: NextRequest,
  context: { params: { path: string[] } | Promise<{ path: string[] }> }
): Promise<NextResponse> {
  const params = await context.params
  const path = Array.isArray(params.path) ? params.path : []
  const upstreamUrl = buildUpstreamUrl(req, path)
  const headers = copyRequestHeaders(req)

  const hasBody = req.method !== 'GET' && req.method !== 'HEAD'
  const rawBody = hasBody ? await req.arrayBuffer() : undefined
  const body = rawBody && rawBody.byteLength > 0 ? rawBody : undefined
  const timeoutSignal = AbortSignal.timeout(CONTROL_API_PROXY_TIMEOUT_MS)
  const signal =
    typeof AbortSignal.any === 'function'
      ? AbortSignal.any([timeoutSignal, req.signal])
      : timeoutSignal

  try {
    const upstream = await fetch(upstreamUrl, {
      method: req.method,
      headers,
      body,
      cache: 'no-store',
      redirect: 'manual',
      signal,
    })

    return new NextResponse(upstream.body, {
      status: upstream.status,
      headers: copyResponseHeaders(upstream.headers),
    })
  } catch (err) {
    const message =
      err instanceof Error
        ? `control-api proxy request failed: ${err.message}`
        : 'control-api proxy request failed'
    const status =
      err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError') ? 504 : 502
    return NextResponse.json({ error: message }, { status })
  }
}

export const GET = proxyControlApi
export const POST = proxyControlApi
export const PUT = proxyControlApi
export const PATCH = proxyControlApi
export const DELETE = proxyControlApi
export const HEAD = proxyControlApi
export const OPTIONS = proxyControlApi
