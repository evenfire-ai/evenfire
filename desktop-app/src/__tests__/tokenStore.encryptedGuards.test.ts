import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  SessionTokenStorageUnavailableBeforeWriteError,
  TokenStore,
  isQualifiedSafeStorageAvailable,
} from '../tokenStore.js'

const fixture = vi.hoisted(() => ({
  directory: '',
  encryptionAvailable: true,
  backend: 'gnome_libsecret',
}))
vi.mock('keytar', () => ({}))
vi.mock('electron', () => ({
  app: { isReady: () => true, getPath: () => fixture.directory },
  safeStorage: {
    isEncryptionAvailable: () => fixture.encryptionAvailable,
    getSelectedStorageBackend: () => fixture.backend,
    encryptString: (token: string) => Buffer.from(`encrypted:${token}`),
    decryptString: (value: Buffer) => value.toString().slice('encrypted:'.length),
  },
}))
vi.mock('../windowsSessionAuthorityAcl.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../windowsSessionAuthorityAcl.js')>()
  const { createWindowsSessionAuthorityAclUnitFixture } =
    await import('../../testSupport/windowsSessionAuthorityAclUnitFixture.js')
  return createWindowsSessionAuthorityAclUnitFixture(actual)
})
vi.mock('../windowsSessionAuthorityFileOps.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../windowsSessionAuthorityFileOps.js')>()
  const { createWindowsSessionAuthorityFileOpsUnitFixture } =
    await import('../../testSupport/windowsSessionAuthorityFileOpsUnitFixture.js')
  return createWindowsSessionAuthorityFileOpsUnitFixture(actual)
})
const ENV = 'guards-111111111111'
const file = () => path.join(fixture.directory, `session-token-${ENV}.enc`)
const conditionalOperations = ['discard', 'repair'] as const
function conditionalOperation(
  operation: (typeof conditionalOperations)[number],
  store = new TokenStore()
) {
  return operation === 'discard'
    ? store.discardSafeStorageSessionTokenIfMatches('fixture-candidate', ENV)
    : store.repairSafeStorageSessionTokenIfMatches('fixture-candidate', null, ENV)
}
beforeEach(async () => {
  fixture.directory = await fs.mkdtemp(path.join(os.tmpdir(), 'evenfire-encrypted-guards-'))
  fixture.encryptionAvailable = true
  fixture.backend = 'gnome_libsecret'
})
afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(fixture.directory, { recursive: true, force: true })
})
describe('encrypted conditional operation guards', () => {
  it('rejects Linux basic_text even when Electron encryption reports available', async () => {
    fixture.backend = 'basic_text'
    expect(isQualifiedSafeStorageAvailable('linux')).toBe(false)
    fixture.backend = 'kwallet6'
    expect(isQualifiedSafeStorageAvailable('linux')).toBe(true)
  })

  it('preserves the existing Electron secureStorage qualification on macOS and Windows', () => {
    expect(isQualifiedSafeStorageAvailable('darwin')).toBe(true)
    expect(isQualifiedSafeStorageAvailable('win32')).toBe(true)
  })

  it('reports unavailable safeStorage as a typed before-write receipt without plaintext or encrypted output', async () => {
    fixture.encryptionAvailable = false
    const writing = new TokenStore({
      isolatedUserDataPath: fixture.directory,
    }).setSafeStorageSessionToken('fixture-never-written', ENV)
    await expect(writing).rejects.toBeInstanceOf(SessionTokenStorageUnavailableBeforeWriteError)
    await expect(writing).rejects.toMatchObject({ storageSource: 'safe-storage' })
    expect(await fs.readdir(fixture.directory)).toEqual([])
  })
  it.each(conditionalOperations)(
    '%s returns false for actual ENOENT without creating a file',
    async operation => {
      await expect(conditionalOperation(operation)).resolves.toBe(false)
      expect(await fs.readdir(fixture.directory)).toEqual([])
    }
  )
  it('reports true only after deleting the exact produced candidate', async () => {
    const store = new TokenStore()
    await store.setSafeStorageSessionToken('fixture-candidate', ENV)
    expect(await store.discardSafeStorageSessionTokenIfMatches('fixture-candidate', ENV)).toBe(true)
    expect(await new TokenStore().getSafeStorageSessionToken(ENV)).toBeNull()
    expect(await fs.readdir(fixture.directory)).toEqual([])
  })
  it('reports false and preserves the real newer encrypted credential', async () => {
    const store = new TokenStore()
    await store.setSafeStorageSessionToken('fixture-newer-user', ENV)
    expect(await store.discardSafeStorageSessionTokenIfMatches('fixture-candidate', ENV)).toBe(
      false
    )
    expect(await new TokenStore().getSafeStorageSessionToken(ENV)).toBe('fixture-newer-user')
  })
  it.each(conditionalOperations)(
    '%s refuses a real symlink without reading or deleting its produced target',
    async operation => {
      const store = new TokenStore()
      await store.setSafeStorageSessionToken('fixture-candidate', ENV)
      const target = path.join(fixture.directory, 'fixture-produced-target.enc')
      await fs.rename(file(), target)
      await fs.symlink(target, file())
      await expect(conditionalOperation(operation, store)).rejects.toThrow()
      expect((await fs.lstat(file())).isSymbolicLink()).toBe(true)
      await fs.unlink(file())
      await fs.rename(target, file())
      expect(await new TokenStore().getSafeStorageSessionToken(ENV)).toBe('fixture-candidate')
    }
  )
  it.skipIf(process.platform === 'win32').each(conditionalOperations)(
    '%s refuses a real nonregular FIFO before decrypting bytes',
    async operation => {
      execFileSync('mkfifo', [file()])
      await expect(conditionalOperation(operation)).rejects.toThrow(
        'Encrypted session token is not a regular file'
      )
      expect((await fs.lstat(file())).isFIFO()).toBe(true)
    }
  )
})
