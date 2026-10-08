import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

let testHome = ''
let restoreHomedir: (() => void) | undefined

vi.mock('keytar', () => ({}))

vi.mock('electron', () => ({
  app: { isReady: vi.fn(() => false), getPath: vi.fn(() => '/tmp/evenfire-strict-clear') },
  safeStorage: { isEncryptionAvailable: vi.fn(() => false) },
}))

beforeEach(async () => {
  testHome = await mkdtemp(path.join(os.tmpdir(), 'evenfire-strict-clear-'))
  const homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(testHome)
  restoreHomedir = () => homedirSpy.mockRestore()
})

afterEach(async () => {
  restoreHomedir?.()
  restoreHomedir = undefined
  if (testHome) await rm(testHome, { recursive: true, force: true })
  testHome = ''
  vi.resetModules()
})

describe('TokenStore strict session clearing', () => {
  it('clears file-backed credentials when the Keytar module is unavailable', async () => {
    const { TokenStore } = await import('../tokenStore.js')
    const storageDirectory = path.join(testHome, '.evenfire')
    const activeToken = path.join(storageDirectory, 'session-token-env_a-000000000000.json')
    const legacyToken = path.join(storageDirectory, 'session-token.json')
    await mkdir(storageDirectory, { recursive: true })
    await writeFile(activeToken, JSON.stringify({ token: 'active-token' }), { mode: 0o600 })
    await writeFile(legacyToken, JSON.stringify({ token: 'legacy-token' }), { mode: 0o600 })

    await expect(
      new TokenStore().clearSessionToken('env_a-000000000000', { throwOnStorageError: true })
    ).resolves.toBeUndefined()

    await expect(access(activeToken)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(access(legacyToken)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
