import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const originalConfigPath = process.env.CLERUM_DESKTOP_CONFIG_PATH
let isolatedConfigPath = ''
let AppServiceClass: typeof import('../appService.js').AppService
let TokenStoreClass: typeof import('../tokenStore.js').TokenStore

beforeAll(async () => {
  const isolatedDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'evenfire-quit-drain-'))
  isolatedConfigPath = path.join(isolatedDirectory, 'runtime-config.json')
  process.env.CLERUM_DESKTOP_CONFIG_PATH = isolatedConfigPath
  vi.resetModules()
  const [{ AppService }, tokenStoreModule] = await Promise.all([
    import('../appService.js'),
    import('../tokenStore.js'),
  ])
  AppServiceClass = AppService
  TokenStoreClass = tokenStoreModule.TokenStore
})

afterAll(async () => {
  if (originalConfigPath === undefined) {
    delete process.env.CLERUM_DESKTOP_CONFIG_PATH
  } else {
    process.env.CLERUM_DESKTOP_CONFIG_PATH = originalConfigPath
  }
  if (isolatedConfigPath) {
    await fs.rm(path.dirname(isolatedConfigPath), { recursive: true, force: true })
  }
  vi.resetModules()
})

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}

describe('AppService TokenStore quit drain ordering', () => {
  it('does not complete quit preparation while the TokenStore drain is pending', async () => {
    const tokenStoreDrain = deferred<void>()
    const tokenStoreOperationStarted = deferred<void>()
    const tokenStore = new TokenStoreClass()
    const tokenStoreSeam = tokenStore as unknown as {
      setSessionTokenOnce: (token: string, envKey: string) => Promise<void>
    }
    const setSessionTokenOnce = vi
      .spyOn(tokenStoreSeam, 'setSessionTokenOnce')
      .mockImplementation(async () => {
        tokenStoreOperationStarted.resolve()
        await tokenStoreDrain.promise
      })
    const acceptedWrite = tokenStore.setSessionToken('active-token', 'env_a-000000000000')
    const prepareForQuit = vi.spyOn(tokenStore, 'prepareForQuit')
    await tokenStoreOperationStarted.promise

    const service = Object.create(AppServiceClass.prototype) as {
      pendingCredentialProducers: Set<Promise<unknown>>
      quitPreparationStarted: boolean
      tokenStore: InstanceType<typeof TokenStoreClass>
      prepareForQuit: () => Promise<void>
    }
    service.pendingCredentialProducers = new Set()
    service.quitPreparationStarted = false
    service.tokenStore = tokenStore

    let preparationSettled = false
    const preparation = service.prepareForQuit().then(() => {
      preparationSettled = true
    })
    let lateWrite: Promise<void> | null = null

    try {
      expect(prepareForQuit).toHaveBeenCalledOnce()
      await Promise.resolve()
      expect(preparationSettled).toBe(false)
      lateWrite = tokenStore.setSessionToken('late-token', 'env_a-000000000000')
      await Promise.resolve()
      expect(setSessionTokenOnce).toHaveBeenCalledOnce()
      await expect(lateWrite).rejects.toThrow('Application is shutting down')

      tokenStoreDrain.resolve()
      await Promise.all([acceptedWrite, preparation])
      expect(preparationSettled).toBe(true)
    } finally {
      tokenStoreDrain.resolve()
      await Promise.allSettled([acceptedWrite, ...(lateWrite ? [lateWrite] : []), preparation])
    }
  })
})
