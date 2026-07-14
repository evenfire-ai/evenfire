import { createHmac, createSign, generateKeyPairSync, type KeyObject } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { WebhookConfigEntry } from '../src/types'
import { verify } from '../src/verifier'

let dir: string
let secretPath: string
const SECRET = 'super-secret-signing-key'

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wh-gw-test-'))
  secretPath = join(dir, 'signing-secret')
  writeFileSync(secretPath, SECRET, 'utf8')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function entry(): WebhookConfigEntry {
  return {
    id: 'fireflies',
    methods: ['POST'],
    maxBodyBytes: 1_048_576,
    verification: {
      scheme: 'hmac-sha256-body',
      signatureHeader: 'x-hub-signature-256',
      signaturePrefix: 'sha256=',
      signatureEncoding: 'hex',
      secretPath,
    },
    upstream: { host: 'h', port: 8080, path: '/' },
  }
}

const sign = (body: Buffer, encoding: 'hex' | 'base64' = 'hex'): string =>
  createHmac('sha256', SECRET).update(body).digest(encoding)

describe('hmac-sha256-body verifier (W1.1)', () => {
  it('accepts a body with a matching signature', () => {
    const body = Buffer.from('{"event":"meeting.created"}')
    const result = verify(entry(), { 'x-hub-signature-256': `sha256=${sign(body)}` }, body)
    expect(result).toEqual({ kind: 'ok' })
  })

  it('rejects a flipped bit in the body', () => {
    const body = Buffer.from('{"event":"meeting.created"}')
    const sig = sign(body)
    const tampered = Buffer.from('{"event":"meeting.deleted"}')
    const result = verify(entry(), { 'x-hub-signature-256': `sha256=${sig}` }, tampered)
    expect(result).toEqual({ kind: 'invalid_signature' })
  })

  it('rejects when the signature header is missing', () => {
    const body = Buffer.from('payload')
    const result = verify(entry(), {}, body)
    expect(result).toEqual({ kind: 'invalid_signature' })
  })

  it('rejects an array-valued signature header (defence against duplicates)', () => {
    const body = Buffer.from('payload')
    const goodSig = `sha256=${sign(body)}`
    const result = verify(
      entry(),
      { 'x-hub-signature-256': [goodSig, 'sha256=deadbeef'] as unknown as string },
      body
    )
    expect(result).toEqual({ kind: 'invalid_signature' })
  })

  it('rejects an odd-length hex signature value', () => {
    const body = Buffer.from('payload')
    const result = verify(entry(), { 'x-hub-signature-256': 'sha256=abc' }, body)
    expect(result).toEqual({ kind: 'invalid_signature' })
  })

  it('rejects a non-hex signature when encoding is hex', () => {
    const body = Buffer.from('payload')
    const result = verify(entry(), { 'x-hub-signature-256': 'sha256=zzzz' }, body)
    expect(result).toEqual({ kind: 'invalid_signature' })
  })

  it('handles base64-encoded signatures', () => {
    const body = Buffer.from('payload')
    const e: WebhookConfigEntry = {
      ...entry(),
      verification: {
        ...entry().verification,
        signatureEncoding: 'base64',
        signaturePrefix: undefined,
      } as WebhookConfigEntry['verification'],
    }
    const sig = sign(body, 'base64')
    const result = verify(e, { 'x-hub-signature-256': sig }, body)
    expect(result).toEqual({ kind: 'ok' })
  })

  it('returns verifier_misconfigured when the secret path is unreadable', () => {
    const e: WebhookConfigEntry = {
      ...entry(),
      verification: {
        ...entry().verification,
        secretPath: '/nonexistent/path',
      } as WebhookConfigEntry['verification'],
    }
    const body = Buffer.from('payload')
    const result = verify(e, { 'x-hub-signature-256': `sha256=${'a'.repeat(64)}` }, body)
    expect(result.kind).toBe('verifier_misconfigured')
  })

  it('strips a trailing newline from the secret file (kubectl artefact)', () => {
    writeFileSync(secretPath, SECRET + '\n', 'utf8')
    const body = Buffer.from('payload')
    const sig = `sha256=${sign(body)}` // signed without the trailing \n
    const result = verify(entry(), { 'x-hub-signature-256': sig }, body)
    expect(result).toEqual({ kind: 'ok' })
  })
})

