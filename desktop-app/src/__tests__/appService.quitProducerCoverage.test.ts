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

async function createService() {
  const service = new AppServiceClass({
    tokenStore: new TokenStoreClass(),
    getUserDataDirectory: () => path.dirname(isolatedConfigPath),
  }) as unknown as {
    me: { id: string; teamId: string } | null
    sessionToken: string | null
    authClient: { switchTeam(token: string, teamId: string): Promise<unknown> }
    switchTeam: (teamId: string) => Promise<unknown>
    installAuthenticatedLogin: (result: unknown) => Promise<unknown>
    initialize: () => Promise<unknown>
    runWithTeamContext: <T>(
      teamId: string | null | undefined,
      operation: (sessionToken: string) => Promise<T>
    ) => Promise<T>
    prepareForQuit: () => Promise<void>
    getRuntimeConfigState: () => unknown
    saveRuntimeConfig: (next: {
      externalRestApiBaseUrl: string
      rpcProxyBaseUrl: string
      appName: string
    }) => Promise<unknown>
  }
  await service.prepareForQuit()
  return service
}

describe('AppService quit producer admission', () => {
  it('rejects a deliberate team switch after quit admission closes', async () => {
    const service = await createService()

    await expect(service.switchTeam('team-b')).rejects.toThrow('Application is shutting down')
  })

  it('rejects saved-session restore after quit admission closes', async () => {
    const service = await createService()

    await expect(service.initialize()).rejects.toThrow('Application is shutting down')
  })

  it('rejects login installation after quit admission closes', async () => {
    const service = await createService()

    await expect(
      service.installAuthenticatedLogin({ token: 'token', me: { id: 'user' } })
    ).rejects.toThrow('Application is shutting down')
  })

  it('rejects runtime-environment changes before their operation runs', async () => {
    const service = await createService()
    const previousRuntime = service.getRuntimeConfigState()

    await expect(
      service.saveRuntimeConfig({
        externalRestApiBaseUrl: 'https://quit-admission.example.invalid',
        rpcProxyBaseUrl: 'https://rpc.quit-admission.example.invalid',
        appName: 'Quit admission test',
      })
    ).rejects.toThrow('Application is shutting down')
    expect(service.getRuntimeConfigState()).toEqual(previousRuntime)
  })

  it('rejects a temporary team hop through the real quit gate before dispatch', async () => {
    const service = await createService()
    service.me = { id: 'user-1', teamId: 'team-a' }
    service.sessionToken = 'session-token'
    const switchTeam = vi.spyOn(service.authClient, 'switchTeam')

    await expect(service.runWithTeamContext('team-b', async token => token)).rejects.toThrow(
      'Application is shutting down'
    )
    expect(switchTeam).not.toHaveBeenCalled()
  })
})
