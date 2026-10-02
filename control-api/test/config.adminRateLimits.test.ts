import { afterEach, describe, expect, it, vi } from 'vitest'

const KEYS = [
  'CONTROL_API_ADMIN_SUBSCRIPTION_READ_PER_MIN',
  'CONTROL_API_ADMIN_SUBSCRIPTION_WRITE_PER_MIN',
  'CONTROL_API_SUBSCRIPTION_OAUTH_CALLBACK_PER_MIN',
] as const

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

async function readConfig(overrides: Partial<Record<(typeof KEYS)[number], string>> = {}) {
  for (const key of KEYS) vi.stubEnv(key, overrides[key] ?? '')
  vi.resetModules()
  const { config } = await import('../src/config.js')
  // Keep failure diagnostics limited to the contract under test. The full
  // configuration also owns cryptographic material and must never be printed.
  return {
    adminSubscriptionReadPerMin: config.adminSubscriptionReadPerMin,
    adminSubscriptionWritePerMin: config.adminSubscriptionWritePerMin,
    subscriptionOAuthCallbackPerMin: config.subscriptionOAuthCallbackPerMin,
  }
}

describe('administrative subscription capacity', () => {
  it('defaults to five times the incident thresholds', async () => {
    const config = await readConfig()
    expect(config.adminSubscriptionReadPerMin).toBe(150)
    expect(config.adminSubscriptionWritePerMin).toBe(100)
    expect(config.subscriptionOAuthCallbackPerMin).toBe(100)
  })

  it('honors distinct explicit operation budgets', async () => {
    const config = await readConfig({
      CONTROL_API_ADMIN_SUBSCRIPTION_READ_PER_MIN: '321',
      CONTROL_API_ADMIN_SUBSCRIPTION_WRITE_PER_MIN: '123',
      CONTROL_API_SUBSCRIPTION_OAUTH_CALLBACK_PER_MIN: '234',
    })
    expect(config.adminSubscriptionReadPerMin).toBe(321)
    expect(config.adminSubscriptionWritePerMin).toBe(123)
    expect(config.subscriptionOAuthCallbackPerMin).toBe(234)
  })

  for (const key of KEYS) {
    it.each(['0', '-1', '1.5', 'NaN', '9007199254740992'])(
      `rejects invalid ${key}=%s at boot`,
      async value => {
        await expect(readConfig({ [key]: value })).rejects.toThrow(
          `${key} must be a positive integer`
        )
      }
    )
  }
})
