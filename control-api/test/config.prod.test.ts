import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { generateKeyPairSync, randomBytes } from 'node:crypto'

function generateNonDevPem(): string {
  // 3072-bit RSA. 2048-bit keys produce a PKCS8 header that collides with the
  // dev-key fingerprint check in src/config.ts (`MIIEvAIBADANBgkqhkiG9w0BAQEFAASC`
  // / `MIIEvgIBADANBgkqhkiG9w0BAQEFAASC`). 3072 yields a `MIIG/Q…` prefix that
  // doesn't match either fingerprint and is still RS256-compatible.
  return generateKeyPairSync('rsa', {
    modulusLength: 3072,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  }).privateKey
}

/**
 * Populate every CONTROL_API env var that the prod path requires so that
 * config evaluation reaches the voucher-key guard rather than throwing earlier
 * on a missing required env. Mirrors `requiredOrDevDefault` callsites in
 * `src/config.ts`.
 */
function applyProdEnv(env: Record<string, string | undefined>): void {
  env.NODE_ENV = 'production'
  // Non-dev RPC/session/admin JWT keys — the existing prod guard rejects the
  // hardcoded dev fingerprints.
  env.CONTROL_API_RPC_JWT_PRIVATE_KEY = generateNonDevPem()
  env.CONTROL_API_SESSION_JWT_PRIVATE_KEY = generateNonDevPem()
  env.CONTROL_API_ADMIN_JWT_PRIVATE_KEY = generateNonDevPem()
  // Remaining `requiredOrDevDefault` callsites in src/config.ts. Defaults are
  // dev-only — production must set these explicitly.
  env.INTERNAL_CONTROL_JWT_WRC_HMAC_SECRET = randomBytes(32).toString('hex')
  env.INTERNAL_CONTROL_JWT_HCC_HMAC_SECRET = randomBytes(32).toString('hex')
  env.CONTROL_API_MEMBER_REGISTRATION_SERVICE_BASE_URL = 'https://example.com/api/v1'
  env.CONTROL_API_MEMBER_REGISTRATION_HMAC_SECRET = randomBytes(32).toString('hex')
  env.CONTROL_API_MEMBER_REGISTRATION_HMAC_KID = 'clerum'
  env.CONTROL_API_MEMBER_REGISTRATION_TENANT_ID = 'clerum'
  env.CONTROL_API_JWT_ISSUER = 'control-api'
  env.CONTROL_API_JWT_AUDIENCE = 'profile-ui'
  env.CONTROL_API_RPC_JWT_ISSUER = 'control-api'
  env.CONTROL_API_RPC_JWT_AUDIENCE = 'rpc-proxy'
  env.CONTROL_API_GOOGLE_CLIENT_ID = 'prod-google-client-id'
  env.CONTROL_API_ADMIN_JWT_ISSUER = 'control-api'
  env.CONTROL_API_ADMIN_JWT_AUDIENCE = 'control-ui'
  env.CONTROL_API_ADMIN_BOOTSTRAP_USERNAME = 'admin'
  // bcrypt hash of 'prod-bootstrap-password' (any valid bcrypt-shaped string is fine here).
  env.CONTROL_API_ADMIN_BOOTSTRAP_PASSWORD_HASH =
    '$2b$12$4dm17x2DESCxETGi0MpNruC0KpCev5lbKwqgmUkVLxKsNUxoXXXXXX'
  env.CONTROL_API_OAUTH_STATE_HMAC_SECRET = randomBytes(32).toString('hex')
  env.CONTROL_API_OAUTH_ENCRYPTION_KEY = randomBytes(32).toString('hex')
  env.CONTROL_API_INTERNAL_SERVICE_TOKENS =
    'external-rest-api=prod-external-rest-api-token,rpc-proxy=prod-rpc-proxy-token,webhook-proxy=prod-webhook-proxy-token'
}

describe('config: production voucher key guard', () => {
  const origEnv = { ...process.env }

  beforeEach(() => {
    vi.resetModules()
    process.env = { ...origEnv }
    applyProdEnv(process.env)
  })

  afterEach(() => {
    process.env = { ...origEnv }
    vi.restoreAllMocks()
    vi.resetModules()
  })

  it('warns when registryVoucherPrivateKey is unset and fallback is in effect', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    delete process.env.CONTROL_API_REGISTRY_VOUCHER_PRIVATE_KEY

    await import('../src/config.js')

    expect(warnSpy).toHaveBeenCalled()
    const calls = warnSpy.mock.calls.map(c => String(c[0]))
    expect(calls.some(m => /registry.*voucher/i.test(m) && /fallback|adminJwt/i.test(m))).toBe(true)
  })

  it('does not warn about voucher fallback when registryVoucherPrivateKey is set', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    process.env.CONTROL_API_REGISTRY_VOUCHER_PRIVATE_KEY = generateNonDevPem()

    await import('../src/config.js')

    const calls = warnSpy.mock.calls.map(c => String(c[0]))
    expect(calls.some(m => /registry.*voucher/i.test(m) && /fallback/i.test(m))).toBe(false)
  })

  it('rejects default dev internal service tokens in production', async () => {
    process.env.CONTROL_API_INTERNAL_SERVICE_TOKENS =
      'external-rest-api=dev-external-rest-api-token'

    await expect(() => import('../src/config.js')).rejects.toThrow(
      /default dev internal service token/
    )
  })
})
