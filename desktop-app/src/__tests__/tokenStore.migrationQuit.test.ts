import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const keytar = vi.hoisted(() => ({
  getPassword: vi.fn(),
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

const migrationCases = [
  ['scoped', { legacyEnvKeys: ['legacy-aaaaaaaaaaaa'] }, 'legacy-aaaaaaaaaaaa'],
  ['global', {}, 'session-token'],
] as const

describe('TokenStore legacy migration during macOS Quit', () => {
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

  afterAll(() => {
    expect(Object.getOwnPropertyDescriptor(process, 'platform')).toEqual(hostPlatformDescriptor)
  })

  it.each(migrationCases)(
    '%s legacy migration finishes after Quit closes admission',
    async (_kind, options, legacyAccount) => {
      const legacyRead = deferred<string | null>()
      keytar.getPassword.mockImplementation(async (_service: string, account: string) => {
        if (
          account ===
          (legacyAccount === 'session-token' ? legacyAccount : `session-token::${legacyAccount}`)
        ) {
          return legacyRead.promise
        }
        return null
      })

      const legacyKey =
        legacyAccount === 'session-token' ? legacyAccount : `session-token::${legacyAccount}`
      const read = new tokenStoreModule.TokenStore().getSessionToken(
        'current-bbbbbbbbbbbb',
        options
      )
      let drain: Promise<void> | undefined
      try {
        await vi.waitFor(() =>
          expect(keytar.getPassword).toHaveBeenCalledWith('Evenfire', legacyKey)
        )
        expect(tokenStoreModule.closeTokenStoreAdmission()).toBe(true)
        let drained = false
        drain = tokenStoreModule.waitForTokenStoreOperations().then(() => {
          drained = true
        })
        await new Promise(resolve => setImmediate(resolve))
        expect(drained).toBe(false)

        legacyRead.resolve('synthetic-legacy-token')
        await vi.waitFor(() => expect(keytar.setPassword).toHaveBeenCalledTimes(1))
        expect(keytar.setPassword).toHaveBeenCalledWith(
          'Evenfire',
          'session-token::current-bbbbbbbbbbbb',
          'synthetic-legacy-token'
        )
        await expect(read).resolves.toBe('synthetic-legacy-token')
        await drain
        expect(keytar.deletePassword).toHaveBeenCalledWith('Evenfire', legacyKey)
        expect(drained).toBe(true)
      } finally {
        legacyRead.resolve('synthetic-legacy-token')
        if (typeof tokenStoreModule.openTokenStoreAdmission === 'function') {
          tokenStoreModule.openTokenStoreAdmission()
        }
        await read
        await drain
      }
    }
  )
})
