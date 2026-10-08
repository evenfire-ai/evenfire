import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
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
  it('fails closed when Keytar is unavailable in shared storage mode', async () => {
    const { TokenStore } = await import('../tokenStore.js')

    await expect(
      new TokenStore().clearSessionToken('env_a-000000000000', { throwOnStorageError: true })
    ).rejects.toMatchObject({ message: 'Failed to clear session token storage' })
  })
})
