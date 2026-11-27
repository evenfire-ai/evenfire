import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const keytar = vi.hoisted(() => ({
  getPassword: vi.fn(async () => null),
  setPassword: vi.fn(async () => undefined),
  deletePassword: vi.fn(async () => true),
}))
const safeStorage = vi.hoisted(() => ({
  isEncryptionAvailable: vi.fn(() => false),
  encryptString: vi.fn((token: string) => Buffer.from(`encrypted:${token}`)),
  decryptString: vi.fn((encrypted: Buffer) => encrypted.toString().slice('encrypted:'.length)),
}))
const hostPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')

vi.mock('keytar', () => keytar)
vi.mock('electron', () => ({
  app: { isReady: () => true, getPath: () => process.env.TOKEN_STORE_TEST_USER_DATA },
  safeStorage,
}))

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}

const migrationCases = [
  { kind: 'scoped encrypted', source: 'scoped', encrypted: true },
  { kind: 'global encrypted', source: 'global', encrypted: true },
  { kind: 'scoped plaintext', source: 'scoped', encrypted: false },
  { kind: 'global plaintext', source: 'global', encrypted: false },
] as const
const keytarMigrationCases = [
  {
    kind: 'scoped Keychain',
    account: 'session-token::legacy-aaaaaaaaaaaa',
    options: { legacyEnvKeys: ['legacy-aaaaaaaaaaaa'] },
  },
  { kind: 'global Keychain', account: 'session-token', options: {} },
] as const

