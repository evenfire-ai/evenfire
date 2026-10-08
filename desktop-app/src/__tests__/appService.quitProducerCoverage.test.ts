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
  const service = new AppServiceClass({
    tokenStore: new TokenStoreClass(),
    getUserDataDirectory: () => path.dirname(isolatedConfigPath),
  }) as unknown as {
    pendingCredentialProducers: Set<Promise<unknown>>
    quitPreparationStarted: boolean
    restoreSavedSessionInFlight: Promise<unknown> | null
    teamContextQueue: Promise<void>
    sessionToken: string | null
    me: { id: string; teamId: string } | null
    tokenStore: InstanceType<typeof TokenStoreClass>
    switchTeamOnce: ReturnType<typeof vi.fn>
    restoreSavedSessionOnce: ReturnType<typeof vi.fn>
    installAuthenticatedLoginOnce: ReturnType<typeof vi.fn>
    applyRuntimeEnvironmentChangeOnce: ReturnType<typeof vi.fn>
    getUserDataDirectory: () => string
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
  service.getUserDataDirectory = () => path.dirname(isolatedConfigPath)
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
    const service = new AppServiceClass({ tokenStore }) as unknown as {
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

  it('admits a queued team hop before quit closes producer admission', async () => {
    const firstOperation = deferred<string>()
    const firstOperationStarted = deferred<void>()
    const tokenStore = new TokenStoreClass()
    const prepareForQuit = vi.spyOn(tokenStore, 'prepareForQuit')
    const service = new AppServiceClass({ tokenStore }) as unknown as {
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
      cancelQuitPreparation: () => void
    }
    service.pendingCredentialProducers = new Set()
    service.quitPreparationStarted = false
    service.teamContextQueue = Promise.resolve()
    service.sessionToken = 'home-token'
    service.me = { id: 'user-1', teamId: 'team-home' }
    service.tokenStore = tokenStore
    service.requireSessionToken = vi.fn(() => service.sessionToken || 'home-token')
    service.getCurrentSessionTeamId = vi.fn(async token =>
      token === 'home-token' ? 'team-home' : token.replace(/-token$/, '')
    )
    service.switchSessionToTeam = vi.fn(async teamId => {
      service.me.teamId = teamId
      service.sessionToken = `${teamId}-token`
      return service.sessionToken
    })
    service.enterGfsTransientTeamHop = vi.fn(() => () => {})
    service.updateEntityChangeSessionToken = vi.fn()
    service.restartEntityChangeStreamForSessionReplacement = vi.fn()
    service.bindCurrentChatStore = vi.fn(async () => undefined)

    const firstHop = service.runWithTeamContext('team-a', async () => {
      firstOperationStarted.resolve()
      return firstOperation.promise
    })
    await firstOperationStarted.promise
    const queuedHop = service.runWithTeamContext('team-b', async token => token)
    const preparation = service.prepareForQuit()

    expect(prepareForQuit).not.toHaveBeenCalled()
    firstOperation.resolve('team-a-complete')
    await new Promise<void>(resolve => setImmediate(resolve))
    await new Promise<void>(resolve => setImmediate(resolve))
    service.cancelQuitPreparation()

    await expect(queuedHop).resolves.toBe('team-b-token')
    await Promise.all([firstHop, preparation])
    expect(prepareForQuit).toHaveBeenCalledOnce()
  })

  it('keeps a queued home-team hop admitted when an earlier hop fails to restore', async () => {
    const teamASwitch = deferred<void>()
    const teamASwitchStarted = deferred<void>()
    const tokenStore = new TokenStoreClass()
    const prepareForQuit = vi.spyOn(tokenStore, 'prepareForQuit')
    const service = new AppServiceClass({ tokenStore }) as unknown as {
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
    service.sessionToken = 'team-home-token'
    service.me = { id: 'user-1', teamId: 'team-home' }
    service.tokenStore = tokenStore
    service.requireSessionToken = vi.fn(() => service.sessionToken || 'team-home-token')
    service.getCurrentSessionTeamId = vi.fn(async () => service.me.teamId)
    let failHomeRestoreOnce = true
    service.switchSessionToTeam = vi.fn(async (teamId, token) => {
      if (teamId === 'team-a' && token === 'team-home-token') {
        teamASwitchStarted.resolve()
        await teamASwitch.promise
      }
      if (teamId === 'team-home' && token === 'team-a-token') {
        if (failHomeRestoreOnce) {
          failHomeRestoreOnce = false
          throw new Error('home-team restore failed once')
        }
      }
      service.me.teamId = teamId
      service.sessionToken = `${teamId}-token`
      return service.sessionToken
    })
    service.enterGfsTransientTeamHop = vi.fn(() => () => {})
    service.updateEntityChangeSessionToken = vi.fn()
    service.restartEntityChangeStreamForSessionReplacement = vi.fn()
    service.bindCurrentChatStore = vi.fn(async () => undefined)

    const firstHop = service.runWithTeamContext('team-a', async () => 'team-a-complete')
    const firstHopOutcome = expect(firstHop).rejects.toThrow('home-team restore failed once')
    await teamASwitchStarted.promise
    const queuedHomeHop = service.runWithTeamContext('team-home', async token => token)
    const preparation = service.prepareForQuit()

    expect(prepareForQuit).not.toHaveBeenCalled()
    teamASwitch.resolve()

    await expect(queuedHomeHop).resolves.toBe('team-home-token')
    await Promise.all([firstHopOutcome, preparation])
    expect(prepareForQuit).toHaveBeenCalledOnce()
    expect(service.switchSessionToTeam).toHaveBeenCalledWith('team-home', 'team-a-token')
  })
})
