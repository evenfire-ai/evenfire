import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { generateKeyPairSync, randomBytes } from 'node:crypto'

function generateNonDevPem(): string {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 3072,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  })
  return privateKey as string
}

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

const origEnv = { ...process.env }
beforeEach(() => {
  vi.resetModules()
  process.env = { ...origEnv }
})
afterEach(() => {
  process.env = { ...origEnv }
  vi.restoreAllMocks()
  vi.resetModules()
})

describe('config — member registration offline mode', () => {
  it('defaults to remote and normalizes unknown values to remote', async () => {
    process.env.NODE_ENV = 'test'
    delete process.env.CONTROL_API_MEMBER_REGISTRATION_MODE
    const { config: c1 } = await import('../src/config.js')
    expect(c1.memberRegistrationMode).toBe('remote')

    vi.resetModules()
    process.env.CONTROL_API_MEMBER_REGISTRATION_MODE = 'bogus'
    const { config: c2 } = await import('../src/config.js')
    expect(c2.memberRegistrationMode).toBe('remote')
  })

  it('inviteAcceptBaseUrl falls back to the desktop profile-ui base url', async () => {
    process.env.NODE_ENV = 'test'
    delete process.env.CONTROL_API_INVITE_ACCEPT_BASE_URL
    process.env.CONTROL_API_DESKTOP_PROFILE_UI_BASE_URL = 'http://profile.example'
    const { config } = await import('../src/config.js')
    expect(config.inviteAcceptBaseUrl).toBe('http://profile.example')
  })

  it('remote mode in production still requires the member-registration base url', async () => {
    applyProdEnv(process.env)
    process.env.CONTROL_API_MEMBER_REGISTRATION_MODE = 'remote'
    delete process.env.CONTROL_API_MEMBER_REGISTRATION_SERVICE_BASE_URL
    await expect(() => import('../src/config.js')).rejects.toThrow(
      /CONTROL_API_MEMBER_REGISTRATION_SERVICE_BASE_URL/
    )
  })

  it('offline mode in production relaxes the base-url + HMAC requirements when acknowledged', async () => {
    applyProdEnv(process.env)
    process.env.CONTROL_API_MEMBER_REGISTRATION_MODE = 'offline'
    process.env.CONTROL_API_ALLOW_OFFLINE_IN_PROD = 'true'
    delete process.env.CONTROL_API_MEMBER_REGISTRATION_SERVICE_BASE_URL
    delete process.env.CONTROL_API_MEMBER_REGISTRATION_HMAC_SECRET
    const { config } = await import('../src/config.js')
    expect(config.memberRegistrationMode).toBe('offline')
    expect(config.memberRegistrationServiceBaseUrl).toBe('')
  })

  it('offline mode in production is rejected without the ack env var', async () => {
    applyProdEnv(process.env)
    process.env.CONTROL_API_MEMBER_REGISTRATION_MODE = 'offline'
    delete process.env.CONTROL_API_ALLOW_OFFLINE_IN_PROD
    await expect(() => import('../src/config.js')).rejects.toThrow(
      /offline member-registration mode is not permitted in production/
    )
  })
})
