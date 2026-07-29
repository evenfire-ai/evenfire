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

describe('config: registry URL allowlist', () => {
  function enableSelfHostedRegistryEnv(): void {
    process.env.CLERUM_REGISTRY_AUTH_ENABLED = 'true'
    process.env.REGISTRY_CONNECTION_MODE = 'self-hosted'
  }

  it('accepts the shared registry.evenfire.ai by default (self-hoster path)', async () => {
    enableSelfHostedRegistryEnv()
    process.env.CLERUM_REGISTRY_URL = 'https://registry.evenfire.ai'
    const { config } = await import('../src/config.js')
    expect(config.registryUrl).toBe('https://registry.evenfire.ai')
  })

  it('still rejects a URL outside the allowlist', async () => {
    enableSelfHostedRegistryEnv()
    process.env.CLERUM_REGISTRY_URL = 'https://evil.example.org'
    await expect(import('../src/config.js')).rejects.toThrow(/not in the registry URL allowlist/)
  })

  it('accepts a URL added via CLERUM_REGISTRY_URL_ALLOWLIST (BYO registry), verbatim/case-sensitive', async () => {
    enableSelfHostedRegistryEnv()
    process.env.CLERUM_REGISTRY_URL = 'https://registry.MyCorp.example'
    process.env.CLERUM_REGISTRY_URL_ALLOWLIST =
      'https://other.example, https://registry.MyCorp.example'
    const { config } = await import('../src/config.js')
    // Non-vacuous: parseCsvList would have lowercased this to a mismatch; the
    // trim-only split preserves case so the verbatim compare passes.
    expect(config.registryUrl).toBe('https://registry.MyCorp.example')
  })
})

describe('boot validation — URL allowlist re-gating', () => {
  // The hole this task closes: today the allowlist only runs when auth is on,
  // and auth ships false, so a self-hosted deployment registers and claims
  // credentials against a totally unvalidated URL.
  it('self-hosted + unlisted URL throws even with NO auth env var', { retry: 0 }, async () => {
    vi.resetModules()
    delete process.env.CLERUM_REGISTRY_AUTH_ENABLED
    process.env.REGISTRY_CONNECTION_MODE = 'self-hosted'
    process.env.CLERUM_REGISTRY_URL = 'https://evil.example.net'
    await expect(import('../src/config.js')).rejects.toThrow(/allowlist/)
  })

  it('self-hosted + allowlisted URL boots with no auth env var', { retry: 0 }, async () => {
    vi.resetModules()
    delete process.env.CLERUM_REGISTRY_AUTH_ENABLED
    process.env.REGISTRY_CONNECTION_MODE = 'self-hosted'
    process.env.CLERUM_REGISTRY_URL = 'https://registry.evenfire.ai'
    await expect(import('../src/config.js')).resolves.toBeDefined()
  })

  // Regression guard for the managed hard constraint: mode UNSET (defaults to
  // managed) + a URL + auth off must still boot. This mirrors
  // startupGuards.registryConsumer.test.ts:85-91, restated here because two
  // spec revisions broke exactly this case.
  it('managed-by-default + URL + auth off still boots', { retry: 0 }, async () => {
    vi.resetModules()
    delete process.env.REGISTRY_CONNECTION_MODE
    process.env.CLERUM_REGISTRY_AUTH_ENABLED = 'false'
    process.env.CLERUM_REGISTRY_URL = 'https://registry.evenfire.ai'
    await expect(import('../src/config.js')).resolves.toBeDefined()
  })

  // The new explicit check. Today an empty URL with auth on throws via the
  // allowlist (allowed.includes('') is never true). The new allowlist block is
  // preconditioned on registryUrl !== '', which would skip it — so this needs
  // its own guard, and nothing covered it before.
  it('auth on with an EMPTY url throws', { retry: 0 }, async () => {
    vi.resetModules()
    process.env.CLERUM_REGISTRY_AUTH_ENABLED = 'true'
    process.env.REGISTRY_CONNECTION_MODE = 'managed'
    process.env.CLERUM_REGISTRY_CLIENT_ID = 'id'
    process.env.CLERUM_REGISTRY_CLIENT_SECRET = 's'
    process.env.CONTROL_API_REGISTRY_VOUCHER_PRIVATE_KEY = voucherPem()
    process.env.CONTROL_API_REGISTRY_VOUCHER_KID = 'key-uuid'
    delete process.env.CLERUM_REGISTRY_URL
    await expect(import('../src/config.js')).rejects.toThrow(/CLERUM_REGISTRY_URL is required/)
  })
})
