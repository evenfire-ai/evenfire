import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPublicKey } from 'node:crypto'
import { applyProdEnv, generateNonDevPem } from './fixtures/productionConfigEnv.js'

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

  it('throws in managed mode when CONTROL_API_REGISTRY_VOUCHER_PRIVATE_KEY is unset', async () => {
    process.env.CLERUM_REGISTRY_AUTH_ENABLED = 'true'
    process.env.CLERUM_REGISTRY_URL = 'https://registry.evenfire.ai'
    process.env.REGISTRY_CONNECTION_MODE = 'managed'
    process.env.CLERUM_REGISTRY_CLIENT_ID = 'id'
    process.env.CLERUM_REGISTRY_CLIENT_SECRET = 's'
    process.env.CONTROL_API_REGISTRY_VOUCHER_KID = 'key-uuid'
    delete process.env.CONTROL_API_REGISTRY_VOUCHER_PRIVATE_KEY
    await expect(() => import('../src/config.js')).rejects.toThrow(
      /CONTROL_API_REGISTRY_VOUCHER_PRIVATE_KEY/
    )
  })

  it('boots in managed mode with the dedicated voucher key + kid set', async () => {
    process.env.CLERUM_REGISTRY_AUTH_ENABLED = 'true'
    process.env.CLERUM_REGISTRY_URL = 'https://registry.evenfire.ai'
    process.env.REGISTRY_CONNECTION_MODE = 'managed'
    process.env.CLERUM_REGISTRY_CLIENT_ID = 'id'
    process.env.CLERUM_REGISTRY_CLIENT_SECRET = 's'
    process.env.CONTROL_API_REGISTRY_VOUCHER_PRIVATE_KEY = generateNonDevPem()
    process.env.CONTROL_API_REGISTRY_VOUCHER_KID = 'key-uuid'
    await expect(import('../src/config.js')).resolves.toBeDefined()
  })

  it('checks the voucher signing slot against the banned fingerprints in production', async () => {
    const voucherKey = generateNonDevPem()
    const guard = await import('../src/bannedDevSigningKeys.js')
    const voucherFingerprint = guard.publicKeyPemFingerprint(
      createPublicKey(voucherKey).export({ type: 'spki', format: 'pem' }).toString()
    )
    // Inject a generated identity into the real guard's ban set; historical
    // private material must never become a tracked test fixture.
    const fingerprints = new Set([
      ...guard.BANNED_DEV_JWT_PUBLIC_KEY_FINGERPRINTS,
      voucherFingerprint,
    ])
    const assertNoBannedJwtKeys = guard.assertNoBannedJwtKeys
    vi.spyOn(guard, 'assertNoBannedJwtKeys').mockImplementation(input =>
      assertNoBannedJwtKeys(input, fingerprints)
    )
    process.env.CONTROL_API_REGISTRY_VOUCHER_PRIVATE_KEY = voucherKey

    await expect(() => import('../src/config.js')).rejects.toThrow(
      /CONTROL_API_REGISTRY_VOUCHER_PRIVATE_KEY resolves to a historically committed dev JWT key/
    )
  })

  it('rejects default dev internal service tokens in production', async () => {
    process.env.CONTROL_API_INTERNAL_SERVICE_TOKENS =
      'external-rest-api=dev-external-rest-api-token'

    await expect(() => import('../src/config.js')).rejects.toThrow(
      /default dev internal service token/
    )
  })
})