describe('hmac-sha256-timestamp-body verifier', () => {
  const NOW_SEC = 1_700_000_000
  const now = () => NOW_SEC * 1000

  function tsEntry(extras: Partial<{ toleranceSec: number; prefix: string }> = {}): WebhookConfigEntry {
    return {
      id: 'stripe',
      methods: ['POST'],
      maxBodyBytes: 1_048_576,
      verification: {
        scheme: 'hmac-sha256-timestamp-body',
        signatureHeader: 'x-sig',
        signaturePrefix: extras.prefix,
        signatureEncoding: 'hex',
        secretPath,
      },
      replay: { timestampHeader: 'x-ts', toleranceSec: extras.toleranceSec ?? 300 },
      upstream: { host: 'h', port: 8080, path: '/' },
    }
  }

  const signTs = (ts: string, body: Buffer): string =>
    createHmac('sha256', SECRET)
      .update(Buffer.concat([Buffer.from(ts, 'utf8'), Buffer.from('.'), body]))
      .digest('hex')

  it('accepts a fresh timestamp with a matching signature', () => {
    const body = Buffer.from('{"x":1}')
    const ts = String(NOW_SEC)
    const result = verify(
      tsEntry(),
      { 'x-ts': ts, 'x-sig': signTs(ts, body) },
      body,
      now
    )
    expect(result).toEqual({ kind: 'ok' })
  })

  it('honours a signaturePrefix', () => {
    const body = Buffer.from('{"x":1}')
    const ts = String(NOW_SEC)
    const result = verify(
      tsEntry({ prefix: 'v1=' }),
      { 'x-ts': ts, 'x-sig': `v1=${signTs(ts, body)}` },
      body,
      now
    )
    expect(result).toEqual({ kind: 'ok' })
  })

  it('rejects when the timestamp header is missing', () => {
    const body = Buffer.from('{"x":1}')
    const ts = String(NOW_SEC)
    const result = verify(tsEntry(), { 'x-sig': signTs(ts, body) }, body, now)
    expect(result).toEqual({ kind: 'invalid_signature' })
  })

  it('rejects a non-numeric timestamp', () => {
    const body = Buffer.from('{"x":1}')
    const result = verify(
      tsEntry(),
      { 'x-ts': 'not-a-number', 'x-sig': signTs(String(NOW_SEC), body) },
      body,
      now
    )
    expect(result).toEqual({ kind: 'invalid_signature' })
  })

  it('rejects a fractional timestamp', () => {
    const body = Buffer.from('{"x":1}')
    const result = verify(
      tsEntry(),
      { 'x-ts': `${NOW_SEC}.5`, 'x-sig': signTs(`${NOW_SEC}.5`, body) },
      body,
      now
    )
    expect(result).toEqual({ kind: 'invalid_signature' })
  })

  it('rejects a stale timestamp outside tolerance with timestamp_skew', () => {
    const body = Buffer.from('{"x":1}')
    const stale = String(NOW_SEC - 1000) // tolerance default 300s
    // Sign with the stale ts so the signature itself matches — proves we're
    // rejecting on skew, not on signature mismatch.
    const result = verify(
      tsEntry(),
      { 'x-ts': stale, 'x-sig': signTs(stale, body) },
      body,
      now
    )
    expect(result).toEqual({ kind: 'timestamp_skew' })
  })

  it('rejects a future timestamp outside tolerance with timestamp_skew', () => {
    const body = Buffer.from('{"x":1}')
    const future = String(NOW_SEC + 1000)
    const result = verify(
      tsEntry(),
      { 'x-ts': future, 'x-sig': signTs(future, body) },
      body,
      now
    )
    expect(result).toEqual({ kind: 'timestamp_skew' })
  })

  it('accepts a timestamp at the edge of the tolerance window', () => {
    const body = Buffer.from('{"x":1}')
    const edge = String(NOW_SEC - 300)
    const result = verify(
      tsEntry(),
      { 'x-ts': edge, 'x-sig': signTs(edge, body) },
      body,
      now
    )
    expect(result).toEqual({ kind: 'ok' })
  })

  it('rejects a signature computed over body alone (no timestamp prefix)', () => {
    const body = Buffer.from('{"x":1}')
    const ts = String(NOW_SEC)
    // Attacker reuses an hmac-sha256-body signature; must NOT pass.
    const bodyOnlySig = createHmac('sha256', SECRET).update(body).digest('hex')
    const result = verify(
      tsEntry(),
      { 'x-ts': ts, 'x-sig': bodyOnlySig },
      body,
      now
    )
    expect(result).toEqual({ kind: 'invalid_signature' })
  })

  it('rejects a tampered body', () => {
    const orig = Buffer.from('{"x":1}')
    const ts = String(NOW_SEC)
    const tampered = Buffer.from('{"x":2}')
    const result = verify(
      tsEntry(),
      { 'x-ts': ts, 'x-sig': signTs(ts, orig) },
      tampered,
      now
    )
    expect(result).toEqual({ kind: 'invalid_signature' })
  })

  it('returns verifier_misconfigured when the secret file is missing', () => {
    const e = tsEntry()
    ;(e.verification as { secretPath: string }).secretPath = '/nonexistent/secret'
    const body = Buffer.from('{"x":1}')
    const ts = String(NOW_SEC)
    const result = verify(e, { 'x-ts': ts, 'x-sig': 'a'.repeat(64) }, body, now)
    expect(result.kind).toBe('verifier_misconfigured')
  })
})

