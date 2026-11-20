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
  app: { isReady: () => true, getPath: () => process.env.SPEC125_SCRATCH },
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
    const isolatedDir = await fs.mkdtemp(path.join(os.tmpdir(), 'spec125-isolated-'))
    const previousScratch = process.env.SPEC125_SCRATCH
    process.env.SPEC125_SCRATCH = isolatedDir
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
      if (previousScratch === undefined) delete process.env.SPEC125_SCRATCH
      else process.env.SPEC125_SCRATCH = previousScratch
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
})
