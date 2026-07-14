import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ORIGINAL_ENV = { ...process.env }

beforeEach(() => {
  vi.resetModules()
  process.env = { ...ORIGINAL_ENV }
  delete process.env.CLERUM_REGISTRY_URL
  delete process.env.CLERUM_REGISTRY_CLIENT_ID
  delete process.env.CLERUM_REGISTRY_CLIENT_SECRET
  delete process.env.CLERUM_REGISTRY_AUTH_ENABLED
  delete process.env.CLERUM_DEV_MODE
})

afterEach(() => {
  process.env = ORIGINAL_ENV
  vi.resetModules()
})

describe('startup guard — registry consumer auth', () => {
  it('throws when AUTH_ENABLED=true but CLIENT_ID is empty', async () => {
    process.env.CLERUM_REGISTRY_AUTH_ENABLED = 'true'
    process.env.CLERUM_REGISTRY_URL = 'https://example.com'
    process.env.CLERUM_REGISTRY_CLIENT_SECRET = 's'
    // CLIENT_ID intentionally absent.
    await expect(import('../src/config.js')).rejects.toThrow(/CLERUM_REGISTRY_CLIENT_ID/)
  })

  it('throws when AUTH_ENABLED=true but CLIENT_SECRET is empty', async () => {
    vi.resetModules()
    process.env.CLERUM_REGISTRY_AUTH_ENABLED = 'true'
    process.env.CLERUM_REGISTRY_URL = 'https://example.com'
    process.env.CLERUM_REGISTRY_CLIENT_ID = 'id'
    // CLIENT_SECRET intentionally absent.
    await expect(import('../src/config.js')).rejects.toThrow(/CLERUM_REGISTRY_CLIENT_SECRET/)
  })

  it('throws when CLERUM_REGISTRY_URL is not in the allowlist', async () => {
    vi.resetModules()
    process.env.CLERUM_REGISTRY_AUTH_ENABLED = 'true'
    process.env.CLERUM_REGISTRY_CLIENT_ID = 'id'
    process.env.CLERUM_REGISTRY_CLIENT_SECRET = 's'
    process.env.CLERUM_REGISTRY_URL = 'https://evil.example.com'
    await expect(import('../src/config.js')).rejects.toThrow(/not in the registry URL allowlist/)
  })

  it('accepts localhost URL when CLERUM_DEV_MODE=true', async () => {
    vi.resetModules()
    process.env.CLERUM_REGISTRY_AUTH_ENABLED = 'true'
    process.env.CLERUM_REGISTRY_CLIENT_ID = 'id'
    process.env.CLERUM_REGISTRY_CLIENT_SECRET = 's'
    process.env.CLERUM_REGISTRY_URL = 'http://localhost:8085'
    process.env.CLERUM_DEV_MODE = 'true'
    await expect(import('../src/config.js')).resolves.toBeDefined()
  })

  it('does not check creds when AUTH_ENABLED=false', async () => {
    vi.resetModules()
    process.env.CLERUM_REGISTRY_AUTH_ENABLED = 'false'
    process.env.CLERUM_REGISTRY_URL = 'https://example.com'
    // No client creds set.
    await expect(import('../src/config.js')).resolves.toBeDefined()
  })
})