describe('jwt-bearer-jwks verifier', () => {
  const NOW_SEC = 1_700_000_000
  const now = () => NOW_SEC * 1000

  // RSA test key — generated once per test file load. JWKS is written to a
  // fresh tmp dir in beforeEach so file-missing tests are deterministic.
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const KID = 'test-key-1'
  let jwksPath: string

  beforeEach(() => {
    jwksPath = join(dir, 'jwks.json')
    writeFileSync(jwksPath, JSON.stringify({ keys: [jwkFromPublic(publicKey, KID, 'RS256')] }))
  })

  function jwkFromPublic(key: KeyObject, kid: string, alg?: string): Record<string, unknown> {
    const jwk = key.export({ format: 'jwk' }) as Record<string, unknown>
    jwk.kid = kid
    if (alg) jwk.alg = alg
    return jwk
  }

  function jwtEntry(extras: Partial<{ issuer: string; audience: string; jwksPath: string }> = {}): WebhookConfigEntry {
    return {
      id: 'github-app',
      methods: ['POST'],
      maxBodyBytes: 1_048_576,
      verification: {
        scheme: 'jwt-bearer-jwks',
        jwksUrl: 'https://example.test/jwks.json',
        issuer: extras.issuer ?? 'https://example.test',
        audience: extras.audience ?? 'webhook-gateway',
        jwksPath: extras.jwksPath ?? jwksPath,
      },
      upstream: { host: 'h', port: 8080, path: '/' },
    }
  }

  function signJwt(
    header: Record<string, unknown>,
    payload: Record<string, unknown>,
    key: KeyObject = privateKey,
    nodeAlg: string = 'RSA-SHA256'
  ): string {
    const headerB64 = Buffer.from(JSON.stringify(header), 'utf8').toString('base64url')
    const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
    const signingInput = `${headerB64}.${payloadB64}`
    const sig = createSign(nodeAlg).update(signingInput).end().sign(key).toString('base64url')
    return `${signingInput}.${sig}`
  }

  function basePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      iss: 'https://example.test',
      aud: 'webhook-gateway',
      sub: 'webhook-sender',
      exp: NOW_SEC + 60,
      iat: NOW_SEC,
      ...overrides,
    }
  }

  it('accepts a valid RS256 JWT', () => {
    const jwt = signJwt({ alg: 'RS256', kid: KID, typ: 'JWT' }, basePayload())
    const result = verify(jwtEntry(), { authorization: `Bearer ${jwt}` }, Buffer.alloc(0), now)
    expect(result).toEqual({ kind: 'ok' })
  })

  it('accepts aud as a string array containing the configured audience', () => {
    const jwt = signJwt(
      { alg: 'RS256', kid: KID },
      basePayload({ aud: ['other', 'webhook-gateway'] })
    )
    const result = verify(jwtEntry(), { authorization: `Bearer ${jwt}` }, Buffer.alloc(0), now)
    expect(result).toEqual({ kind: 'ok' })
  })

  it('rejects when the Authorization header is missing', () => {
    const result = verify(jwtEntry(), {}, Buffer.alloc(0), now)
    expect(result).toEqual({ kind: 'invalid_signature' })
  })

  it('rejects when the Authorization header lacks the Bearer prefix', () => {
    const jwt = signJwt({ alg: 'RS256', kid: KID }, basePayload())
    const result = verify(jwtEntry(), { authorization: jwt }, Buffer.alloc(0), now)
    expect(result).toEqual({ kind: 'invalid_signature' })
  })

  it('rejects a JWT with too few segments', () => {
    const result = verify(
      jwtEntry(),
      { authorization: 'Bearer aaa.bbb' },
      Buffer.alloc(0),
      now
    )
    expect(result).toEqual({ kind: 'invalid_signature' })
  })

  it('rejects alg=none', () => {
    const headerB64 = Buffer.from(JSON.stringify({ alg: 'none', kid: KID }), 'utf8').toString('base64url')
    const payloadB64 = Buffer.from(JSON.stringify(basePayload()), 'utf8').toString('base64url')
    const jwt = `${headerB64}.${payloadB64}.`
    const result = verify(jwtEntry(), { authorization: `Bearer ${jwt}` }, Buffer.alloc(0), now)
    expect(result).toEqual({ kind: 'invalid_signature' })
  })

  it('rejects HS256 (JWT confusion attack defence)', () => {
    // Attacker uses the JWKS RSA public key as an HMAC secret.
    const pubPem = publicKey.export({ format: 'pem', type: 'spki' }) as string
    const headerB64 = Buffer.from(JSON.stringify({ alg: 'HS256', kid: KID }), 'utf8').toString('base64url')
    const payloadB64 = Buffer.from(JSON.stringify(basePayload()), 'utf8').toString('base64url')
    const sig = createHmac('sha256', pubPem)
      .update(`${headerB64}.${payloadB64}`)
      .digest('base64url')
    const jwt = `${headerB64}.${payloadB64}.${sig}`
    const result = verify(jwtEntry(), { authorization: `Bearer ${jwt}` }, Buffer.alloc(0), now)
    expect(result).toEqual({ kind: 'invalid_signature' })
  })

  it('rejects when the kid does not match any JWKS key', () => {
    const jwt = signJwt({ alg: 'RS256', kid: 'unknown-kid' }, basePayload())
    const result = verify(jwtEntry(), { authorization: `Bearer ${jwt}` }, Buffer.alloc(0), now)
    expect(result).toEqual({ kind: 'invalid_signature' })
  })

  it('rejects when the header omits kid and the JWKS has multiple keys', () => {
    // Add a second key so pickKey cannot disambiguate.
    const second = generateKeyPairSync('rsa', { modulusLength: 2048 })
    writeFileSync(
      jwksPath,
      JSON.stringify({
        keys: [
          jwkFromPublic(publicKey, KID, 'RS256'),
          jwkFromPublic(second.publicKey, 'second', 'RS256'),
        ],
      })
    )
    const jwt = signJwt({ alg: 'RS256' }, basePayload()) // no kid
    const result = verify(jwtEntry(), { authorization: `Bearer ${jwt}` }, Buffer.alloc(0), now)
    expect(result).toEqual({ kind: 'invalid_signature' })
  })

  it('accepts when the header omits kid and the JWKS has exactly one key', () => {
    const jwt = signJwt({ alg: 'RS256' }, basePayload())
    const result = verify(jwtEntry(), { authorization: `Bearer ${jwt}` }, Buffer.alloc(0), now)
    expect(result).toEqual({ kind: 'ok' })
  })

  it('rejects a JWT signed by a different key', () => {
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const jwt = signJwt({ alg: 'RS256', kid: KID }, basePayload(), other.privateKey)
    const result = verify(jwtEntry(), { authorization: `Bearer ${jwt}` }, Buffer.alloc(0), now)
    expect(result).toEqual({ kind: 'invalid_signature' })
  })

  it('rejects when the JWK pins an alg that does not match the header alg', () => {
    writeFileSync(jwksPath, JSON.stringify({ keys: [jwkFromPublic(publicKey, KID, 'RS512')] }))
    const jwt = signJwt({ alg: 'RS256', kid: KID }, basePayload())
    const result = verify(jwtEntry(), { authorization: `Bearer ${jwt}` }, Buffer.alloc(0), now)
    expect(result).toEqual({ kind: 'invalid_signature' })
  })

  it('rejects an expired JWT (past tolerance)', () => {
    const jwt = signJwt(
      { alg: 'RS256', kid: KID },
      basePayload({ exp: NOW_SEC - 120 }) // 120s past, > 60s skew
    )
    const result = verify(jwtEntry(), { authorization: `Bearer ${jwt}` }, Buffer.alloc(0), now)
    expect(result).toEqual({ kind: 'invalid_signature' })
  })

  it('accepts a JWT that just expired within clock-skew tolerance', () => {
    const jwt = signJwt(
      { alg: 'RS256', kid: KID },
      basePayload({ exp: NOW_SEC - 30 }) // within 60s skew
    )
    const result = verify(jwtEntry(), { authorization: `Bearer ${jwt}` }, Buffer.alloc(0), now)
    expect(result).toEqual({ kind: 'ok' })
  })

  it('rejects a JWT without exp claim', () => {
    const payload = basePayload()
    delete payload.exp
    const jwt = signJwt({ alg: 'RS256', kid: KID }, payload)
    const result = verify(jwtEntry(), { authorization: `Bearer ${jwt}` }, Buffer.alloc(0), now)
    expect(result).toEqual({ kind: 'invalid_signature' })
  })

  it('rejects a JWT not yet valid (nbf in the future past tolerance)', () => {
    const jwt = signJwt(
      { alg: 'RS256', kid: KID },
      basePayload({ nbf: NOW_SEC + 120 })
    )
    const result = verify(jwtEntry(), { authorization: `Bearer ${jwt}` }, Buffer.alloc(0), now)
    expect(result).toEqual({ kind: 'invalid_signature' })
  })

  it('rejects a JWT with the wrong issuer', () => {
    const jwt = signJwt(
      { alg: 'RS256', kid: KID },
      basePayload({ iss: 'https://evil.test' })
    )
    const result = verify(jwtEntry(), { authorization: `Bearer ${jwt}` }, Buffer.alloc(0), now)
    expect(result).toEqual({ kind: 'invalid_signature' })
  })

  it('rejects a JWT with the wrong audience (string form)', () => {
    const jwt = signJwt(
      { alg: 'RS256', kid: KID },
      basePayload({ aud: 'someone-else' })
    )
    const result = verify(jwtEntry(), { authorization: `Bearer ${jwt}` }, Buffer.alloc(0), now)
    expect(result).toEqual({ kind: 'invalid_signature' })
  })

  it('rejects a JWT with the wrong audience (array form)', () => {
    const jwt = signJwt(
      { alg: 'RS256', kid: KID },
      basePayload({ aud: ['someone-else', 'another'] })
    )
    const result = verify(jwtEntry(), { authorization: `Bearer ${jwt}` }, Buffer.alloc(0), now)
    expect(result).toEqual({ kind: 'invalid_signature' })
  })

  it('rejects malformed base64url in the JWT header', () => {
    const result = verify(
      jwtEntry(),
      { authorization: 'Bearer !!!notbase64.eyJ9.abc' },
      Buffer.alloc(0),
      now
    )
    expect(result).toEqual({ kind: 'invalid_signature' })
  })

  it('returns verifier_misconfigured when the JWKS file is missing', () => {
    const jwt = signJwt({ alg: 'RS256', kid: KID }, basePayload())
    const e = jwtEntry({ jwksPath: '/nonexistent/jwks.json' })
    const result = verify(e, { authorization: `Bearer ${jwt}` }, Buffer.alloc(0), now)
    expect(result.kind).toBe('verifier_misconfigured')
  })

  it('returns verifier_misconfigured when the JWKS file is malformed JSON', () => {
    writeFileSync(jwksPath, 'not json {')
    const jwt = signJwt({ alg: 'RS256', kid: KID }, basePayload())
    const result = verify(jwtEntry(), { authorization: `Bearer ${jwt}` }, Buffer.alloc(0), now)
    expect(result.kind).toBe('verifier_misconfigured')
  })

  it('returns verifier_misconfigured when the JWKS has no keys array', () => {
    writeFileSync(jwksPath, JSON.stringify({ notKeys: [] }))
    const jwt = signJwt({ alg: 'RS256', kid: KID }, basePayload())
    const result = verify(jwtEntry(), { authorization: `Bearer ${jwt}` }, Buffer.alloc(0), now)
    expect(result.kind).toBe('verifier_misconfigured')
  })
})

