import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { testSessionTokenWithExpiry } from '../../testSupport/authTestFixtures.js'
import type { AppService } from '../appService.js'

type Handler = (event: unknown, payload?: unknown) => Promise<unknown>

const electron = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  keychain: new Map<string, string>(),
  userDataDirectory: '',
}))

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: vi.fn(), getAllWindows: vi.fn(() => []) },
  Notification: vi.fn(),
  app: {
    getPath: vi.fn(() => electron.userDataDirectory),
    getVersion: vi.fn(() => '0.12.0'),
    isPackaged: false,
    isReady: vi.fn(() => true),
    on: vi.fn(),
    setName: vi.fn(),
    setPath: vi.fn(),
  },
  safeStorage: { isEncryptionAvailable: vi.fn(() => false) },
  clipboard: { writeText: vi.fn() },
  dialog: { showSaveDialog: vi.fn() },
  ipcMain: {
    handle: vi.fn((channel: string, handler: Handler) => {
      electron.handlers.set(channel, handler)
    }),
    on: vi.fn(),
    removeHandler: vi.fn(),
  },
}))

vi.mock('keytar', () => ({
  getPassword: vi.fn(
    async (service: string, account: string) =>
      electron.keychain.get(`${service}\u0000${account}`) ?? null
  ),
  setPassword: vi.fn(async (service: string, account: string, token: string) => {
    electron.keychain.set(`${service}\u0000${account}`, token)
  }),
  deletePassword: vi.fn(async (service: string, account: string) =>
    electron.keychain.delete(`${service}\u0000${account}`)
  ),
  findCredentials: vi.fn(async (service: string) =>
    [...electron.keychain.entries()]
      .filter(([key]) => key.startsWith(`${service}\u0000`))
      .map(([key, password]) => ({ account: key.slice(service.length + 1), password }))
  ),
}))

const trustedSender = { senderFrame: { url: 'file:///app/index.html' } }
let userDataDirectory = ''
let runtimeConfig: typeof import('../config.js')
let service: AppService
let acceptedToken = ''

async function call(channel: string, payload?: unknown): Promise<unknown> {
  const handler = electron.handlers.get(channel)
  if (!handler) throw new Error(`no IPC handler registered for ${channel}`)
  return handler(trustedSender, payload)
}

beforeEach(async () => {
  userDataDirectory = await fs.mkdtemp(join(tmpdir(), 'evenfire-ipc-env-selection-'))
  electron.userDataDirectory = userDataDirectory
  electron.handlers.clear()
  electron.keychain.clear()
  vi.resetModules()

  runtimeConfig = await import('../config.js')
  await runtimeConfig.saveDesktopRuntimeConfig({
    appName: 'Environment A',
    externalRestApiBaseUrl: 'https://api-a.example.test',
    rpcProxyBaseUrl: 'https://rpc-a.example.test',
  })
  await runtimeConfig.saveDesktopRuntimeConfig({
    appName: 'Environment B',
    externalRestApiBaseUrl: 'https://api-b.example.test',
    rpcProxyBaseUrl: 'https://rpc-b.example.test',
  })
  const optionA = runtimeConfig
    .getDesktopRuntimeConfigState()
    .options.find(option => option.appName === 'Environment A')
  if (!optionA) throw new Error('the runtime-config producer did not create environment A')
  await runtimeConfig.selectDesktopRuntimeConfigOption(optionA.id)

  const [{ AppService: AppServiceModule }, { TokenStore }, { registerIpcHandlers }] =
    await Promise.all([import('../appService.js'), import('../tokenStore.js'), import('../ipc.js')])
  service = new AppServiceModule({
    tokenStore: new TokenStore(),
    getUserDataDirectory: () => userDataDirectory,
  }) as unknown as AppService
  acceptedToken = testSessionTokenWithExpiry()
  const me = {
    id: 'user-a',
    email: 'user-a@example.test',
    name: 'User A',
    picture: null,
    teamId: 'team-a',
    teamName: 'Team A',
    role: 'member' as const,
  }
  ;(
    service as unknown as {
      authClient: {
        passwordLogin: ReturnType<typeof vi.fn>
        getMe: ReturnType<typeof vi.fn>
      }
    }
  ).authClient = {
    passwordLogin: vi.fn().mockResolvedValue({ token: acceptedToken, me }),
    getMe: vi.fn().mockResolvedValue(me),
  }
  await service.passwordLogin(me.email, 'synthetic-password')
  registerIpcHandlers(service)
})

