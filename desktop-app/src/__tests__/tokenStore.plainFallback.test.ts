import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Pure-fallback platform: keytar import fails AND safeStorage is unavailable, so
// the token round-trips through the per-env PLAIN-TEXT file. This locks the
// regression where the per-env plain file was written but never read back
// (silent logout on every restart).
vi.mock('keytar', () => {
  throw new Error('keytar unavailable on this platform')
})

let userDataDir = ''

vi.mock('electron', () => ({
  app: { isReady: vi.fn(() => true), getPath: vi.fn(() => userDataDir) },
  safeStorage: { isEncryptionAvailable: vi.fn(() => false) },
}))

const ENV_A = 'env_a-000000000000'
const ENV_B = 'env_b-111111111111'

let TokenStore: typeof import('../tokenStore.js').TokenStore

beforeEach(async () => {
  userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'evenfire-plainfallback-'))
  TokenStore = (await import('../tokenStore.js')).TokenStore
})

afterEach(async () => {
  await fs.rm(userDataDir, { recursive: true, force: true })
})

describe('TokenStore plain-text fallback (no keytar, no safeStorage)', () => {
  it('reads back a token it wrote to the per-env plain-text file (restart survival)', async () => {
    const store = new TokenStore()
    await store.setSessionToken('tok-a', ENV_A)
    // A fresh instance models a restart — no in-memory state carried over.
    expect(await new TokenStore().getSessionToken(ENV_A)).toBe('tok-a')
    // On disk under the env-scoped plain-text filename.
    expect(
      await fs
        .access(path.join(userDataDir, `session-token-${ENV_A}.json`))
        .then(() => true)
        .catch(() => false)
    ).toBe(true)
  })

  it('does not leak the plain-text token across environments', async () => {
    const store = new TokenStore()
    await store.setSessionToken('tok-a', ENV_A)
    expect(await store.getSessionToken(ENV_B)).toBeNull()
  })

  it('clear removes the per-env plain-text file', async () => {
    const store = new TokenStore()
    await store.setSessionToken('tok-a', ENV_A)
    await store.clearSessionToken(ENV_A)
    expect(await store.getSessionToken(ENV_A)).toBeNull()
  })
})
