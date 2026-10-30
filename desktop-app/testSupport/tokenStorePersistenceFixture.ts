import { vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export const tokenStorePersistenceFixture = {
  directory: '',
  encryptionAvailable: true,
  keychain: new Map<string, string>(),
}

export const tokenStoreKeytarFixture = {
  getPassword: vi.fn(
    async (_service: string, account: string) =>
      tokenStorePersistenceFixture.keychain.get(account) ?? null
  ),
  setPassword: vi.fn(async (_service: string, account: string, token: string) => {
    tokenStorePersistenceFixture.keychain.set(account, token)
  }),
  deletePassword: vi.fn(async (_service: string, account: string) =>
    tokenStorePersistenceFixture.keychain.delete(account)
  ),
}

export function createTokenStoreElectronFixture() {
  return {
    app: { isReady: () => true, getPath: () => tokenStorePersistenceFixture.directory },
    safeStorage: {
      isEncryptionAvailable: () => tokenStorePersistenceFixture.encryptionAvailable,
      getSelectedStorageBackend: () => 'gnome_libsecret',
      encryptString: (token: string) => Buffer.from(`encrypted:${token}`),
      decryptString: (value: Buffer) => value.toString().slice('encrypted:'.length),
    },
  }
}

export async function resetTokenStorePersistenceFixture(prefix: string): Promise<void> {
  const fixture = tokenStorePersistenceFixture
  fixture.directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  fixture.encryptionAvailable = true
  fixture.keychain.clear()
  tokenStoreKeytarFixture.getPassword
    .mockReset()
    .mockImplementation(async (_service, account) => fixture.keychain.get(account) ?? null)
  tokenStoreKeytarFixture.setPassword
    .mockReset()
    .mockImplementation(async (_service, account, token) => {
      fixture.keychain.set(account, token)
    })
  tokenStoreKeytarFixture.deletePassword
    .mockReset()
    .mockImplementation(async (_service, account) => fixture.keychain.delete(account))
}

export async function disposeTokenStorePersistenceFixture(): Promise<void> {
  const fixture = tokenStorePersistenceFixture
  await fs.rm(fixture.directory, { recursive: true, force: true })
  fixture.directory = ''
  fixture.keychain.clear()
}
