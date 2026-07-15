import { createPublicKey, createVerify, type JsonWebKey, type KeyObject } from 'node:crypto'
import { fetchWithTimeout } from './httpTimeout.js'

const OPENID_CONFIG_URL = 'https://login.botframework.com/v1/.well-known/openidconfiguration'
const CACHE_TTL_MS = 60 * 60 * 1000

type OpenIdConfig = {
  issuer: string
  jwksUri: string
  expiresAt: number
}

type CachedKey = {
  key: KeyObject
  expiresAt: number
}

let openIdConfig: OpenIdConfig | null = null
const keyCache = new Map<string, CachedKey>()

function decodeBase64UrlJson(value: string): Record<string, unknown> | null {
  try {
    const decoded = Buffer.from(value, 'base64url').toString('utf8')
    const parsed = JSON.parse(decoded)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function stringClaim(payload: Record<string, unknown>, key: string): string {
  const value = payload[key]
  return typeof value === 'string' ? value.trim() : ''
}

function numberClaim(payload: Record<string, unknown>, key: string): number | null {
  const value = payload[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function normalizedServiceUrl(value: string): string {
  try {
    const url = new URL(value.trim())
    url.hash = ''
    url.search = ''
    return url.toString().replace(/\/+$/, '')
  } catch {
    return value.trim().replace(/\/+$/, '')
  }
}

async function getOpenIdConfig(timeoutMs: number): Promise<OpenIdConfig> {
  const now = Date.now()
  if (openIdConfig && openIdConfig.expiresAt > now) return openIdConfig

  const response = await fetchWithTimeout(OPENID_CONFIG_URL, { method: 'GET' }, timeoutMs)
  const body = (await response.json()) as { issuer?: unknown; jwks_uri?: unknown }
  const issuer = typeof body.issuer === 'string' ? body.issuer.trim() : ''
  const jwksUri = typeof body.jwks_uri === 'string' ? body.jwks_uri.trim() : ''
  if (!response.ok || !issuer || !jwksUri) {
    throw new Error('teams_openid_metadata_unavailable')
  }
  openIdConfig = { issuer, jwksUri, expiresAt: now + CACHE_TTL_MS }
  return openIdConfig
}

async function getSigningKey(
  jwksUri: string,
  kid: string,
  timeoutMs: number
): Promise<KeyObject | null> {
  const cacheKey = `${jwksUri}:${kid}`
  const cached = keyCache.get(cacheKey)
  const now = Date.now()
  if (cached && cached.expiresAt > now) return cached.key

  const response = await fetchWithTimeout(jwksUri, { method: 'GET' }, timeoutMs)
  const body = (await response.json()) as { keys?: unknown }
  const keys = Array.isArray(body.keys) ? body.keys : []
  const jwk = keys.find(item => {
    return (
      item &&
      typeof item === 'object' &&
      !Array.isArray(item) &&
      (item as Record<string, unknown>).kid === kid
    )
  }) as JsonWebKey | undefined
  if (!response.ok || !jwk) return null

  const key = createPublicKey({ key: jwk, format: 'jwk' })
  keyCache.set(cacheKey, { key, expiresAt: now + CACHE_TTL_MS })
  return key
}

export async function verifyTeamsAuthorization(params: {
  authorizationHeader: string
  appId: string
  serviceUrl?: string | null
  timeoutMs: number
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const token = params.authorizationHeader.trim().replace(/^Bearer\s+/i, '')
  const [encodedHeader, encodedPayload, encodedSignature] = token.split('.')
  if (!encodedHeader || !encodedPayload || !encodedSignature) {
    return { ok: false, error: 'invalid_provider_signature' }
  }

  const header = decodeBase64UrlJson(encodedHeader)
  const payload = decodeBase64UrlJson(encodedPayload)
  if (!header || !payload) return { ok: false, error: 'invalid_provider_signature' }
  if (stringClaim(header, 'alg') !== 'RS256') {
    return { ok: false, error: 'unsupported_provider_signature_algorithm' }
  }
  const kid = stringClaim(header, 'kid')
  if (!kid) return { ok: false, error: 'invalid_provider_signature' }

  let config: OpenIdConfig
  let key: KeyObject | null
  try {
    config = await getOpenIdConfig(params.timeoutMs)
    key = await getSigningKey(config.jwksUri, kid, params.timeoutMs)
  } catch {
    return { ok: false, error: 'teams_auth_metadata_unavailable' }
  }
  if (!key) return { ok: false, error: 'invalid_provider_signature' }

  const signature = Buffer.from(encodedSignature, 'base64url')
  const verifier = createVerify('RSA-SHA256')
  verifier.update(`${encodedHeader}.${encodedPayload}`)
  verifier.end()
  if (!verifier.verify(key, signature)) {
    return { ok: false, error: 'invalid_provider_signature' }
  }

  const nowSeconds = Math.floor(Date.now() / 1000)
  const exp = numberClaim(payload, 'exp')
  const nbf = numberClaim(payload, 'nbf')
  if (!exp || exp <= nowSeconds || (nbf && nbf > nowSeconds + 60)) {
    return { ok: false, error: 'expired_provider_signature' }
  }
  if (stringClaim(payload, 'aud') !== params.appId) {
    return { ok: false, error: 'teams_app_id_mismatch' }
  }
  if (stringClaim(payload, 'iss') !== config.issuer) {
    return { ok: false, error: 'invalid_provider_issuer' }
  }
  if (params.serviceUrl) {
    const serviceUrlClaim = stringClaim(payload, 'serviceurl')
    if (!serviceUrlClaim) return { ok: false, error: 'teams_service_url_claim_missing' }
    if (normalizedServiceUrl(serviceUrlClaim) !== normalizedServiceUrl(params.serviceUrl)) {
      return { ok: false, error: 'teams_service_url_mismatch' }
    }
  }

  return { ok: true }
}
