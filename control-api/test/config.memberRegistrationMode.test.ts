import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { generateKeyPairSync, randomBytes } from 'node:crypto'

function generateNonDevPem(): string {
  // 3072-bit RSA — 2048 collides with the dev-key fingerprint check in src/config.ts.
  return generateKeyPairSync('rsa', {
    modulusLength: 3072,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  }).privateKey
}

/** Mirror of test/config.prod.test.ts applyProdEnv — every env the prod path requires. */
function applyProdEnv(env: Record<string, string | undefined>): void {
  env.NODE_ENV = 'production'
  env.CONTROL_API_RPC_JWT_PRIVATE_KEY = generateNonDevPem()
  env.CONTROL_API_SESSION_JWT_PRIVATE_KEY = generateNonDevPem()
  env.CONTROL_API_ADMIN_JWT_PRIVATE_KEY = generateNonDevPem()
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
  env.CONTROL_API_ADMIN_BOOTSTRAP_PASSWORD_HASH =
    '$2b$12$4dm17x2DESCxETGi0MpNruC0KpCev5lbKwqgmUkVLxKsNUxoXXXXXX'
  env.CONTROL_API_OAUTH_STATE_HMAC_SECRET = randomBytes(32).toString('hex')
  env.CONTROL_API_OAUTH_ENCRYPTION_KEY = randomBytes(32).toString('hex')
  env.CONTROL_API_INTERNAL_SERVICE_TOKENS =
    'external-rest-api=prod-external-rest-api-token,rpc-proxy=prod-rpc-proxy-token,webhook-proxy=prod-webhook-proxy-token'
}

const MEMBER_REG_VARS = [
  'CONTROL_API_MEMBER_REGISTRATION_MODE',
  'CONTROL_API_MEMBER_REGISTRATION_SERVICE_BASE_URL',
  'CONTROL_API_MEMBER_REGISTRATION_HMAC_SECRET',
  'CONTROL_API_MEMBER_REGISTRATION_HMAC_KID',
  'CONTROL_API_MEMBER_REGISTRATION_TENANT_ID',
  'CONTROL_API_MEMBER_REGISTRATION_EXTERNAL_HUB_BASE_URL',
] as const

