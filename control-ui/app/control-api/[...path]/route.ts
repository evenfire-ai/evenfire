import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const CONTROL_API_INTERNAL_URL = process.env.CONTROL_API_INTERNAL_URL || 'http://127.0.0.1:8090'
const DEFAULT_CONTROL_API_PROXY_TIMEOUT_MS = 30_000

// setTimeout / AbortSignal.timeout reject non-integers and values above the 32-bit
// signed ceiling (ERR_OUT_OF_RANGE), so an out-of-range env value must NOT reach them.
const MAX_PROXY_TIMEOUT_MS = 2_147_483_647

// Runtime-configurable server-side timeout (NOT NEXT_PUBLIC: read at request time in
// the control-ui pod, mirroring CONTROL_API_INTERNAL_URL above). GFS uploads send the
// file base64-encoded, so a ~10 MB payload over the Cloudflare tunnel can exceed the
// old fixed 30s. Set CONTROL_API_PROXY_TIMEOUT_MS (milliseconds) on the deployment to
// raise it; an absent, non-integer, non-positive, or out-of-range value falls back to
// the default.
//
// NOTE: currently LATENT — `/control-api/*` is served by the next.config.js rewrite
// (afterFiles precedence shadows this catch-all route handler), so this timeout does
// not govern prod today. It becomes effective once the proxy is consolidated onto this
// handler (tracked follow-up); the client-side upload timeout in lib/api.ts is what
// unblocks prod now.
function resolveProxyTimeoutMs(): number {
  const raw = process.env.CONTROL_API_PROXY_TIMEOUT_MS
  const parsed = raw ? Number(raw) : Number.NaN
  return Number.isInteger(parsed) && parsed > 0 && parsed <= MAX_PROXY_TIMEOUT_MS
    ? parsed
    : DEFAULT_CONTROL_API_PROXY_TIMEOUT_MS
}

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
  // Only body-bearing methods (uploads/mutations) get the proxy timeout. GET/HEAD —
  // including long-lived SSE notification streams — rely solely on the client's own
  // abort signal, so this timeout can never cut a streaming response.
  const timeoutSignal = hasBody ? AbortSignal.timeout(resolveProxyTimeoutMs()) : undefined
  const signal = timeoutSignal
    ? typeof AbortSignal.any === 'function'
      ? AbortSignal.any([timeoutSignal, req.signal])
      : timeoutSignal
    : req.signal

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
