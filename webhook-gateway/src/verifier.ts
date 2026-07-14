import {
  constants as cryptoConstants,
  createPublicKey,
  createHmac,
  timingSafeEqual,
  verify as cryptoVerify,
} from 'node:crypto'
import type { KeyObject } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { IncomingHttpHeaders } from 'node:http'
import type { VerifyOutcome, WebhookConfigEntry } from './types'

/**
 * Read a signing secret from disk and return its raw bytes. We use
 * `Buffer` (not `string`) so embedded NULs / non-utf8 bytes survive.
 * Trailing newlines are stripped because `kubectl create secret` adds
 * them and providers sign without them.
 */
export function readSecretFromPath(path: string): Buffer {
  const raw = readFileSync(path)
  // Strip a single trailing \n if present — common Secret-on-disk artefact.
  if (raw.length > 0 && raw[raw.length - 1] === 0x0a) {
    return raw.subarray(0, raw.length - 1)
  }
  return raw
}

/**
 * Decode the per-scheme signature value from its wire encoding into raw
 * bytes for `timingSafeEqual`. Returns `null` on malformed input — the
 * caller maps that to `invalid_signature` (NOT a 4xx telling the
 * attacker their decode failed).
 */
function decodeSignature(value: string, encoding: 'hex' | 'base64'): Buffer | null {
  try {
    if (encoding === 'hex') {
      // Buffer.from(hex) silently truncates on odd length → reject explicitly.
      if (value.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(value)) return null
      return Buffer.from(value, 'hex')
    }
    if (!/^[A-Za-z0-9+/=]+$/.test(value)) return null
    return Buffer.from(value, 'base64')
  } catch {
    return null
  }
}

/**
 * Pull a single header value as a lowercase-keyed lookup. Returns
 * `undefined` if the header is absent or arrives multiple times (we
 * reject duplicates — providers don't send dup signature headers, and
 * accepting them lets an attacker stuff a forged value alongside a
 * valid one).
 */
function singleHeader(headers: IncomingHttpHeaders, lowercaseName: string): string | undefined {
  const value = headers[lowercaseName]
  if (value === undefined) return undefined
  if (Array.isArray(value)) return undefined
  return value
}

/**
 * Slice the signaturePrefix off the signature header, if any, and
 * return the bare encoded value. Compound headers like Stripe's
 * `t=...,v1=...` need scheme-aware parsing in W1.2; for v1.1 with
 * only `hmac-sha256-body` the prefix is a flat string match.
 */
function stripPrefix(value: string, prefix: string | undefined): string {
  if (!prefix) return value
  if (value.startsWith(prefix)) return value.slice(prefix.length)
  return value
}

export function verify(
  entry: WebhookConfigEntry,
  headers: IncomingHttpHeaders,
  body: Buffer,
  now: () => number = Date.now
): VerifyOutcome {
  const v = entry.verification
  switch (v.scheme) {
    case 'hmac-sha256-body':
      return verifyHmacSha256Body(v, headers, body)
    case 'static-bearer':
      return verifyStaticBearer(v, headers)
    case 'hmac-sha256-timestamp-body':
      return verifyHmacSha256TimestampBody(v, entry.replay, headers, body, now)
    case 'jwt-bearer-jwks':
      return verifyJwtBearerJwks(v, headers, now)
  }
}

/**
 * Default header / prefix for `static-bearer` when the recipe omits them.
 * Matches the canonical `Authorization: Bearer <token>` shape so existing
 * recipes that just set `secretRef` keep working. Telegram authors set
 * `tokenHeader: x-telegram-bot-api-secret-token` and `tokenPrefix: ''`.
 */
const STATIC_BEARER_DEFAULT_HEADER = 'authorization'
const STATIC_BEARER_DEFAULT_PREFIX = 'Bearer '

