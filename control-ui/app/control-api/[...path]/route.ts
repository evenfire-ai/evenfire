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

// Runtime-configurable cap on the request body this proxy will buffer, homologous
// with the gfsc write cap (GFS_MAX_WRITE_BODY_BYTES, 24MiB). This handler runs
// BEFORE any auth (auth lives in control-api, downstream), so without a cap an
// unauthenticated caller could stream an arbitrarily large body and OOM the pod.
// An absent, non-integer, non-positive, or out-of-range value falls back to the
// default. Set CONTROL_UI_PROXY_MAX_BODY_BYTES on the deployment to change it.
const DEFAULT_MAX_BODY_BYTES = 24 * 1024 * 1024
const MAX_BODY_BYTES_CEILING = 512 * 1024 * 1024
function resolveMaxBodyBytes(): number {
  const raw = process.env.CONTROL_UI_PROXY_MAX_BODY_BYTES
  const parsed = raw ? Number(raw) : Number.NaN
  return Number.isInteger(parsed) && parsed > 0 && parsed <= MAX_BODY_BYTES_CEILING
    ? parsed
    : DEFAULT_MAX_BODY_BYTES
}

// Read the request body without ever buffering more than `cap` bytes: stops and
// returns 'too-large' as soon as the running total exceeds the cap, so a huge (or
// content-length-lying) body cannot exhaust memory before it is rejected.
async function readBodyCapped(
  stream: ReadableStream<Uint8Array> | null,
  cap: number
): Promise<ArrayBuffer | null | 'too-large'> {
  if (!stream) return null
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > cap) {
        await reader.cancel()
        return 'too-large'
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  if (total === 0) return null
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out.buffer
}

// Remove CR/LF before a user-controlled value reaches a log sink (CWE-117); the
// empty-string replace enumerating the newline is the barrier CodeQL recognizes.
function stripCrlf(value: string): string {
  return value.replace(/[\n\r]/g, '')
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

function buildUpstreamUrl(req: NextRequest): string {
  const base = CONTROL_API_INTERNAL_URL.replace(/\/$/, '')
  // Forward the RAW, still-percent-encoded path — NOT the decoded [...path]
  // catch-all params. Next.js decodes catch-all segments, so `path.join('/')`
  // turns an encoded `%2F` inside an org-scoped registry name (`@org/name`) into a
  // real `/`, which splits the segment and 404s control-api's path-param routes
  // (e.g. entries/:name/versions/:version). Reading the pathname off the raw URL
  // preserves the original encoding, keeping `@org/name` a single `:name` segment
  // downstream. The `/control-api` mount prefix is stripped to match the upstream.
  const rawPath = new URL(req.url).pathname.replace(/^\/control-api(?=\/|$)/, '')
  return `${base}${rawPath}${req.nextUrl.search}`
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

// Response direction: unlike the request, KEEP `content-length` so the browser
// can show GFS download progress (the body streams through unchanged), and
// preserve EACH `set-cookie` separately — Headers.forEach collapses multiple
// set-cookie values into one, which corrupts any response that sets more than
// one cookie (e.g. admin login the day a second cookie is added to a response).
const RESPONSE_HOP_BY_HOP_HEADERS = new Set(
  [...HOP_BY_HOP_HEADERS].filter(header => header !== 'content-length')
)

function copyResponseHeaders(source: Headers): Headers {
  const headers = new Headers()
  source.forEach((value, key) => {
    const lower = key.toLowerCase()
    // set-cookie is re-added below via getSetCookie(); forEach would join them.
    if (lower === 'set-cookie') return
    if (!RESPONSE_HOP_BY_HOP_HEADERS.has(lower)) {
      headers.set(key, value)
    }
  })
  for (const cookie of source.getSetCookie()) {
    headers.append('set-cookie', cookie)
  }
  return headers
}

async function proxyControlApi(
  req: NextRequest,
  _context: { params: { path: string[] } | Promise<{ path: string[] }> }
): Promise<NextResponse> {
  // Path comes from the raw request URL (encoding-preserving), not context.params
  // (which Next.js decodes — see buildUpstreamUrl).
  const upstreamUrl = buildUpstreamUrl(req)
  const headers = copyRequestHeaders(req)

  const hasBody = req.method !== 'GET' && req.method !== 'HEAD'
  let body: ArrayBuffer | undefined
  if (hasBody) {
    const cap = resolveMaxBodyBytes()
    // Fast path: reject a declared-oversize length before reading a single byte.
    const declared = Number(req.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > cap) {
      return NextResponse.json({ error: 'payload_too_large' }, { status: 413 })
    }
    const read = await readBodyCapped(req.body, cap)
    if (read === 'too-large') {
      return NextResponse.json({ error: 'payload_too_large' }, { status: 413 })
    }
    body = read ?? undefined
  }
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
      url: stripCrlf(upstreamUrl),
      method: req.method,
      status,
      message: stripCrlf(message),
      name: err instanceof Error ? err.name : undefined,
      cause:
        err instanceof Error && 'cause' in err
          ? stripCrlf(String((err as { cause?: unknown }).cause))
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
