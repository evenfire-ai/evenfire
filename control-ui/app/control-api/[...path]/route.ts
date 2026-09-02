import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const CONTROL_API_INTERNAL_URL = process.env.CONTROL_API_INTERNAL_URL || 'http://127.0.0.1:8090'
const DEFAULT_CONTROL_API_PROXY_TIMEOUT_MS = 30_000
const DEFAULT_GFS_UPLOAD_PROXY_TIMEOUT_MS = 600_000

// setTimeout / AbortSignal.timeout reject non-integers and values above the 32-bit
// signed ceiling (ERR_OUT_OF_RANGE), so an out-of-range env value must NOT reach them.
const MAX_PROXY_TIMEOUT_MS = 2_147_483_647

// One resolver for every numeric env knob on this route. Absent, blank, non-integer,
// non-positive, and above-`ceiling` values all fall back to `fallback`, so a typo can
// never widen a limit or reach an API that throws on the value. The ceilings are load
// bearing in both directions: the timeout ones keep ERR_OUT_OF_RANGE away from
// setTimeout, and the byte ones keep a fat-fingered override from silently disabling
// a memory guard.
function resolvePositiveIntEnv(name: string, fallback: number, ceiling: number): number {
  const raw = process.env[name]
  const parsed = raw ? Number(raw) : Number.NaN
  return Number.isInteger(parsed) && parsed > 0 && parsed <= ceiling ? parsed : fallback
}

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
  return resolvePositiveIntEnv(
    'CONTROL_API_PROXY_TIMEOUT_MS',
    DEFAULT_CONTROL_API_PROXY_TIMEOUT_MS,
    MAX_PROXY_TIMEOUT_MS
  )
}

function resolveGfsUploadProxyTimeoutMs(): number {
  return resolvePositiveIntEnv(
    'CONTROL_UI_GFS_UPLOAD_PROXY_TIMEOUT_MS',
    DEFAULT_GFS_UPLOAD_PROXY_TIMEOUT_MS,
    MAX_PROXY_TIMEOUT_MS
  )
}

// Runtime-configurable cap on the request body this proxy will buffer, homologous
// with the gfsc write cap (GFS_MAX_WRITE_BODY_BYTES, 24MiB). This handler runs
// BEFORE any auth (auth lives in control-api, downstream), so without a cap an
// unauthenticated caller could stream an arbitrarily large body and OOM the pod.
// An absent, non-integer, non-positive, or out-of-range value falls back to the
// default. Set CONTROL_UI_PROXY_MAX_BODY_BYTES on the deployment to change it.
const DEFAULT_MAX_BODY_BYTES = 24 * 1024 * 1024
const MAX_BODY_BYTES_CEILING = 512 * 1024 * 1024
export const GFS_UPLOAD_MAX_PART_BYTES = 16 * 1024 * 1024
function resolveMaxBodyBytes(): number {
  return resolvePositiveIntEnv(
    'CONTROL_UI_PROXY_MAX_BODY_BYTES',
    DEFAULT_MAX_BODY_BYTES,
    MAX_BODY_BYTES_CEILING
  )
}

// ── Pre-auth in-flight body budget ──────────────────────────────────────────
// The cap above bounds ONE request; it does not bound N of them. This handler
// buffers BEFORE control-api authenticates, so concurrent unauthenticated callers
// each get their own cap-sized allowance and the pod has to survive the product,
// not the cap. control-ui runs a single replica under a 512Mi limit.
//
// Bound the BYTES, not the readers. A reader count is the wrong unit twice over:
//
//  1. It measures the rate at which buffers are created, not how many are alive.
//     `body` stays referenced by fetchInit for the whole upstream round trip —
//     the slow phase, at CONTROL_API_PROXY_TIMEOUT_MS = 300000 in
//     deploy/base/control-plane/control-ui.yaml — so releasing when the read
//     finishes lets buffers stack up behind a bound that looks fixed but is
//     really limit x ingest_bandwidth x upstream_latency.
//  2. It prices a 4 KiB JSON mutation and a 16 MiB upload part identically, so a
//     GFS upload wave (GFS_FILE_UPLOAD_DEFAULT_CONCURRENCY = 4 workers, each
//     holding its slot for the whole part ingest) would shed every unrelated
//     mutation in the product for the duration of the upload.
//
// Charging bytes over the whole lifetime — admission through upstream response —
// fixes both: memory is bounded directly, and a small mutation costs roughly
// nothing so it interleaves freely with an upload.
const DEFAULT_MAX_INFLIGHT_BODY_BYTES = 192 * 1024 * 1024
// Ceiling tied to the pod limit rather than an arbitrary round number: a budget
// above the memory limit cannot protect anything, so refuse to honour one.
const MAX_INFLIGHT_BODY_BYTES_CEILING = 512 * 1024 * 1024
function resolveMaxInflightBodyBytes(): number {
  return resolvePositiveIntEnv(
    'CONTROL_UI_PROXY_MAX_INFLIGHT_BODY_BYTES',
    DEFAULT_MAX_INFLIGHT_BODY_BYTES,
    MAX_INFLIGHT_BODY_BYTES_CEILING
  )
}

