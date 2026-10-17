import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Plaintext writes are explicitly isolated-development fixtures. Production
// migration from a historical plaintext source must select secure storage.
vi.mock('keytar', () => {
  throw new Error('keytar unavailable on this platform')
})

let userDataDir = ''

vi.mock('electron', () => ({
  app: { isReady: vi.fn(() => true), getPath: vi.fn(() => userDataDir) },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => false),
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString: (token: string) => Buffer.from(`encrypted:${token}`),
    decryptString: (value: Buffer) => value.toString().slice('encrypted:'.length),
  },
}))

const ENV_A = 'env_a-000000000000'
const ENV_B = 'env_b-111111111111'

let TokenStore: typeof import('../tokenStore.js').TokenStore

beforeEach(async () => {
  userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'evenfire-plainfallback-'))
  const { safeStorage } = await import('electron')
  vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(false)
  TokenStore = (await import('../tokenStore.js')).TokenStore
})

afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(userDataDir, { recursive: true, force: true })
})

describe('TokenStore isolated plaintext and historical migration compatibility', () => {
  it('does not use file fallback when Keytar replacement is required but Keytar is absent', async () => {
    const store = new TokenStore()

    await expect(
      store.setSessionToken('fresh-token', ENV_A, { requireKeytar: true })
    ).rejects.toThrow('Keytar is unavailable during session-token replacement')

    expect(await fs.readdir(userDataDir)).toEqual([])
  })

  it('reads back a token it wrote to the per-env plain-text file (restart survival)', async () => {
    const store = new TokenStore({ isolatedUserDataPath: userDataDir })
    await store.setSessionToken('tok-a', ENV_A)
    // A fresh instance models a restart — no in-memory state carried over.
    expect(await new TokenStore({ isolatedUserDataPath: userDataDir }).getSessionToken(ENV_A)).toBe(
      'tok-a'
    )
    // On disk under the env-scoped plain-text filename.
    expect(
      await fs
        .access(path.join(userDataDir, `session-token-${ENV_A}.json`))
        .then(() => true)
        .catch(() => false)
    ).toBe(true)
  })

  it('preserves the legacy token when scoped persistence fails during migration', async () => {
    const { safeStorage } = await import('electron')
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true)
    const legacyFile = path.join(userDataDir, 'session-token.json')
    const scopedFile = path.join(userDataDir, `session-token-${ENV_A}.enc`)
    await fs.writeFile(legacyFile, JSON.stringify({ token: 'legacy-token' }))
    const originalRename = fs.rename.bind(fs)
    let renameAttempted = false
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(to) === scopedFile) {
        renameAttempted = true
        const error = new Error('disk full') as NodeJS.ErrnoException
        error.code = 'ENOSPC'
        throw error
      }
      return originalRename(from, to)
    })

    await expect(new TokenStore().getSessionToken(ENV_A)).resolves.toBeNull()
    expect(renameAttempted).toBe(true)

    expect(JSON.parse(await fs.readFile(legacyFile, 'utf8'))).toEqual({
      token: 'legacy-token',
    })
    await expect(fs.access(scopedFile)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await fs.readdir(userDataDir)).filter(name => name.endsWith('.tmp'))).toEqual([])
  })

  it('flushes the scoped token file and parent directory before acknowledging persistence', async () => {
    const actualDirectory = await fs.realpath(userDataDir)
    const originalOpen = fs.open.bind(fs)
    const syncedPaths: string[] = []
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const filePath = String(args[0])
      const handle = await originalOpen(...(args as Parameters<typeof fs.open>))
      return {
        writeFile: (value: Parameters<typeof handle.writeFile>[0]) => handle.writeFile(value),
        sync: async () => {
          syncedPaths.push(filePath)
          await handle.sync()
        },
        close: () => handle.close(),
      } as Awaited<ReturnType<typeof fs.open>>
    })

    await new TokenStore({ isolatedUserDataPath: userDataDir }).setSessionToken('tok-a', ENV_A)

    expect(
      syncedPaths.some(
        filePath =>
          filePath.startsWith(path.join(actualDirectory, `session-token-${ENV_A}.json.`)) &&
          filePath.endsWith('.tmp')
      )
    ).toBe(true)
    expect(syncedPaths).toContain(actualDirectory)
  })

  it('does not leak the plain-text token across environments', async () => {
    const store = new TokenStore({ isolatedUserDataPath: userDataDir })
    await store.setSessionToken('tok-a', ENV_A)
    expect(await store.getSessionToken(ENV_B)).toBeNull()
  })

  it('clear removes the per-env plain-text file', async () => {
    const store = new TokenStore({ isolatedUserDataPath: userDataDir })
    await store.setSessionToken('tok-a', ENV_A)
    await store.clearSessionToken(ENV_A)
    expect(await store.getSessionToken(ENV_A)).toBeNull()
  })
})