function verifyStaticBearer(
  v: Extract<WebhookConfigEntry['verification'], { scheme: 'static-bearer' }>,
  headers: IncomingHttpHeaders
): VerifyOutcome {
  // Header name normalization happens in config.ts. Empty-string prefix is
  // explicit "no prefix" — distinct from undefined which means "use default".
  const headerName = v.tokenHeader ?? STATIC_BEARER_DEFAULT_HEADER
  const prefix = v.tokenPrefix ?? STATIC_BEARER_DEFAULT_PREFIX

  const raw = singleHeader(headers, headerName)
  if (!raw) return { kind: 'invalid_signature' }
  if (prefix.length > 0 && !raw.startsWith(prefix)) {
    // Missing prefix is a verification failure, not a misconfig — we want
    // attackers to learn no more from "wrong prefix" than from "wrong token".
    return { kind: 'invalid_signature' }
  }
  const presented = prefix.length > 0 ? raw.slice(prefix.length) : raw
  if (presented.length === 0) return { kind: 'invalid_signature' }

  let secret: Buffer
  try {
    secret = readSecretFromPath(v.secretPath)
  } catch (err) {
    return {
      kind: 'verifier_misconfigured',
      detail: err instanceof Error ? err.message : String(err),
    }
  }

  const presentedBuf = Buffer.from(presented, 'utf8')
  // timingSafeEqual requires equal-length buffers. Always pad-compare against
  // an equal-length view of secret to keep timing flat regardless of which
  // side is shorter.
  if (presentedBuf.length !== secret.length) {
    // Burn a comparison cycle against secret to keep the timing profile
    // similar to the equal-length path. Result is discarded.
    const padded = Buffer.alloc(secret.length)
    presentedBuf.copy(padded, 0, 0, Math.min(presentedBuf.length, secret.length))
    timingSafeEqual(padded, secret)
    return { kind: 'invalid_signature' }
  }
  return timingSafeEqual(presentedBuf, secret) ? { kind: 'ok' } : { kind: 'invalid_signature' }
}

function verifyHmacSha256Body(
  v: Extract<WebhookConfigEntry['verification'], { scheme: 'hmac-sha256-body' }>,
  headers: IncomingHttpHeaders,
  body: Buffer
): VerifyOutcome {
  const headerValue = singleHeader(headers, v.signatureHeader)
  if (!headerValue) return { kind: 'invalid_signature' }
  const decoded = decodeSignature(stripPrefix(headerValue, v.signaturePrefix), v.signatureEncoding)
  if (!decoded) return { kind: 'invalid_signature' }

  let secret: Buffer
  try {
    secret = readSecretFromPath(v.secretPath)
  } catch (err) {
    // Secret file missing / unreadable is a platform fault, not a request fault.
    return {
      kind: 'verifier_misconfigured',
      detail: err instanceof Error ? err.message : String(err),
    }
  }

  const expected = createHmac('sha256', secret).update(body).digest()
  if (expected.length !== decoded.length) return { kind: 'invalid_signature' }
  // timingSafeEqual requires equal-length buffers; we already short-circuit above.
  return timingSafeEqual(expected, decoded) ? { kind: 'ok' } : { kind: 'invalid_signature' }
}

/**
 * Stripe-style "v1=<hex>" / Slack-style "v0=<hex>" HMAC over `${ts}.${body}`.
 * The timestamp is signed alongside the body so replays of an old, otherwise
 * valid request fall outside the tolerance window and get rejected with
 * `timestamp_skew` (mapped to 408 by the server). We require config-layer
 * presence of `entry.replay` — the config validator already enforces this for
 * the timestamp scheme, but we re-check defensively because the type cannot.
 */
function verifyHmacSha256TimestampBody(
  v: Extract<WebhookConfigEntry['verification'], { scheme: 'hmac-sha256-timestamp-body' }>,
  replay: WebhookConfigEntry['replay'],
  headers: IncomingHttpHeaders,
  body: Buffer,
  now: () => number
): VerifyOutcome {
  if (!replay) {
    return {
      kind: 'verifier_misconfigured',
      detail: 'hmac-sha256-timestamp-body requires replay config',
    }
  }

  const tsRaw = singleHeader(headers, replay.timestampHeader)
  if (!tsRaw) return { kind: 'invalid_signature' }
  // Whole-number seconds only — providers (Stripe, Slack) send Unix seconds as
  // an integer string. Reject decimals, signs, whitespace, leading zeros are
  // tolerated by Number() but the regex rejects everything non-digit so the
  // signing-input string equals the header value byte-for-byte.
  if (!/^[0-9]+$/.test(tsRaw)) return { kind: 'invalid_signature' }
  const ts = Number(tsRaw)
  if (!Number.isFinite(ts)) return { kind: 'invalid_signature' }
  const nowSec = Math.floor(now() / 1000)
  if (Math.abs(nowSec - ts) > replay.toleranceSec) {
    return { kind: 'timestamp_skew' }
  }

  const headerValue = singleHeader(headers, v.signatureHeader)
  if (!headerValue) return { kind: 'invalid_signature' }
  const decoded = decodeSignature(stripPrefix(headerValue, v.signaturePrefix), v.signatureEncoding)
  if (!decoded) return { kind: 'invalid_signature' }

  let secret: Buffer
  try {
    secret = readSecretFromPath(v.secretPath)
  } catch (err) {
    return {
      kind: 'verifier_misconfigured',
      detail: err instanceof Error ? err.message : String(err),
    }
  }

  // Stripe/Slack canonical signing input: `${tsRaw}.${body}`. The dot is a
  // literal separator — both providers document it. We MUST use the timestamp
  // string as it appeared on the wire (not a parsed/normalized form), because
  // the provider signed those exact bytes.
  const signingInput = Buffer.concat([
    Buffer.from(tsRaw, 'utf8'),
    Buffer.from('.', 'utf8'),
    body,
  ])
  const expected = createHmac('sha256', secret).update(signingInput).digest()
  if (expected.length !== decoded.length) return { kind: 'invalid_signature' }
  return timingSafeEqual(expected, decoded) ? { kind: 'ok' } : { kind: 'invalid_signature' }
}