// While a body is being read, the chunk list AND the contiguous copy it is flattened
// into are both live, so a buffering request costs ~2x its byte length. After the
// read the chunk list is garbage and only the copy survives into the fetch. Charge
// the peak during the read, then settle down to the true resident size.
const READ_PHASE_CHARGE_MULTIPLIER = 2

// Budget sizing, written down so it can be re-derived instead of guessed at:
//
//   512Mi pod limit (deploy/base/control-plane/control-ui.yaml)
//   - ~150MiB Next.js baseline
//   = ~360MiB available, of which 192MiB is charged and ~170MiB stays headroom.
//
// 192MiB also clears a full upload wave with room to spare: 4 concurrent 16MiB
// parts peak at 4 x 16MiB x 2 = 128MiB, leaving 64MiB for the ordinary mutations
// that must keep working while someone uploads a large file.

// Idle, not total. A total read deadline would have to be generous enough for a
// 16MiB part on a domestic uplink (minutes), which is also long enough to be worth
// attacking; an idle deadline cannot be tuned around, because a client that is
// genuinely uploading always delivers another chunk. This is the only deadline on
// the read phase — the AbortSignal.timeout below covers the upstream fetch, which
// has not started yet.
const DEFAULT_BODY_READ_IDLE_TIMEOUT_MS = 30_000
function resolveBodyReadIdleTimeoutMs(): number {
  return resolvePositiveIntEnv(
    'CONTROL_UI_PROXY_BODY_READ_IDLE_TIMEOUT_MS',
    DEFAULT_BODY_READ_IDLE_TIMEOUT_MS,
    MAX_PROXY_TIMEOUT_MS
  )
}

// Module state is per-pod: `next start -p 3000` is one Node process and control-ui
// runs replicas: 1, so this is the pod's real resident pre-auth body footprint.
// It counts only THIS route's buffering — the pre-auth form handlers under
// app/admin-invitations and app/admin-password-resets buffer via req.formData()
// and are not covered here.
let inFlightBodyBytes = 0

// Tests share one module instance; a test that throws mid-read would otherwise
// leak its charge into every later test in the file.
export function __resetInFlightBodyBytesForTest(): void {
  inFlightBodyBytes = 0
}

export function __inFlightBodyBytesForTest(): number {
  return inFlightBodyBytes
}

type BodyReadFailure = 'too-large' | 'idle-timeout' | 'budget-exhausted'