describe('TokenStore file migrations during macOS Quit', () => {
  let tokenStoreModule: typeof import('../tokenStore.js')
  let originalPlatformDescriptor: PropertyDescriptor | undefined
  let userDataDir: string
  let previousUserData: string | undefined

  beforeEach(async () => {
    originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    if (!originalPlatformDescriptor)
      throw new Error('Node process.platform descriptor is unavailable')
    Object.defineProperty(process, 'platform', { ...originalPlatformDescriptor, value: 'darwin' })
    userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'token-store-migration-'))
    previousUserData = process.env.TOKEN_STORE_TEST_USER_DATA
    process.env.TOKEN_STORE_TEST_USER_DATA = userDataDir
    vi.resetModules()
    keytar.getPassword.mockReset().mockResolvedValue(null)
    keytar.setPassword.mockReset().mockRejectedValue(new Error('synthetic keychain unavailable'))
    keytar.deletePassword.mockReset().mockResolvedValue(true)
    safeStorage.isEncryptionAvailable.mockReset().mockReturnValue(false)
    safeStorage.encryptString.mockClear()
    safeStorage.decryptString.mockClear()
    tokenStoreModule = await import('../tokenStore.js')
  })

  afterEach(async () => {
    try {
      tokenStoreModule.openTokenStoreAdmission()
    } finally {
      if (originalPlatformDescriptor) {
        Object.defineProperty(process, 'platform', originalPlatformDescriptor)
      }
      if (previousUserData === undefined) delete process.env.TOKEN_STORE_TEST_USER_DATA
      else process.env.TOKEN_STORE_TEST_USER_DATA = previousUserData
      await fs.rm(userDataDir, { recursive: true, force: true })
    }
  })

  afterAll(() => {
    expect(Object.getOwnPropertyDescriptor(process, 'platform')).toEqual(hostPlatformDescriptor)
  })

  it.each(keytarMigrationCases)(
    '$kind legacy migration drains after Quit closes admission',
    async ({ account, options }) => {
      const token = 'synthetic-keychain-migrated-token'
      const legacyRead = deferred<string | null>()
      keytar.getPassword.mockImplementation(async (_service: string, requestedAccount: string) =>
        requestedAccount === account ? legacyRead.promise : null
      )
      keytar.setPassword.mockResolvedValue(undefined)
      const read = new tokenStoreModule.TokenStore().getSessionToken(
        'current-bbbbbbbbbbbb',
        options
      )
      let drained = false
      let drain: Promise<void> | undefined
      try {
        await vi.waitFor(() => expect(keytar.getPassword).toHaveBeenCalledWith('Evenfire', account))
        expect(tokenStoreModule.closeTokenStoreAdmission()).toBe(true)
        drain = tokenStoreModule.waitForTokenStoreOperations().then(() => {
          drained = true
        })
        await new Promise(resolve => setImmediate(resolve))
        expect(drained).toBe(false)

        legacyRead.resolve(token)
        await vi.waitFor(() => expect(keytar.setPassword).toHaveBeenCalledTimes(1))
        expect(keytar.setPassword).toHaveBeenCalledWith(
          'Evenfire',
          'session-token::current-bbbbbbbbbbbb',
          token
        )
        await expect(read).resolves.toBe(token)
        await drain
        expect(keytar.deletePassword).toHaveBeenCalledWith('Evenfire', account)
        expect(drained).toBe(true)
      } finally {
        legacyRead.resolve(token)
        tokenStoreModule.openTokenStoreAdmission()
        await read
        await drain
      }
    }
  )

  it.each(migrationCases)(
    '$kind legacy migration drains after Quit closes admission',
    async ({ source, encrypted }) => {
      const envKey = 'current-bbbbbbbbbbbb'
      const legacyEnvKey = 'legacy-aaaaaaaaaaaa'
      const token = 'synthetic-migrated-token'
      const sourceFile = path.join(
        userDataDir,
        source === 'global'
          ? encrypted
            ? 'session-token.enc'
            : 'session-token.json'
          : encrypted
            ? `session-token-${legacyEnvKey}.enc`
            : `session-token-${legacyEnvKey}.json`
      )
      const destinationFile = path.join(
        userDataDir,
        encrypted ? `session-token-${envKey}.enc` : `session-token-${envKey}.json`
      )
      const sourceRead = deferred<void>()
      const allowSourceRead = deferred<void>()
      const allowRename = deferred<void>()
      let migrationRead: Promise<string | null> | undefined
      let sourceReadPaused = false
      let destinationRenamePaused = false
      const originalReadFile = fs.readFile.bind(fs)
      const originalRename = fs.rename.bind(fs)
      const readFile = vi.spyOn(fs, 'readFile').mockImplementation(async (file, ...args) => {
        if (String(file) === sourceFile && !sourceReadPaused) {
          sourceReadPaused = true
          sourceRead.resolve()
          await allowSourceRead.promise
        }
        return originalReadFile(file as never, ...(args as never[]))
      })
      const rename = vi.spyOn(fs, 'rename').mockImplementation(async (oldPath, newPath) => {
        if (String(newPath) === destinationFile && !destinationRenamePaused) {
          destinationRenamePaused = true
          await allowRename.promise
        }
        return originalRename(oldPath, newPath)
      })

      try {
        safeStorage.isEncryptionAvailable.mockReturnValue(encrypted)
        await fs.writeFile(
          sourceFile,
          encrypted ? Buffer.from(`encrypted:${token}`) : JSON.stringify({ token }),
          { mode: 0o600 }
        )
        migrationRead = new tokenStoreModule.TokenStore().getSessionToken(envKey, {
          legacyEnvKeys: source === 'scoped' ? [legacyEnvKey] : [],
        })

        await sourceRead.promise
        expect(tokenStoreModule.closeTokenStoreAdmission()).toBe(true)
        let drained = false
        const drain = tokenStoreModule.waitForTokenStoreOperations().then(() => {
          drained = true
        })
        allowSourceRead.resolve()
        await vi.waitFor(() =>
          expect(rename).toHaveBeenCalledWith(expect.any(String), destinationFile)
        )
        expect(destinationRenamePaused).toBe(true)
        expect(drained).toBe(false)
        expect(rename).toHaveBeenCalledWith(
          expect.stringContaining(`${destinationFile}.`),
          destinationFile
        )
        allowRename.resolve()

        await expect(migrationRead).resolves.toBe(token)
        await drain
        expect(drained).toBe(true)
        expect(keytar.setPassword).toHaveBeenCalledWith(
          'Evenfire',
          'session-token::current-bbbbbbbbbbbb',
          token
        )
        expect(keytar.deletePassword).not.toHaveBeenCalled()
        if (encrypted) {
          expect(safeStorage.decryptString).toHaveBeenCalled()
          expect(safeStorage.encryptString).toHaveBeenCalledWith(token)
          expect(safeStorage.decryptString(await fs.readFile(destinationFile))).toBe(token)
        } else {
          await expect(fs.readFile(destinationFile, 'utf8')).resolves.toBe(
            JSON.stringify({ token })
          )
        }
        await expect(fs.access(sourceFile)).rejects.toMatchObject({ code: 'ENOENT' })
      } finally {
        allowSourceRead.resolve()
        allowRename.resolve()
        tokenStoreModule.openTokenStoreAdmission()
        try {
          await migrationRead
        } finally {
          readFile.mockRestore()
          rename.mockRestore()
        }
      }
    }
  )
})
