import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const originalConfigPath = process.env.CLERUM_DESKTOP_CONFIG_PATH
let isolatedConfigPath = ''
let AppServiceClass: typeof import('../appService.js').AppService

beforeAll(async () => {
  const isolatedDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'evenfire-quit-drain-'))
  isolatedConfigPath = path.join(isolatedDirectory, 'runtime-config.json')
  process.env.CLERUM_DESKTOP_CONFIG_PATH = isolatedConfigPath
  vi.resetModules()
  ;({ AppService: AppServiceClass } = await import('../appService.js'))
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
    const tokenStore = {
      prepareForQuit: vi.fn(() => tokenStoreDrain.promise),
      reopenAdmission: vi.fn(),
    }
    const service = Object.create(AppServiceClass.prototype) as {
      pendingCredentialProducers: Set<Promise<unknown>>
      quitPreparationStarted: boolean
      tokenStore: typeof tokenStore
      prepareForQuit: () => Promise<void>
    }
    service.pendingCredentialProducers = new Set()
    service.quitPreparationStarted = false
    service.tokenStore = tokenStore

    let preparationSettled = false
    const preparation = service.prepareForQuit().then(() => {
      preparationSettled = true
    })

    try {
      expect(tokenStore.prepareForQuit).toHaveBeenCalledOnce()
      await Promise.resolve()
      expect(preparationSettled).toBe(false)

      tokenStoreDrain.resolve()
      await preparation
      expect(preparationSettled).toBe(true)
    } finally {
      tokenStoreDrain.resolve()
      await preparation
    }
  })
})
