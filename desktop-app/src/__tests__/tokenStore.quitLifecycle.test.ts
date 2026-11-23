import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const keytar = vi.hoisted(() => ({
  getPassword: vi.fn(async () => null),
  setPassword: vi.fn(async () => undefined),
  deletePassword: vi.fn(async () => true),
}))
const hostPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')

vi.mock('keytar', () => keytar)
vi.mock('electron', () => ({
  app: { isReady: () => true, getPath: () => process.env.TOKEN_STORE_TEST_USER_DATA },
  safeStorage: { isEncryptionAvailable: () => false },
}))

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}

describe('TokenStore macOS Quit admission', () => {
  let tokenStoreModule: typeof import('../tokenStore.js')
  let originalPlatformDescriptor: PropertyDescriptor | undefined

  beforeEach(async () => {
    originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    if (!originalPlatformDescriptor)
      throw new Error('Node process.platform descriptor is unavailable')
    Object.defineProperty(process, 'platform', { ...originalPlatformDescriptor, value: 'darwin' })
    vi.resetModules()
    keytar.getPassword.mockReset().mockResolvedValue(null)
    keytar.setPassword.mockReset().mockResolvedValue(undefined)
    keytar.deletePassword.mockReset().mockResolvedValue(true)
    tokenStoreModule = await import('../tokenStore.js')
  })

  afterAll(() => {
    expect(Object.getOwnPropertyDescriptor(process, 'platform')).toEqual(hostPlatformDescriptor)
  })

  afterEach(() => {
    try {
      if (typeof tokenStoreModule.openTokenStoreAdmission === 'function') {
        tokenStoreModule.openTokenStoreAdmission()
      }
    } finally {
      if (originalPlatformDescriptor) {
        Object.defineProperty(process, 'platform', originalPlatformDescriptor)
      }
    }
  })

  it('exports the lifecycle controls used by the macOS Quit coordinator', () => {
    expect(tokenStoreModule.closeTokenStoreAdmission).toBeTypeOf('function')
    expect(tokenStoreModule.openTokenStoreAdmission).toBeTypeOf('function')
    expect(tokenStoreModule.waitForTokenStoreOperations).toBeTypeOf('function')
  })

  it('does not gate isolated storage during macOS Quit', async () => {
    const isolatedDir = await fs.mkdtemp(path.join(os.tmpdir(), 'token-store-isolated-'))
    const previousUserData = process.env.TOKEN_STORE_TEST_USER_DATA
    process.env.TOKEN_STORE_TEST_USER_DATA = isolatedDir
    try {
      expect(tokenStoreModule.closeTokenStoreAdmission()).toBe(false)
      const store = new tokenStoreModule.TokenStore({ isolatedUserDataPath: isolatedDir })
      await store.setSessionToken('synthetic-isolated-value', 'isolated-aaaaaaaaaaaa')
      expect(keytar.setPassword).not.toHaveBeenCalled()
      await expect(
        fs.readFile(path.join(isolatedDir, 'session-token-isolated-aaaaaaaaaaaa.json'), 'utf8')
      ).resolves.toContain('synthetic-isolated-value')
    } finally {
      tokenStoreModule.openTokenStoreAdmission()
      if (previousUserData === undefined) delete process.env.TOKEN_STORE_TEST_USER_DATA
      else process.env.TOKEN_STORE_TEST_USER_DATA = previousUserData
      await fs.rm(isolatedDir, { recursive: true, force: true })
    }
  })

  it('keeps non-macOS TokenStore operations untracked', async () => {
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    if (!platformDescriptor) throw new Error('Node process.platform descriptor is unavailable')
    Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'linux' })
    try {
      const firstNativeWrite = deferred<void>()
      keytar.setPassword.mockImplementationOnce(() => firstNativeWrite.promise)
      const store = new tokenStoreModule.TokenStore()
      const first = store.setSessionToken('synthetic-first', 'first-aaaaaaaaaaaa')
      await vi.waitFor(() => expect(keytar.setPassword).toHaveBeenCalledTimes(1))
      expect(tokenStoreModule.closeTokenStoreAdmission()).toBe(false)
      const second = store.setSessionToken('synthetic-second', 'second-bbbbbbbbbbbb')
      await vi.waitFor(() => expect(keytar.setPassword).toHaveBeenCalledTimes(2))
      firstNativeWrite.resolve()
      await Promise.all([first, second])
    } finally {
      Object.defineProperty(process, 'platform', platformDescriptor)
    }
  })

  it('drains admitted writes and holds later calls until a canceled Quit reopens admission', async () => {
    const firstNativeWrite = deferred<void>()
    keytar.setPassword.mockImplementationOnce(() => firstNativeWrite.promise)
    const store = new tokenStoreModule.TokenStore()
    const first = store.setSessionToken('synthetic-first', 'first-aaaaaaaaaaaa')
    await vi.waitFor(() => expect(keytar.setPassword).toHaveBeenCalledTimes(1))

    expect(tokenStoreModule.closeTokenStoreAdmission()).toBe(true)
    let drained = false
    const drain = tokenStoreModule.waitForTokenStoreOperations().then(() => {
      drained = true
    })
    const second = store.setSessionToken('synthetic-second', 'second-bbbbbbbbbbbb')
    await new Promise(resolve => setImmediate(resolve))

    expect(keytar.setPassword).toHaveBeenCalledTimes(1)
    expect(drained).toBe(false)

    firstNativeWrite.resolve()
    await first
    await drain
    expect(drained).toBe(true)
    expect(keytar.setPassword).toHaveBeenCalledTimes(1)

    tokenStoreModule.openTokenStoreAdmission()
    await second
    expect(keytar.setPassword).toHaveBeenCalledTimes(2)
    expect(keytar.setPassword.mock.calls.map(([, account]) => account)).toEqual([
      'session-token::first-aaaaaaaaaaaa',
      'session-token::second-bbbbbbbbbbbb',
    ])
  })

  it('tracks getSessionToken until its held native read settles', async () => {
    const nativeRead = deferred<string | null>()
    keytar.getPassword.mockImplementationOnce(() => nativeRead.promise)
    const read = new tokenStoreModule.TokenStore().getSessionToken('current-bbbbbbbbbbbb')
    let drainSettled = false
    try {
      await vi.waitFor(() =>
        expect(keytar.getPassword).toHaveBeenCalledWith(
          'Evenfire',
          'session-token::current-bbbbbbbbbbbb'
        )
      )
      expect(tokenStoreModule.closeTokenStoreAdmission()).toBe(true)
      const drain = tokenStoreModule.waitForTokenStoreOperations().then(() => {
        drainSettled = true
      })
      await new Promise(resolve => setImmediate(resolve))
      expect(drainSettled).toBe(false)

      nativeRead.resolve('synthetic-current-token')
      await expect(read).resolves.toBe('synthetic-current-token')
      await drain
      expect(drainSettled).toBe(true)
    } finally {
      nativeRead.resolve('synthetic-current-token')
      tokenStoreModule.openTokenStoreAdmission()
      await read
    }
  })

  it('tracks clearSessionToken while its native delete is held', async () => {
    const nativeDelete = deferred<boolean>()
    keytar.deletePassword.mockImplementationOnce(() => nativeDelete.promise)
    const clear = new tokenStoreModule.TokenStore().clearSessionToken('current-bbbbbbbbbbbb')
    let drainSettled = false
    let drain: Promise<void> | undefined
    try {
      await vi.waitFor(() =>
        expect(keytar.deletePassword).toHaveBeenCalledWith(
          'Evenfire',
          'session-token::current-bbbbbbbbbbbb'
        )
      )
      expect(tokenStoreModule.closeTokenStoreAdmission()).toBe(true)
      drain = tokenStoreModule.waitForTokenStoreOperations().then(() => {
        drainSettled = true
      })
      await new Promise(resolve => setImmediate(resolve))
      expect(drainSettled).toBe(false)

      nativeDelete.resolve(true)
      await clear
      await drain
      expect(drainSettled).toBe(true)
    } finally {
      nativeDelete.resolve(true)
      tokenStoreModule.openTokenStoreAdmission()
      await clear
      await drain
    }
  })
})
