import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const originalConfigPath = process.env.CLERUM_DESKTOP_CONFIG_PATH
let isolatedConfigPath = ''
let AppServiceClass: typeof import('../appService.js').AppService
let TokenStoreClass: typeof import('../tokenStore.js').TokenStore

beforeAll(async () => {
  const isolatedDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'evenfire-quit-producers-'))
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

function createService() {
  const service = Object.create(AppServiceClass.prototype) as {
    pendingCredentialProducers: Set<Promise<unknown>>
    quitPreparationStarted: boolean
    restoreSavedSessionInFlight: Promise<unknown> | null
    teamContextQueue: Promise<void>
    switchTeamOnce: ReturnType<typeof vi.fn>
    restoreSavedSessionOnce: ReturnType<typeof vi.fn>
    installAuthenticatedLoginOnce: ReturnType<typeof vi.fn>
    applyRuntimeEnvironmentChangeOnce: ReturnType<typeof vi.fn>
    requireSessionToken: () => string
    getCurrentSessionTeamId: (token: string) => Promise<string>
    switchSessionToTeam: ReturnType<typeof vi.fn>
    switchTeam: (teamId: string) => Promise<unknown>
    restoreSavedSession: () => Promise<unknown>
    installAuthenticatedLogin: (result: unknown) => Promise<unknown>
    applyRuntimeEnvironmentChange: (operation: () => Promise<void>) => Promise<void>
    runWithTeamContext: <T>(
      teamId: string | null | undefined,
      operation: (sessionToken: string) => Promise<T>
    ) => Promise<T>
  }
  service.pendingCredentialProducers = new Set()
  service.quitPreparationStarted = true
  service.restoreSavedSessionInFlight = null
  service.teamContextQueue = Promise.resolve()
  service.switchTeamOnce = vi.fn().mockResolvedValue(undefined)
  service.restoreSavedSessionOnce = vi.fn().mockResolvedValue(undefined)
  service.installAuthenticatedLoginOnce = vi.fn().mockResolvedValue(undefined)
  service.applyRuntimeEnvironmentChangeOnce = vi.fn().mockResolvedValue(undefined)
  service.requireSessionToken = vi.fn(() => 'session-token')
  service.getCurrentSessionTeamId = vi.fn(async () => 'team-a')
  service.switchSessionToTeam = vi.fn().mockResolvedValue('switched-token')
  return service
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}

describe('AppService quit producer admission', () => {
  it('rejects a deliberate team switch after quit admission closes', async () => {
    const service = createService()

    await expect(service.switchTeam('team-b')).rejects.toThrow('Application is shutting down')
    expect(service.switchTeamOnce).not.toHaveBeenCalled()
  })

  it('rejects saved-session restore after quit admission closes', async () => {
    const service = createService()

    await expect(service.restoreSavedSession()).rejects.toThrow('Application is shutting down')
    expect(service.restoreSavedSessionOnce).not.toHaveBeenCalled()
  })

  it('rejects login installation after quit admission closes', async () => {
    const service = createService()

    await expect(
      service.installAuthenticatedLogin({ token: 'token', me: { id: 'user' } })
    ).rejects.toThrow('Application is shutting down')
    expect(service.installAuthenticatedLoginOnce).not.toHaveBeenCalled()
  })

  it('rejects runtime-environment changes before their operation runs', async () => {
    const service = createService()
    const changeRuntime = vi.fn(async () => undefined)

    await expect(service.applyRuntimeEnvironmentChange(changeRuntime)).rejects.toThrow(
      'Application is shutting down'
    )
    expect(changeRuntime).not.toHaveBeenCalled()
    expect(service.applyRuntimeEnvironmentChangeOnce).not.toHaveBeenCalled()
  })

  it('rejects a temporary team hop before switching credentials', async () => {
    const service = createService()
    service.me = { id: 'user-1', teamId: 'team-a' }
    service.sessionToken = 'session-token'

    await expect(service.runWithTeamContext('team-b', async token => token)).rejects.toThrow(
      'Application is shutting down'
    )
    expect(service.switchSessionToTeam).not.toHaveBeenCalled()
  })

  it('waits for an admitted temporary team hop before draining TokenStore', async () => {
    const operation = deferred<string>()
    const operationStarted = deferred<void>()
    const tokenStore = new TokenStoreClass()
    const prepareForQuit = vi.spyOn(tokenStore, 'prepareForQuit')
    const service = Object.create(AppServiceClass.prototype) as {
      pendingCredentialProducers: Set<Promise<unknown>>
      quitPreparationStarted: boolean
      teamContextQueue: Promise<void>
      sessionToken: string | null
      me: { id: string; teamId: string }
      tokenStore: InstanceType<typeof TokenStoreClass>
      requireSessionToken: () => string
      getCurrentSessionTeamId: (token: string) => Promise<string>
      switchSessionToTeam: (teamId: string, token: string) => Promise<string>
      enterGfsTransientTeamHop: () => () => void
      updateEntityChangeSessionToken: (token: string | null) => void
      restartEntityChangeStreamForSessionReplacement: () => void
      bindCurrentChatStore: (userId: string) => Promise<void>
      runWithTeamContext: <T>(
        teamId: string | null | undefined,
        operation: (sessionToken: string) => Promise<T>
      ) => Promise<T>
      prepareForQuit: () => Promise<void>
    }
    service.pendingCredentialProducers = new Set()
    service.quitPreparationStarted = false
    service.teamContextQueue = Promise.resolve()
    service.sessionToken = 'home-token'
    service.me = { id: 'user-1', teamId: 'team-a' }
    service.tokenStore = tokenStore
    service.requireSessionToken = vi.fn(() => 'home-token')
    service.getCurrentSessionTeamId = vi.fn(async () => 'team-a')
    service.switchSessionToTeam = vi.fn(async teamId =>
      teamId === 'team-b' ? 'borrowed-token' : 'home-token'
    )
    service.enterGfsTransientTeamHop = vi.fn(() => () => {})
    service.updateEntityChangeSessionToken = vi.fn()
    service.restartEntityChangeStreamForSessionReplacement = vi.fn()
    service.bindCurrentChatStore = vi.fn(async () => undefined)

    const hop = service.runWithTeamContext('team-b', async () => {
      operationStarted.resolve()
      return operation.promise
    })
    await operationStarted.promise

    const preparation = service.prepareForQuit()
    expect(prepareForQuit).not.toHaveBeenCalled()
    operation.resolve('team-hop-complete')
    await Promise.all([hop, preparation])

    expect(prepareForQuit).toHaveBeenCalledOnce()
    expect(service.switchSessionToTeam).toHaveBeenCalledTimes(2)
  })
})
