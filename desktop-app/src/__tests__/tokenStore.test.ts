import { beforeEach, describe, expect, it, vi } from 'vitest'

// In-memory keychain backing the mocked keytar module. Keyed by service:account
// so per-environment account isolation is directly observable.
const keychain = new Map<string, string>()
const keyOf = (service: string, account: string) => `${service}::${account}`

vi.mock('keytar', () => ({
  getPassword: vi.fn(async (service: string, account: string) =>
    keychain.has(keyOf(service, account)) ? keychain.get(keyOf(service, account))! : null
  ),
  setPassword: vi.fn(async (service: string, account: string, password: string) => {
    keychain.set(keyOf(service, account), password)
  }),
  deletePassword: vi.fn(async (service: string, account: string) =>
    keychain.delete(keyOf(service, account))
  ),
}))

// app.isReady()=false + safeStorage unavailable ⇒ the keytar path is the only
// active store, which is exactly what we want to assert per-env isolation on.
vi.mock('electron', () => ({
  app: { isReady: vi.fn(() => false), getPath: vi.fn(() => '/tmp/evenfire-test') },
  safeStorage: { isEncryptionAvailable: vi.fn(() => false) },
}))

const SERVICE = 'Evenfire'
const LEGACY_ACCOUNT = 'session-token'
// Realistic env keys: `resolveEnvKey` emits `<slug>-<12 hex>` where the slug is
// `[a-z0-9_]+` (non-alphanumerics collapsed to `_`), so the ONLY `-` is the
// hash separator.
const ENV_A = 'env_a-000000000000'
const ENV_B = 'env_b-111111111111'
const ENV_A_WITH_RPC = 'env_a_rpc-222222222222'

let TokenStore: typeof import('../tokenStore.js').TokenStore

beforeEach(async () => {
  keychain.clear()
  TokenStore = (await import('../tokenStore.js')).TokenStore
})

describe('TokenStore per-environment slots (spec §5.2)', () => {
  it('stores and reads a token under the env-scoped account', async () => {
    const store = new TokenStore()
    await store.setSessionToken('tok-a', ENV_A)
    expect(await store.getSessionToken(ENV_A)).toBe('tok-a')
    // Physically stored under the namespaced account, never the global one.
    expect(keychain.get(keyOf(SERVICE, `${LEGACY_ACCOUNT}::${ENV_A}`))).toBe('tok-a')
    expect(keychain.has(keyOf(SERVICE, LEGACY_ACCOUNT))).toBe(false)
  })

  it('does not leak env A token into env B', async () => {
    const store = new TokenStore()
    await store.setSessionToken('tok-a', ENV_A)
    expect(await store.getSessionToken(ENV_B)).toBeNull()

    await store.setSessionToken('tok-b', ENV_B)
    expect(await store.getSessionToken(ENV_A)).toBe('tok-a')
    expect(await store.getSessionToken(ENV_B)).toBe('tok-b')
  })

  it('clear only removes the active env slot (other env token survives)', async () => {
    const store = new TokenStore()
    await store.setSessionToken('tok-a', ENV_A)
    await store.setSessionToken('tok-b', ENV_B)

    await store.clearSessionToken(ENV_A)
    expect(await store.getSessionToken(ENV_A)).toBeNull()
    expect(await store.getSessionToken(ENV_B)).toBe('tok-b')
  })

  it('migrates a legacy global-slot token into the active env slot, then deletes it', async () => {
    // Simulate a pre-per-env install: token in the single global account.
    keychain.set(keyOf(SERVICE, LEGACY_ACCOUNT), 'legacy-tok')
    const store = new TokenStore()

    const migrated = await store.getSessionToken(ENV_A)
    expect(migrated).toBe('legacy-tok')
    // Copied into the env slot and removed from the legacy slot (no cross-env reuse).
    expect(keychain.get(keyOf(SERVICE, `${LEGACY_ACCOUNT}::${ENV_A}`))).toBe('legacy-tok')
    expect(keychain.has(keyOf(SERVICE, LEGACY_ACCOUNT))).toBe(false)

    // A second env no longer sees the (now-consumed) legacy token.
    expect(await store.getSessionToken(ENV_B)).toBeNull()
  })

  it('migrates an older env-scoped token into the active env slot, then deletes it', async () => {
    keychain.set(keyOf(SERVICE, `${LEGACY_ACCOUNT}::${ENV_A}`), 'rest-only-tok')
    const store = new TokenStore()

    const migrated = await store.getSessionToken(ENV_A_WITH_RPC, { legacyEnvKeys: [ENV_A] })
    expect(migrated).toBe('rest-only-tok')
    expect(keychain.get(keyOf(SERVICE, `${LEGACY_ACCOUNT}::${ENV_A_WITH_RPC}`))).toBe(
      'rest-only-tok'
    )
    expect(keychain.has(keyOf(SERVICE, `${LEGACY_ACCOUNT}::${ENV_A}`))).toBe(false)
    expect(await store.getSessionToken(ENV_A)).toBeNull()
  })

  it('clear removes the legacy global slot too (defense against later migration)', async () => {
    keychain.set(keyOf(SERVICE, LEGACY_ACCOUNT), 'legacy-tok')
    const store = new TokenStore()
    await store.setSessionToken('tok-a', ENV_A)

    await store.clearSessionToken(ENV_A)
    expect(keychain.has(keyOf(SERVICE, LEGACY_ACCOUNT))).toBe(false)
  })

  it('rejects a malformed envKey before it reaches account/file names', async () => {
    const store = new TokenStore()
    // Path-separator, traversal, wrong shape, and empty are all refused up front
    // so an attacker-controlled value can never build a keychain account or
    // on-disk filename.
    for (const bad of ['../etc', 'env_a/000000000000', 'env_a', 'ENV_A-000000000000', '']) {
      await expect(store.setSessionToken('tok', bad)).rejects.toThrow(/Invalid envKey/)
      await expect(store.getSessionToken(bad)).rejects.toThrow(/Invalid envKey/)
      await expect(store.clearSessionToken(bad)).rejects.toThrow(/Invalid envKey/)
    }
    // Nothing was written for any rejected key.
    expect(keychain.size).toBe(0)
  })
})