describe('config: member-registration mode', () => {
  const origEnv = { ...process.env }

  beforeEach(() => {
    vi.resetModules()
    process.env = { ...origEnv }
    for (const name of MEMBER_REG_VARS) delete process.env[name]
    delete process.env.NODE_ENV
  })

  afterEach(() => {
    process.env = { ...origEnv }
    vi.restoreAllMocks()
    vi.resetModules()
  })

  it('defaults to remote', async () => {
    const { config } = await import('../src/config.js')
    expect(config.memberRegistrationMode).toBe('remote')
  })

  it('parses hosted and defaults the external hub base URL', async () => {
    process.env.CONTROL_API_MEMBER_REGISTRATION_MODE = 'hosted'
    const { config } = await import('../src/config.js')
    expect(config.memberRegistrationMode).toBe('hosted')
    expect(config.memberRegistrationExternalHubBaseUrl).toBe(
      'https://registration.evenfire.ai/api/v1'
    )
  })

  it('honors an explicit external hub override (staging hub)', async () => {
    process.env.CONTROL_API_MEMBER_REGISTRATION_MODE = 'hosted'
    process.env.CONTROL_API_MEMBER_REGISTRATION_EXTERNAL_HUB_BASE_URL =
      'https://registration.staging.example.com/api/v1'
    const { config } = await import('../src/config.js')
    expect(config.memberRegistrationExternalHubBaseUrl).toBe(
      'https://registration.staging.example.com/api/v1'
    )
  })

  it('hard-errors on unknown mode values (e.g. the abandoned "offline")', async () => {
    process.env.CONTROL_API_MEMBER_REGISTRATION_MODE = 'offline'
    await expect(() => import('../src/config.js')).rejects.toThrow(
      /CONTROL_API_MEMBER_REGISTRATION_MODE/
    )
  })

  it('fail-fasts hosted + injected HMAC_KID', async () => {
    process.env.CONTROL_API_MEMBER_REGISTRATION_MODE = 'hosted'
    process.env.CONTROL_API_MEMBER_REGISTRATION_HMAC_KID = 'clerum-dev-e6f79032'
    await expect(() => import('../src/config.js')).rejects.toThrow(
      /CONTROL_API_MEMBER_REGISTRATION_HMAC_KID/
    )
  })

  it('fail-fasts hosted + injected TENANT_ID', async () => {
    process.env.CONTROL_API_MEMBER_REGISTRATION_MODE = 'hosted'
    process.env.CONTROL_API_MEMBER_REGISTRATION_TENANT_ID = 'clerum-dev'
    await expect(() => import('../src/config.js')).rejects.toThrow(
      /CONTROL_API_MEMBER_REGISTRATION_TENANT_ID/
    )
  })

  it('treats empty/whitespace identity vars as absent (deploy blanking escape hatch)', async () => {
    process.env.CONTROL_API_MEMBER_REGISTRATION_MODE = 'hosted'
    process.env.CONTROL_API_MEMBER_REGISTRATION_HMAC_KID = '   '
    process.env.CONTROL_API_MEMBER_REGISTRATION_TENANT_ID = ''
    await expect(import('../src/config.js')).resolves.toBeDefined()
  })

  it('ignores a lone deploy-injected HMAC_SECRET in hosted mode, with a warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    process.env.CONTROL_API_MEMBER_REGISTRATION_MODE = 'hosted'
    process.env.CONTROL_API_MEMBER_REGISTRATION_HMAC_SECRET = 'legacy-injected-secret'
    await expect(import('../src/config.js')).resolves.toBeDefined()
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('CONTROL_API_MEMBER_REGISTRATION_HMAC_SECRET')
    )
  })

  it('hosted relaxes the prod requirement for base URL + secret (non-vacuous direction)', async () => {
    applyProdEnv(process.env)
    // A real self-hosted operator flipping hosted: the four legacy vars are gone
    // except the deploy-injected secret; base URL removed to prove the relaxation.
    delete process.env.CONTROL_API_MEMBER_REGISTRATION_SERVICE_BASE_URL
    delete process.env.CONTROL_API_MEMBER_REGISTRATION_HMAC_KID
    delete process.env.CONTROL_API_MEMBER_REGISTRATION_TENANT_ID
    delete process.env.CONTROL_API_MEMBER_REGISTRATION_HMAC_SECRET
    process.env.CONTROL_API_MEMBER_REGISTRATION_MODE = 'hosted'
    const { config } = await import('../src/config.js')
    expect(config.memberRegistrationMode).toBe('hosted')
  })

  // All four mode × var combinations (spec §8.8): a relaxation gated on env-var
  // PRESENCE rather than the parsed mode passes a 2-combo suite while booting a
  // prod remote deploy with no secret.
  it('NEGATIVE: prod remote (mode unset) still REQUIRES the HMAC secret', async () => {
    applyProdEnv(process.env)
    delete process.env.CONTROL_API_MEMBER_REGISTRATION_HMAC_SECRET
    await expect(() => import('../src/config.js')).rejects.toThrow(
      /CONTROL_API_MEMBER_REGISTRATION_HMAC_SECRET/
    )
  })

  it('NEGATIVE: prod remote (explicit) still REQUIRES the HMAC secret', async () => {
    applyProdEnv(process.env)
    process.env.CONTROL_API_MEMBER_REGISTRATION_MODE = 'remote'
    delete process.env.CONTROL_API_MEMBER_REGISTRATION_HMAC_SECRET
    await expect(() => import('../src/config.js')).rejects.toThrow(
      /CONTROL_API_MEMBER_REGISTRATION_HMAC_SECRET/
    )
  })

  it('NEGATIVE: prod remote (mode unset) still REQUIRES the service base URL', async () => {
    applyProdEnv(process.env)
    delete process.env.CONTROL_API_MEMBER_REGISTRATION_SERVICE_BASE_URL
    await expect(() => import('../src/config.js')).rejects.toThrow(
      /CONTROL_API_MEMBER_REGISTRATION_SERVICE_BASE_URL/
    )
  })

  it('NEGATIVE: prod remote (explicit) still REQUIRES the service base URL', async () => {
    applyProdEnv(process.env)
    process.env.CONTROL_API_MEMBER_REGISTRATION_MODE = 'remote'
    delete process.env.CONTROL_API_MEMBER_REGISTRATION_SERVICE_BASE_URL
    await expect(() => import('../src/config.js')).rejects.toThrow(
      /CONTROL_API_MEMBER_REGISTRATION_SERVICE_BASE_URL/
    )
  })
})
