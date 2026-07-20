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
  delete process.env.CLERUM_REGISTRY_URL
  delete process.env.CLERUM_REGISTRY_CLIENT_ID
  delete process.env.CLERUM_REGISTRY_CLIENT_SECRET
  delete process.env.CLERUM_REGISTRY_AUTH_ENABLED
  delete process.env.CLERUM_DEV_MODE
  delete process.env.REGISTRY_CONNECTION_MODE
})

afterEach(() => {
  process.env = ORIGINAL_ENV
  vi.resetModules()
})

describe('startup guard — registry consumer auth', () => {
  it('throws when AUTH_ENABLED=true and mode is unset', async () => {
    process.env.CLERUM_REGISTRY_AUTH_ENABLED = 'true'
    process.env.CLERUM_REGISTRY_URL = 'https://registry.evenfire.ai'
    process.env.CLERUM_REGISTRY_CLIENT_ID = 'id'
    process.env.CLERUM_REGISTRY_CLIENT_SECRET = 's'
    // REGISTRY_CONNECTION_MODE intentionally unset — must fail fast (S10).
    await expect(import('../src/config.js')).rejects.toThrow(/REGISTRY_CONNECTION_MODE.*required/)
  })

  it('throws when AUTH_ENABLED=true but CLIENT_ID is empty', async () => {
    process.env.CLERUM_REGISTRY_AUTH_ENABLED = 'true'
    process.env.REGISTRY_CONNECTION_MODE = 'managed'
    process.env.CLERUM_REGISTRY_URL = 'https://registry.evenfire.ai'
    process.env.CLERUM_REGISTRY_CLIENT_SECRET = 's'
    // CLIENT_ID intentionally absent.
    await expect(import('../src/config.js')).rejects.toThrow(/CLERUM_REGISTRY_CLIENT_ID/)
  })

  it('throws when AUTH_ENABLED=true but CLIENT_SECRET is empty', async () => {
    vi.resetModules()
    process.env.CLERUM_REGISTRY_AUTH_ENABLED = 'true'
    process.env.REGISTRY_CONNECTION_MODE = 'managed'
    process.env.CLERUM_REGISTRY_URL = 'https://registry.evenfire.ai'
    process.env.CLERUM_REGISTRY_CLIENT_ID = 'id'
    // CLIENT_SECRET intentionally absent.
    await expect(import('../src/config.js')).rejects.toThrow(/CLERUM_REGISTRY_CLIENT_SECRET/)
  })

  it('throws when CLERUM_REGISTRY_URL is not in the allowlist', async () => {
    vi.resetModules()
    process.env.CLERUM_REGISTRY_AUTH_ENABLED = 'true'
    process.env.REGISTRY_CONNECTION_MODE = 'managed'
    process.env.CLERUM_REGISTRY_CLIENT_ID = 'id'
    process.env.CLERUM_REGISTRY_CLIENT_SECRET = 's'
    process.env.CLERUM_REGISTRY_URL = 'https://evil.example.com'
    await expect(import('../src/config.js')).rejects.toThrow(/not in the registry URL allowlist/)
  })

  it('accepts localhost URL when CLERUM_DEV_MODE=true', async () => {
    vi.resetModules()
    process.env.CLERUM_REGISTRY_AUTH_ENABLED = 'true'
    process.env.REGISTRY_CONNECTION_MODE = 'managed'
    process.env.CLERUM_REGISTRY_CLIENT_ID = 'id'
    process.env.CLERUM_REGISTRY_CLIENT_SECRET = 's'
    process.env.CLERUM_REGISTRY_URL = 'http://localhost:8085'
    process.env.CLERUM_DEV_MODE = 'true'
    // Managed mode requires voucher v2 material (key + kid) — supply it so this
    // case exercises the URL allowlist accepting localhost in dev, not the
    // v2-material guard.
    process.env.CONTROL_API_REGISTRY_VOUCHER_PRIVATE_KEY = voucherPem()
    process.env.CONTROL_API_REGISTRY_VOUCHER_KID = 'key-uuid'
    await expect(import('../src/config.js')).resolves.toBeDefined()
  })

  it('does not check creds when AUTH_ENABLED=false', async () => {
    vi.resetModules()
    process.env.CLERUM_REGISTRY_AUTH_ENABLED = 'false'
    process.env.CLERUM_REGISTRY_URL = 'https://registry.evenfire.ai'
    // No client creds set.
    await expect(import('../src/config.js')).resolves.toBeDefined()
  })
})
