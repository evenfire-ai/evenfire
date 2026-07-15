import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'

const ORIGINAL_ENV = { ...process.env }

function voucherPem(): string {
  return generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  }).privateKey
}

beforeEach(() => {
  vi.resetModules()
  process.env = { ...ORIGINAL_ENV }
  // Baseline: registry auth OFF (minikube) so unrelated guards don't fire.
  delete process.env.CLERUM_REGISTRY_AUTH_ENABLED
  delete process.env.CLERUM_REGISTRY_URL
  delete process.env.CLERUM_REGISTRY_CLIENT_ID
  delete process.env.CLERUM_REGISTRY_CLIENT_SECRET
  delete process.env.REGISTRY_CONNECTION_MODE
})
afterEach(() => {
  process.env = ORIGINAL_ENV
  vi.resetModules()
})

function enableManagedRegistryEnv(): void {
  process.env.CLERUM_REGISTRY_AUTH_ENABLED = 'true'
  process.env.CLERUM_REGISTRY_URL = 'https://example.com'
  process.env.CLERUM_REGISTRY_CLIENT_ID = 'id'
  process.env.CLERUM_REGISTRY_CLIENT_SECRET = 's'
  // Managed mode requires voucher v2 material (key + kid) — supply it so a
  // managed boot reaches success rather than tripping the mandatory guard.
  process.env.CONTROL_API_REGISTRY_VOUCHER_PRIVATE_KEY = voucherPem()
  process.env.CONTROL_API_REGISTRY_VOUCHER_KID = 'key-uuid'
}

describe('config: REGISTRY_CONNECTION_MODE discriminator', () => {
  it('defaults to managed when unset and registry auth is off', async () => {
    const { config } = await import('../src/config.js')
    expect(config.registryConnectionMode).toBe('managed')
  })

  it('accepts an explicit self-hosted value', async () => {
    process.env.REGISTRY_CONNECTION_MODE = 'self-hosted'
    const { config } = await import('../src/config.js')
    expect(config.registryConnectionMode).toBe('self-hosted')
  })

  it('throws on an invalid value', async () => {
    process.env.REGISTRY_CONNECTION_MODE = 'hybrid'
    await expect(import('../src/config.js')).rejects.toThrow(/REGISTRY_CONNECTION_MODE/)
  })

  it('requires the mode to be set explicitly when registry auth is enabled', async () => {
    enableManagedRegistryEnv()
    // REGISTRY_CONNECTION_MODE intentionally unset.
    await expect(import('../src/config.js')).rejects.toThrow(/REGISTRY_CONNECTION_MODE.*required/)
  })

  it('logs the resolved mode at import for an enabled registry', async () => {
    enableManagedRegistryEnv()
    process.env.REGISTRY_CONNECTION_MODE = 'managed'
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    await import('../src/config.js')
    const lines = logSpy.mock.calls.map(c => String(c[0]))
    expect(lines.some(l => /Registry connection mode: managed/.test(l))).toBe(true)
  })
})