describe('static-bearer verifier', () => {
  function bearerEntry(
    extras: Partial<{ tokenHeader: string; tokenPrefix: string }> = {}
  ): WebhookConfigEntry {
    return {
      id: 'telegram',
      methods: ['POST'],
      maxBodyBytes: 1_048_576,
      verification: {
        scheme: 'static-bearer',
        secretPath,
        ...extras,
      },
      upstream: { host: 'h', port: 8080, path: '/' },
    }
  }

  it('accepts the secret in Authorization: Bearer <token> by default', () => {
    const result = verify(
      bearerEntry(),
      { authorization: `Bearer ${SECRET}` },
      Buffer.alloc(0)
    )
    expect(result).toEqual({ kind: 'ok' })
  })

  it('rejects when the Authorization header is missing', () => {
    const result = verify(bearerEntry(), {}, Buffer.alloc(0))
    expect(result).toEqual({ kind: 'invalid_signature' })
  })

  it('rejects when the prefix does not match', () => {
    const result = verify(
      bearerEntry(),
      { authorization: `Token ${SECRET}` },
      Buffer.alloc(0)
    )
    expect(result).toEqual({ kind: 'invalid_signature' })
  })

  it('rejects when the token after the prefix is wrong', () => {
    const result = verify(
      bearerEntry(),
      { authorization: 'Bearer not-the-right-token-but-same-len' },
      Buffer.alloc(0)
    )
    expect(result).toEqual({ kind: 'invalid_signature' })
  })

  it('rejects when the token after the prefix is empty', () => {
    const result = verify(bearerEntry(), { authorization: 'Bearer ' }, Buffer.alloc(0))
    expect(result).toEqual({ kind: 'invalid_signature' })
  })

  it('reads from a custom tokenHeader (Telegram shape)', () => {
    const e = bearerEntry({
      tokenHeader: 'x-telegram-bot-api-secret-token',
      tokenPrefix: '',
    })
    const result = verify(
      e,
      { 'x-telegram-bot-api-secret-token': SECRET },
      Buffer.alloc(0)
    )
    expect(result).toEqual({ kind: 'ok' })
  })

  it('rejects when the custom header is missing', () => {
    const e = bearerEntry({
      tokenHeader: 'x-telegram-bot-api-secret-token',
      tokenPrefix: '',
    })
    const result = verify(e, {}, Buffer.alloc(0))
    expect(result).toEqual({ kind: 'invalid_signature' })
  })

  it('treats an empty tokenPrefix distinctly from undefined (no Bearer fallback)', () => {
    // tokenPrefix '' = the whole header value IS the token. A request that
    // sends `Bearer <secret>` against an empty-prefix config must FAIL
    // because "Bearer <secret>" is not equal to "<secret>".
    const e = bearerEntry({ tokenPrefix: '' })
    const result = verify(
      e,
      { authorization: `Bearer ${SECRET}` },
      Buffer.alloc(0)
    )
    expect(result).toEqual({ kind: 'invalid_signature' })
  })

  it('returns verifier_misconfigured when the secret file is missing', () => {
    const e = bearerEntry()
    ;(e.verification as { secretPath: string }).secretPath = '/var/run/does-not-exist'
    const result = verify(
      e,
      { authorization: `Bearer ${SECRET}` },
      Buffer.alloc(0)
    )
    expect(result.kind).toBe('verifier_misconfigured')
  })
})