afterEach(async () => {
  await service?.prepareForQuit()
  vi.restoreAllMocks()
  electron.handlers.clear()
  electron.keychain.clear()
  acceptedToken = ''
  if (userDataDirectory) await fs.rm(userDataDirectory, { recursive: true, force: true })
  userDataDirectory = ''
  electron.userDataDirectory = ''
})

describe('authenticated environment selection IPC', () => {
  const expectSelectionRejected = async (operation: () => Promise<unknown>) => {
    const stateBefore = runtimeConfig.getDesktopRuntimeConfigState()
    const environmentBefore = runtimeConfig.getActiveEnvKey()
    const tokenBefore = service.sessionToken
    await expect(operation()).rejects.toThrow('desktop_setup_requires_signout')
    expect(service.sessionToken).toBe(tokenBefore)
    expect(runtimeConfig.getActiveEnvKey()).toBe(environmentBefore)
    expect(runtimeConfig.getDesktopRuntimeConfigState()).toEqual(stateBefore)
    await expect(service.getSessionState()).resolves.toMatchObject({ authenticated: true })
  }

  const getEnvironmentBId = () => {
    const option = runtimeConfig
      .getDesktopRuntimeConfigState()
      .options.find(candidate => candidate.appName === 'Environment B')
    if (!option) throw new Error('the runtime-config producer did not create environment B')
    return option.id
  }

  it('rejects direct environment selection without logging out or changing the active environment', async () => {
    await expectSelectionRejected(() =>
      call('auth:selectRuntimeConfig', { optionId: getEnvironmentBId() })
    )
  })

  it('rejects handoff IPC without logging out or changing the active environment', async () => {
    await expectSelectionRejected(() =>
      call('auth:selectRuntimeConfigForHandoff', {
        optionId: getEnvironmentBId(),
        expectedSessionGeneration: service.getSessionGeneration(),
      })
    )
  })

  it('rejects IPC selection after restore fails while A remains durably selected', async () => {
    const stateBefore = runtimeConfig.getDesktopRuntimeConfigState()
    const oldService = service
    await oldService.prepareForQuit()

    const [{ AppService: AppServiceModule }, { TokenStore }, { registerIpcHandlers }] =
      await Promise.all([
        import('../appService.js'),
        import('../tokenStore.js'),
        import('../ipc.js'),
      ])
    const restarted = new AppServiceModule({
      tokenStore: new TokenStore(),
      getUserDataDirectory: () => userDataDirectory,
    }) as unknown as AppService
    const restartedAuthClient = (
      restarted as unknown as {
        authClient: { getMe: ReturnType<typeof vi.fn> }
      }
    ).authClient
    vi.spyOn(restartedAuthClient, 'getMe').mockRejectedValueOnce(
      Object.assign(new Error('synthetic identity lookup is temporarily unavailable'), {
        code: 'EMFILE',
      })
    )
    service = restarted
    registerIpcHandlers(service)

    await expect(service.initialize()).resolves.toMatchObject({ authenticated: false })
    expect(restartedAuthClient.getMe).toHaveBeenCalledExactlyOnceWith(acceptedToken)
    expect(runtimeConfig.getDesktopRuntimeConfigState()).toEqual(stateBefore)
    await expect(
      call('auth:selectRuntimeConfig', { optionId: getEnvironmentBId() })
    ).rejects.toThrow('desktop_setup_requires_signout')
    expect(runtimeConfig.getDesktopRuntimeConfigState()).toEqual(stateBefore)

    const { readSessionAuthoritySourceSelection } = await import('../sessionAuthorityAcceptance.js')
    const selection = await readSessionAuthoritySourceSelection({
      tokenStore: (restarted as unknown as { tokenStore: InstanceType<typeof TokenStore> })
        .tokenStore,
      envKey: runtimeConfig.resolveEnvKey(
        stateBefore.options.find(option => option.id === stateBefore.activeOptionId)!
          .externalRestApiBaseUrl,
        stateBefore.options.find(option => option.id === stateBefore.activeOptionId)!
          .rpcProxyBaseUrl
      ),
    })
    expect(selection).toMatchObject({ status: 'accepted', session: { token: acceptedToken } })
    expect(restartedAuthClient.getMe).toHaveBeenCalledExactlyOnceWith(acceptedToken)
  })

  it.each([undefined, 0])(
    'rejects runtime-config saves while authenticated (caller generation: %s)',
    async callerGeneration => {
      await expectSelectionRejected(() =>
        call('auth:saveRuntimeConfig', {
          appName: 'Environment B renamed',
          externalRestApiBaseUrl: 'https://api-b.example.test',
          rpcProxyBaseUrl: 'https://rpc-b.example.test',
          ...(callerGeneration === undefined
            ? {}
            : { expectedSessionGeneration: service.getSessionGeneration() }),
        })
      )
    }
  )

  it('rejects clearing the active selection while authenticated', async () => {
    await expectSelectionRejected(() => call('auth:clearRuntimeConfigSelection'))
  })

  it('rejects runtime-config deletion while authenticated', async () => {
    await expectSelectionRejected(() =>
      call('auth:deleteRuntimeConfig', {
        optionId: runtimeConfig.getDesktopRuntimeConfigState().activeOptionId,
      })
    )
  })

  it.each([
    ['direct selection', () => service.selectRuntimeConfig(getEnvironmentBId())],
    [
      'generation-bound selection',
      () =>
        service.selectRuntimeConfigForHandoff(getEnvironmentBId(), service.getSessionGeneration()),
    ],
    [
      'runtime-config save',
      () =>
        service.saveRuntimeConfig(
          {
            appName: 'Environment B renamed',
            externalRestApiBaseUrl: 'https://api-b.example.test',
            rpcProxyBaseUrl: 'https://rpc-b.example.test',
          },
          service.getSessionGeneration()
        ),
    ],
    ['selection clear', () => service.clearRuntimeConfigSelection()],
    ['runtime-config deletion', () => service.deleteRuntimeConfig(getEnvironmentBId())],
  ])('rejects internal AppService %s while authenticated', async (_label, operation) => {
    await expectSelectionRejected(operation)
  })

  it('rejects environment selection during a signed-out password login', async () => {
    await expect(service.logout()).resolves.toMatchObject({ kind: 'committed' })

    let resolveLogin: ((result: { token: string; me: Record<string, unknown> }) => void) | undefined
    const pendingLogin = new Promise<{ token: string; me: Record<string, unknown> }>(resolve => {
      resolveLogin = resolve
    })
    const authClient = (
      service as unknown as {
        authClient: {
          passwordLogin: ReturnType<typeof vi.fn>
          getMe: ReturnType<typeof vi.fn>
        }
      }
    ).authClient
    authClient.passwordLogin.mockReturnValueOnce(pendingLogin)
    const userB = {
      id: 'user-b',
      email: 'user-b@example.test',
      name: 'User B',
      picture: null,
      teamId: 'team-b',
      teamName: 'Team B',
      role: 'member' as const,
    }
    authClient.getMe.mockResolvedValueOnce(userB)

    const login = service.passwordLogin('user-b@example.test', 'synthetic-password')
    await vi.waitFor(() => expect(authClient.passwordLogin).toHaveBeenCalledTimes(2))

    await expect(
      call('auth:selectRuntimeConfig', { optionId: getEnvironmentBId() })
    ).rejects.toThrow('auth_transition_in_progress')

    resolveLogin?.({ token: testSessionTokenWithExpiry(), me: userB })
    await expect(login).resolves.toMatchObject({ authenticated: true })
  })
})
