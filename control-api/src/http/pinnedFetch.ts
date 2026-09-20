import { request as httpsRequest } from 'node:https'
import type { LookupFunction } from 'node:net'
import {
  type DnsResolver,
  type ValidationError,
  resolveValidatedOAuthEndpoint,
} from './validateMcpServerSpec.js'

/**
 * IP-pinned guarded fetch over `node:https` (spec 02 §4, DEC-16; closes H2 —
 * DNS-rebinding/TOCTOU SSRF).
 *
 * The problem it solves: `validateOAuthEndpointUrl` resolves a hostname to check
 * its IPs, but a plain `fetch(url)` RE-RESOLVES the same hostname when it connects.
 * An attacker with a low-TTL A record returns a public IP at validation and a
 * private one (169.254.169.254 / RFC1918 / `.svc`) at connect. This module removes
 * the second resolution: it resolves+validates ONCE via
 * {@link resolveValidatedOAuthEndpoint}, then pins the socket to those exact IPs
 * through the `lookup` option of `https.request`. `options.host` stays the HOSTNAME
 * so SNI / the Host header / TLS cert verification all still run against the
 * hostname — `servername` is NEVER set to the IP.
 *
 * It does ONE hop and NEVER follows redirects (a 3xx is returned verbatim, with its
 * `location`, for the caller to re-validate AND re-pin — never reuse a prior hop's
 * IP). It sends `Accept-Encoding: identity` and fails closed on any non-identity
 * `content-encoding` (rather than mis-parsing compressed bytes as JSON), caps the
 * response body, and preserves a request timeout/abort.
 *
 * The low-level transport is injectable so unit tests assert `connectedIP ===
 * validatedIP` and that `resolveDns` runs exactly once per hop, with no real network.
 */

const DEFAULT_TIMEOUT_MS = 15_000
/** 1 MiB cap — OAuth metadata documents are a few KiB; anything larger is hostile. */
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024

/** What the transport receives: a single, already-validated hop with a pinned lookup. */
export interface PinnedTransportInput {
  url: string
  method: 'GET' | 'POST'
  headers: Record<string, string>
  /**
   * A `node:net` lookup that returns ONLY the pre-validated addresses and never
   * re-resolves. The default transport hands it to `https.request`; a test
   * transport invokes it to observe which IP the socket would connect to.
   */
  lookup: LookupFunction
  signal: AbortSignal
  maxBodyBytes: number
  /** Present only for method === 'POST' (form body); C4 exchange adoption. */
  body?: string
}

export interface PinnedRawResponse {
  status: number
  /** Lowercased header map, as `node:https` `res.headers` produces. */
  headers: Record<string, string | string[] | undefined>
  bodyText: string
}

export type PinnedTransport = (input: PinnedTransportInput) => Promise<PinnedRawResponse>

export type PinnedFetchError =
  | { kind: 'kernel_rejected'; field: string; errors: ValidationError[] }
  | { kind: 'transport_failed'; detail: string }
  | { kind: 'content_encoding_rejected'; encoding: string }

export interface PinnedResponse {
  status: number
  headers: Record<string, string | string[] | undefined>
  bodyText: string
  /** The exact IPs the pin resolved and connected through — for tests/audit. */
  pinnedAddresses: string[]
}

export type PinnedFetchResult =
  | { ok: true; response: PinnedResponse }
  | { ok: false; error: PinnedFetchError }

export interface PinnedFetchOptions {
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  body?: string
  resolveDns?: DnsResolver
  transport?: PinnedTransport
  timeoutMs?: number
  maxBodyBytes?: number
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0]
  return value
}

/**
 * Build a `node:net` lookup that returns EXACTLY the validated addresses and never
 * performs DNS itself. Feeding this to `https.request` pins the socket to the IPs the
 * kernel already vetted, so no re-resolution can slip a private IP in at connect time.
 */
function pinnedLookup(addresses: string[]): LookupFunction {
  const records = addresses.map(address => ({ address, family: 4 as const }))
  const fn = (_hostname: string, options: unknown, callback: unknown): void => {
    const cb = (typeof options === 'function' ? options : callback) as (
      err: Error | null,
      address: string | Array<{ address: string; family: number }>,
      family?: number
    ) => void
    const wantsAll =
      typeof options === 'object' && options !== null && (options as { all?: boolean }).all === true
    if (wantsAll) {
      cb(null, records)
    } else {
      cb(null, records[0].address, records[0].family)
    }
  }
  return fn as unknown as LookupFunction
}

const defaultPinnedTransport: PinnedTransport = input =>
  new Promise<PinnedRawResponse>((resolve, reject) => {
    let u: URL
    try {
      u = new URL(input.url)
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)))
      return
    }
    const req = httpsRequest(
      {
        protocol: u.protocol,
        // hostname (NOT the IP) so SNI/Host/TLS cert verify against the hostname.
        hostname: u.hostname,
        port: u.port === '' ? 443 : Number(u.port),
        path: `${u.pathname}${u.search}`,
        method: input.method,
        headers: input.headers,
        // Pin: connect only to the pre-validated IPs.
        lookup: input.lookup,
        signal: input.signal,
      },
      res => {
        const chunks: Buffer[] = []
        let total = 0
        let capped = false
        res.on('data', (chunk: Buffer) => {
          if (capped) return
          total += chunk.length
          if (total > input.maxBodyBytes) {
            capped = true
            req.destroy(new Error(`response body exceeded ${input.maxBodyBytes} bytes`))
            return
          }
          chunks.push(chunk)
        })
        res.on('end', () => {
          if (capped) return
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            bodyText: Buffer.concat(chunks).toString('utf8'),
          })
        })
        res.on('error', reject)
      }
    )
    req.on('error', reject)
    if (input.body !== undefined) req.write(input.body)
    req.end()
  })

/**
 * Validate + pin + fetch a SINGLE URL (no redirect following). On a 3xx the response
 * is returned verbatim (status + `location` header) for the caller to re-validate and
 * re-pin. Fail-closed: a URL the kernel rejects is never fetched, and a non-identity
 * `content-encoding` is a typed error, not a silent mis-parse.
 */
export async function pinnedFetch(
  url: string,
  field: string,
  options: PinnedFetchOptions = {}
): Promise<PinnedFetchResult> {
  const resolved = await resolveValidatedOAuthEndpoint(url, field, {
    resolveDns: options.resolveDns,
  })
  if (!resolved.ok) {
    return { ok: false, error: { kind: 'kernel_rejected', field, errors: resolved.errors } }
  }

  const transport = options.transport ?? defaultPinnedTransport
  const headers: Record<string, string> = {
    accept: 'application/json',
    // Ask for no compression; we reject anything else rather than mis-parse it.
    'accept-encoding': 'identity',
    ...options.headers,
  }
  const signal = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)

  let raw: PinnedRawResponse
  try {
    raw = await transport({
      url,
      method: options.method ?? 'GET',
      headers,
      lookup: pinnedLookup(resolved.addresses),
      signal,
      maxBodyBytes: options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
      ...(options.body !== undefined ? { body: options.body } : {}),
    })
  } catch (e) {
    return { ok: false, error: { kind: 'transport_failed', detail: errMessage(e) } }
  }

  const encoding = firstHeaderValue(raw.headers['content-encoding'])
  if (encoding && encoding.trim().toLowerCase() !== 'identity') {
    return { ok: false, error: { kind: 'content_encoding_rejected', encoding } }
  }

  return {
    ok: true,
    response: {
      status: raw.status,
      headers: raw.headers,
      bodyText: raw.bodyText,
      pinnedAddresses: resolved.addresses,
    },
  }
}
