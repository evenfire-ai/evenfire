import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const ENV_A = 'env_a-000000000000'
let testHome = ''
let restoreHomedir: (() => void) | undefined

vi.mock('electron', () => ({
  app: { isReady: vi.fn(() => false), getPath: vi.fn(() => '/tmp/evenfire-test') },
  safeStorage: { isEncryptionAvailable: vi.fn(() => false) },
}))

afterEach(async () => {
  restoreHomedir?.()
  restoreHomedir = undefined
  if (testHome) await fs.rm(testHome, { recursive: true, force: true })
  testHome = ''
  vi.resetModules()
})

describe('TokenStore without the Keytar module', () => {
  it('strictly clears file-backed credentials when Keytar cannot load', async () => {
    testHome = await fs.mkdtemp(path.join(os.tmpdir(), 'evenfire-no-keytar-'))
    const homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(testHome)
    restoreHomedir = () => homedirSpy.mockRestore()
    vi.resetModules()
    vi.doMock('keytar', () => {
      throw new Error('Keytar native module unavailable')
    })

    const { TokenStore } = await import('../tokenStore.js')
    const storageDirectory = path.join(testHome, '.evenfire')
    await fs.mkdir(storageDirectory, { recursive: true })
    const activeToken = path.join(storageDirectory, `session-token-${ENV_A}.json`)
    const legacyToken = path.join(storageDirectory, 'session-token.json')
    await fs.writeFile(activeToken, JSON.stringify({ token: 'active-token' }), { mode: 0o600 })
    await fs.writeFile(legacyToken, JSON.stringify({ token: 'legacy-token' }), { mode: 0o600 })

    await expect(
      new TokenStore().clearSessionToken(ENV_A, { throwOnStorageError: true })
    ).resolves.toBeUndefined()

    await expect(fs.access(activeToken)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.access(legacyToken)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