// Read the request body without ever buffering more than `cap` bytes AND without
// letting the pod's total buffered bytes pass the budget. Charges each chunk as it
// arrives rather than reserving the declared length up front: a client that declares
// 24MiB and then dribbles must not be able to hold 24MiB of budget hostage while
// sending nothing. `charge` returns false when the budget is spent, which aborts the
// read; the caller releases whatever was charged.
async function readBodyCapped(
  stream: ReadableStream<Uint8Array> | null,
  cap: number,
  idleTimeoutMs: number,
  charge: (bytes: number) => boolean
): Promise<ArrayBuffer | null | BodyReadFailure> {
  if (!stream) return null
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      let idleTimer: ReturnType<typeof setTimeout> | undefined
      let result: ReadableStreamReadResult<Uint8Array> | 'idle'
      try {
        result = await Promise.race([
          reader.read(),
          new Promise<'idle'>(resolve => {
            idleTimer = setTimeout(() => resolve('idle'), idleTimeoutMs)
          }),
        ])
      } finally {
        if (idleTimer) clearTimeout(idleTimer)
      }
      // cancel() settles the read() this race abandoned, so releaseLock() below
      // never runs against a pending read.
      if (result === 'idle') {
        await reader.cancel()
        return 'idle-timeout'
      }
      const { done, value } = result
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > cap) {
        await reader.cancel()
        return 'too-large'
      }
      if (!charge(value.byteLength * READ_PHASE_CHARGE_MULTIPLIER)) {
        await reader.cancel()
        return 'budget-exhausted'
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

function buildUpstreamUrl(req: NextRequest, path: string[]): string {
  const base = CONTROL_API_INTERNAL_URL.replace(/\/$/, '')
  const proxyPrefix = '/control-api'
  // App Router decodes catch-all params, so a scoped registry name such as
  // `@org/connector` arrives in `path` with its encoded `%2F` restored to `/`.
  // Joining those params changes one route segment into two and makes the
  // upstream Express route return 404. Preserve the encoded pathname from the
  // request itself; retain an encoded-param fallback for direct handler calls.
  const upstreamPath = req.nextUrl.pathname.startsWith(`${proxyPrefix}/`)
    ? req.nextUrl.pathname.slice(proxyPrefix.length)
    : `/${path.map(segment => encodeURIComponent(segment)).join('/')}`
  return `${base}${upstreamPath}${req.nextUrl.search}`
}

function isGfsUploadRoute(req: NextRequest, path: string[]): boolean {
  if (req.method !== 'PUT') return false
  const pathname = `/${path.join('/')}`
  return /^\/api\/v1\/gfs\/proxy\/v1\/uploads\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/parts\/[0-9]+$/i.test(
    pathname
  )
}

function copyRequestHeaders(req: NextRequest): Headers {
  const headers = new Headers()
  req.headers.forEach((value, key) => {
    if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
      headers.set(key, value)
    }
  })
  const host = req.headers.get('host') ?? req.nextUrl.host
  if (host) {
    headers.set('x-forwarded-host', host)
    headers.set('x-forwarded-proto', req.nextUrl.protocol.replace(':', ''))
  }
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

// Shed rather than queue: a queued caller still holds its connection and would
// buffer the moment the budget frees, so admitting it only defers the spike.
//
// 429, not 503. The upload client puts 503 in GFS_UPLOAD_AMBIGUOUS_STATUS
// (lib/gfsFileUpload.ts), so a shed part would trigger reconcileAmbiguousPart —
// up to three 60s status probes — to establish what happened to a request that
// provably never left this process. 429 is retryable but unambiguous, so it costs
// one cheap retry instead, and it matches the repo's prior art for admission
// control at control-api/src/middleware/gfsUploadAdmission.ts.
function shedRequest(
  req: NextRequest,
  upstreamUrl: string,
  wantedBytes: number,
  budget: number
): NextResponse {
  // Without this an operator cannot tell "the proxy is shedding" from "the client
  // is broken"; both look like a failed mutation from the browser. Logged at the
  // same sink as the proxy-failure path below.
  console.error('[control-api proxy] shed request: in-flight body budget exhausted', {
    url: stripCrlf(upstreamUrl),
    method: req.method,
    wantedBytes,
    inFlightBodyBytes,
    budget,
  })
  return NextResponse.json(
    { error: 'proxy_busy' },
    { status: 429, headers: { 'retry-after': '1' } }
  )
}

async function proxyControlApi(
  req: NextRequest,
  context: { params: { path: string[] } | Promise<{ path: string[] }> }
): Promise<NextResponse> {
  const params = await context.params
  const path = Array.isArray(params.path) ? params.path : []
  const upstreamUrl = buildUpstreamUrl(req, path)
  const headers = copyRequestHeaders(req)
  const rawUpload = isGfsUploadRoute(req, path)

  // rawUpload implies PUT, so it is already covered by hasBody.
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD'

  // Charged bytes are released in the outer finally, AFTER the upstream fetch has
  // resolved and `body` is unreachable — never when the read merely finishes.
  let chargedBytes = 0
  try {
    let body: ArrayBuffer | undefined
    if (hasBody) {
      const budget = resolveMaxInflightBodyBytes()
      const cap = rawUpload ? GFS_UPLOAD_MAX_PART_BYTES : resolveMaxBodyBytes()
      const declared = Number(req.headers.get(rawUpload ? 'upload-chunk-length' : 'content-length'))

      if (rawUpload) {
        if (
          !Number.isSafeInteger(declared) ||
          declared <= 0 ||
          declared > GFS_UPLOAD_MAX_PART_BYTES
        ) {
          return NextResponse.json({ error: 'payload_too_large' }, { status: 413 })
        }
      } else if (Number.isFinite(declared) && declared > cap) {
        // Fast path: reject a declared-oversize length before reading a single byte.
        return NextResponse.json({ error: 'payload_too_large' }, { status: 413 })
      }

      // Forecast admission. Honest clients send a length, so an upload that cannot
      // fit is turned away before it buffers anything. This is a forecast, not a
      // reservation: nothing is charged until bytes actually arrive, so a dribbling
      // client cannot pin budget it never uses.
      //
      // No declared length means no forecast, NOT a cap-sized one. Assuming the cap
      // would shed every chunked request as soon as the budget was ~75% used, even
      // a 200-byte one. The per-chunk charge below is the real bound; this check
      // only saves the work of buffering a request already known not to fit.
      const forecast =
        Number.isFinite(declared) && declared > 0 ? declared * READ_PHASE_CHARGE_MULTIPLIER : 0
      if (forecast > 0 && inFlightBodyBytes + forecast > budget) {
        return shedRequest(req, upstreamUrl, forecast, budget)
      }

      const charge = (bytes: number): boolean => {
        if (inFlightBodyBytes + bytes > budget) return false
        inFlightBodyBytes += bytes
        chargedBytes += bytes
        return true
      }

      // The declared length is an admission hint, not a security boundary: `cap`
      // bounds the stream itself, so a caller cannot declare a small part and then
      // stream an unbounded body through the UI proxy.
      const read = await readBodyCapped(req.body, cap, resolveBodyReadIdleTimeoutMs(), charge)
      if (read === 'too-large') {
        return NextResponse.json({ error: 'payload_too_large' }, { status: 413 })
      }
      if (read === 'idle-timeout') {
        return NextResponse.json({ error: 'request_body_timeout' }, { status: 408 })
      }
      if (read === 'budget-exhausted') {
        return shedRequest(req, upstreamUrl, chargedBytes, budget)
      }
      if (rawUpload && (read?.byteLength ?? 0) !== declared) {
        return NextResponse.json({ error: 'upload_length_mismatch' }, { status: 400 })
      }
      body = read ?? undefined

      // The chunk list is unreachable now that it has been flattened, so drop the
      // read-phase multiplier and carry only the resident copy across the fetch.
      const resident = body?.byteLength ?? 0
      inFlightBodyBytes -= chargedBytes - resident
      chargedBytes = resident
    }
    // Only body-bearing methods (uploads/mutations) get the proxy timeout. GET/HEAD —
    // including long-lived SSE notification streams — rely solely on the client's own
    // abort signal, so this timeout can never cut a streaming response.
    const timeoutSignal = hasBody
      ? AbortSignal.timeout(rawUpload ? resolveGfsUploadProxyTimeoutMs() : resolveProxyTimeoutMs())
      : undefined
    const signal = timeoutSignal
      ? typeof AbortSignal.any === 'function'
        ? AbortSignal.any([timeoutSignal, req.signal])
        : timeoutSignal
      : req.signal

    try {
      const fetchInit: RequestInit & { duplex?: 'half' } = {
        method: req.method,
        headers,
        body,
        cache: 'no-store',
        redirect: 'manual',
        signal,
      }
      const upstream = await fetch(upstreamUrl, fetchInit)

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
        err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')
          ? 504
          : 502
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
  } finally {
    inFlightBodyBytes -= chargedBytes
  }
}

export const GET = proxyControlApi
export const POST = proxyControlApi
export const PUT = proxyControlApi
export const PATCH = proxyControlApi
export const DELETE = proxyControlApi
export const HEAD = proxyControlApi
export const OPTIONS = proxyControlApi
