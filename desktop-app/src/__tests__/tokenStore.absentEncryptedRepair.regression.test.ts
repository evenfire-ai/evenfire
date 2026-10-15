import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { SessionTokenStorageUnavailableBeforeWriteError, TokenStore } from '../tokenStore.js'

const fixture = vi.hoisted(() => ({ directory: '', encryptionAvailable: true }))
vi.mock('keytar', () => ({}))
vi.mock('electron', () => ({
  app: { isReady: () => true, getPath: () => fixture.directory },
  safeStorage: {
    isEncryptionAvailable: () => fixture.encryptionAvailable,
    encryptString: (token: string) => Buffer.from(`encrypted:${token}`),
    decryptString: (value: Buffer) => value.toString().slice('encrypted:'.length),
  },
}))
const ENV = 'absent_repair-111111111111'
beforeEach(async () => {
  fixture.directory = await fs.mkdtemp(path.join(os.tmpdir(), 'evenfire-absent-repair-'))
  fixture.encryptionAvailable = true
})
afterEach(async () => {
  await fs.rm(fixture.directory, { recursive: true, force: true })
})

describe('R21-M5 conditional encrypted cleanup distinguishes absence from unavailability', () => {
  it('returns false for an actual absent file without requiring encryption or producing credentials', async () => {
    fixture.encryptionAvailable = false
    await expect(
      new TokenStore().repairSafeStorageSessionTokenIfMatches('fixture-candidate', null, ENV)
    ).resolves.toBe(false)
    expect(await fs.readdir(fixture.directory)).toEqual([])
  })

  it('still refuses to inspect or delete an existing produced credential without encryption', async () => {
    const store = new TokenStore()
    await store.setSafeStorageSessionToken('fixture-candidate', ENV)
    fixture.encryptionAvailable = false
    await expect(
      store.repairSafeStorageSessionTokenIfMatches('fixture-candidate', null, ENV)
    ).rejects.toBeInstanceOf(SessionTokenStorageUnavailableBeforeWriteError)
    fixture.encryptionAvailable = true
    expect(await new TokenStore().getSafeStorageSessionToken(ENV)).toBe('fixture-candidate')
  })
})
