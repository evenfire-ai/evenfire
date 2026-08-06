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
// This handler OWNS `/control-api/*`: the next.config.js rewrite for that path was
// removed (it routed through Next's internal proxy, which silently truncates request
// bodies at 10MiB and hard-caps at a 30s proxyTimeout). Do not reintroduce the rewrite.
function resolveProxyTimeoutMs(): number {
  const raw = process.env.CONTROL_API_PROXY_TIMEOUT_MS
  const parsed = raw ? Number(raw) : Number.NaN
  return Number.isInteger(parsed) && parsed > 0 && parsed <= MAX_PROXY_TIMEOUT_MS
    ? parsed
    : DEFAULT_CONTROL_API_PROXY_TIMEOUT_MS
}

// Headers this proxy must never forward upstream. Beyond the classic RFC 9110
// hop-by-hop set, undici's fetch() refuses to send `Expect` at all — forwarding it
// throws `NotSupportedError: expect header not supported` and turns any upload
// > ~1MB from curl-like clients (which auto-add `Expect: 100-continue`) into a 502.
// Browsers can never send `Expect` (it is a fetch/XHR forbidden request header), but
// a correct proxy strips it regardless. `content-length` and `host` are recomputed
// by undici for the upstream request.
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'content-length',
  'expect',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
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
    // Fail-loud: surface the underlying cause (undici wraps the real reason in
    // err.cause) so a proxy failure is never undiagnosable from the pod logs.
    console.error('[control-api proxy] request failed', {
      url: upstreamUrl,
      method: req.method,
      status,
      message,
      name: err instanceof Error ? err.name : undefined,
      cause:
        err instanceof Error && 'cause' in err
          ? String((err as { cause?: unknown }).cause)
          : undefined,
    })
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