// ─── jwt-bearer-jwks ──────────────────────────────────────────────────────

/**
 * Algorithms we accept. HS* is intentionally excluded — using HMAC with a
 * public-key set is the classic JWT confusion attack, and JWKS endpoints
 * publish public keys. `none` is excluded for the same reason — never honor
 * an unsigned JWT regardless of header.
 */
const JWT_ALG_TO_NODE: Record<string, { algorithm: string; padding?: number; dsaEncoding?: 'der' | 'ieee-p1363' }> = {
  RS256: { algorithm: 'RSA-SHA256' },
  RS384: { algorithm: 'RSA-SHA384' },
  RS512: { algorithm: 'RSA-SHA512' },
  PS256: { algorithm: 'RSA-SHA256', padding: cryptoConstants.RSA_PKCS1_PSS_PADDING },
  PS384: { algorithm: 'RSA-SHA384', padding: cryptoConstants.RSA_PKCS1_PSS_PADDING },
  PS512: { algorithm: 'RSA-SHA512', padding: cryptoConstants.RSA_PKCS1_PSS_PADDING },
  ES256: { algorithm: 'sha256', dsaEncoding: 'ieee-p1363' },
  ES384: { algorithm: 'sha384', dsaEncoding: 'ieee-p1363' },
  ES512: { algorithm: 'sha512', dsaEncoding: 'ieee-p1363' },
}

/** Clock-skew tolerance for JWT `exp`/`nbf` checks. 60s matches industry default. */
const JWT_CLOCK_SKEW_SEC = 60

interface JwtHeader {
  alg: string
  kid?: string
  typ?: string
}

interface JwtPayload {
  iss?: string
  aud?: string | string[]
  sub?: string
  exp?: number
  nbf?: number
  iat?: number
  [k: string]: unknown
}

interface Jwk {
  kty: string
  kid?: string
  use?: string
  alg?: string
  [k: string]: unknown
}

interface Jwks {
  keys: Jwk[]
}

function decodeBase64UrlJson<T>(segment: string): T | null {
  try {
    const buf = Buffer.from(segment, 'base64url')
    if (buf.length === 0) return null
    const text = buf.toString('utf8')
    const parsed = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null) return null
    return parsed as T
  } catch {
    return null
  }
}

function loadJwks(path: string): Jwks | { error: string } {
  let raw: Buffer
  try {
    raw = readFileSync(path)
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
  try {
    const parsed = JSON.parse(raw.toString('utf8'))
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !Array.isArray((parsed as { keys: unknown }).keys)
    ) {
      return { error: 'jwks file missing "keys" array' }
    }
    const keys = (parsed as { keys: unknown[] }).keys.filter(
      (k): k is Jwk => typeof k === 'object' && k !== null && typeof (k as Jwk).kty === 'string'
    )
    return { keys }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

function pickKey(jwks: Jwks, kid: string | undefined): Jwk | null {
  if (kid !== undefined) {
    return jwks.keys.find(k => k.kid === kid) ?? null
  }
  // No kid in the header — only acceptable if the JWKS has exactly one key.
  // Otherwise we cannot identify which to use, and silently picking the first
  // is a footgun (rotation invalidates the wrong-key set).
  return jwks.keys.length === 1 ? jwks.keys[0] : null
}

function importJwkKey(jwk: Jwk): KeyObject | null {
  try {
    return createPublicKey({ key: jwk as Record<string, unknown>, format: 'jwk' })
  } catch {
    return null
  }
}

function verifyJwtBearerJwks(
  v: Extract<WebhookConfigEntry['verification'], { scheme: 'jwt-bearer-jwks' }>,
  headers: IncomingHttpHeaders,
  now: () => number
): VerifyOutcome {
  const auth = singleHeader(headers, 'authorization')
  if (!auth || !auth.startsWith('Bearer ')) return { kind: 'invalid_signature' }
  const token = auth.slice('Bearer '.length)
  if (token.length === 0) return { kind: 'invalid_signature' }

  const parts = token.split('.')
  if (parts.length !== 3) return { kind: 'invalid_signature' }
  const [headerSeg, payloadSeg, sigSeg] = parts
  if (!headerSeg || !payloadSeg || !sigSeg) return { kind: 'invalid_signature' }

  const header = decodeBase64UrlJson<JwtHeader>(headerSeg)
  if (!header || typeof header.alg !== 'string') return { kind: 'invalid_signature' }
  const algSpec = JWT_ALG_TO_NODE[header.alg]
  if (!algSpec) {
    // Unsupported alg (incl. `none`, HS256/384/512) — reject as an invalid
    // signature so attackers learn nothing about which algs we accept.
    return { kind: 'invalid_signature' }
  }
  const kid = typeof header.kid === 'string' ? header.kid : undefined

  const payload = decodeBase64UrlJson<JwtPayload>(payloadSeg)
  if (!payload) return { kind: 'invalid_signature' }

  let signature: Buffer
  try {
    signature = Buffer.from(sigSeg, 'base64url')
    if (signature.length === 0) return { kind: 'invalid_signature' }
  } catch {
    return { kind: 'invalid_signature' }
  }

  // Load JWKS from disk on every request — the file is small and the
  // reconciler bakes a fresh copy each rotation. If perf is ever an issue,
  // wrap this in an mtime-keyed cache.
  const jwks = loadJwks(v.jwksPath)
  if ('error' in jwks) {
    return { kind: 'verifier_misconfigured', detail: `jwks load: ${jwks.error}` }
  }
  const jwk = pickKey(jwks, kid)
  if (!jwk) return { kind: 'invalid_signature' }

  // If the JWK pins an alg, reject mismatches before importing — a key
  // tagged RS256 must not be used to verify an ES256 token, even if the
  // crypto operation would succeed mechanically.
  if (typeof jwk.alg === 'string' && jwk.alg !== header.alg) {
    return { kind: 'invalid_signature' }
  }

  const publicKey = importJwkKey(jwk)
  if (!publicKey) {
    return { kind: 'verifier_misconfigured', detail: 'jwks entry rejected by crypto.createPublicKey' }
  }

  const signingInput = Buffer.from(`${headerSeg}.${payloadSeg}`, 'utf8')
  const keyForVerify: Parameters<typeof cryptoVerify>[2] =
    algSpec.padding !== undefined || algSpec.dsaEncoding !== undefined
      ? {
          key: publicKey,
          ...(algSpec.padding !== undefined ? { padding: algSpec.padding } : {}),
          ...(algSpec.dsaEncoding !== undefined ? { dsaEncoding: algSpec.dsaEncoding } : {}),
        }
      : publicKey
  let ok = false
  try {
    ok = cryptoVerify(algSpec.algorithm, signingInput, keyForVerify, signature)
  } catch {
    return { kind: 'invalid_signature' }
  }
  if (!ok) return { kind: 'invalid_signature' }

  // Claim checks run AFTER signature verification — never trust claim values
  // from an unverified token.
  const nowSec = Math.floor(now() / 1000)
  if (typeof payload.exp !== 'number') return { kind: 'invalid_signature' }
  if (nowSec >= payload.exp + JWT_CLOCK_SKEW_SEC) return { kind: 'invalid_signature' }
  if (typeof payload.nbf === 'number' && nowSec + JWT_CLOCK_SKEW_SEC < payload.nbf) {
    return { kind: 'invalid_signature' }
  }
  if (payload.iss !== v.issuer) return { kind: 'invalid_signature' }
  // aud may be a string or array per RFC 7519. The configured audience must
  // appear in either form.
  if (typeof payload.aud === 'string') {
    if (payload.aud !== v.audience) return { kind: 'invalid_signature' }
  } else if (Array.isArray(payload.aud)) {
    if (!payload.aud.includes(v.audience)) return { kind: 'invalid_signature' }
  } else {
    return { kind: 'invalid_signature' }
  }

  return { kind: 'ok' }
}
