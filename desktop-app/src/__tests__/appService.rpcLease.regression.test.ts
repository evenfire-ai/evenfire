import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const fixture = vi.hoisted(() => ({ directory: '' }))
const keytar = vi.hoisted(() => ({
  getPassword: vi.fn(),
  setPassword: vi.fn(),
  deletePassword: vi.fn(),
}))

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => fixture.directory), isReady: vi.fn(() => true) },
  safeStorage: { isEncryptionAvailable: vi.fn(() => false) },
  shell: { openExternal: vi.fn() },
}))
vi.mock('keytar', () => keytar)
vi.mock('../chatStoreBinding.js', async () => {
  const { createChatStoreBindingMock } = await import('../../testSupport/chatStoreBindingMock.js')
  return createChatStoreBindingMock()
})
vi.mock('../pluginSdkRuntime.js', () => ({
  tryGetPluginSdkRuntime: () => ({ notifySessionChanged: vi.fn() }),
}))

function sessionToken(identity = 'rpc-lease-user'): string {
  const payload = Buffer.from(
    JSON.stringify({ sub: identity, exp: Math.floor(Date.now() / 1000) + 60 * 60 })
  ).toString('base64url')
  return `header.${payload}.signature`
}

const me = {
  id: 'rpc-lease-user',
  email: 'rpc-lease@example.test',
  name: null,
  picture: null,
  teamId: 'rpc-lease-team',
  teamName: 'RPC lease team',
  role: 'member',
}

const scopes = ['sandbox:ui:view']
const hostRefs = ['sandbox-ui']

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

describe('temporary AppService RPC lease', () => {
  let directory = ''
  let AppService: typeof import('../appService.js').AppService
  let TokenStore: typeof import('../tokenStore.js').TokenStore
  let setSessionInvalidationHandler: typeof import('../httpClient.js').setSessionInvalidationHandler

  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    const oldRest = process.env.EXTERNAL_REST_API_BASE_URL
    const oldRpc = process.env.RPC_PROXY_BASE_URL
    const oldConfigPath = process.env.CLERUM_DESKTOP_CONFIG_PATH
    process.env.EXTERNAL_REST_API_BASE_URL = 'http://rest.rpc-lease.test'
    process.env.RPC_PROXY_BASE_URL = 'http://proxy.rpc-lease.test'
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'evenfire-rpc-lease-'))
    fixture.directory = directory
    process.env.CLERUM_DESKTOP_CONFIG_PATH = path.join(directory, 'desktop-runtime.json')
    const credentialStoreDenied = Object.assign(new Error('OS credential store denied access'), {
      code: 'EACCES',
    })
    keytar.getPassword.mockRejectedValue(credentialStoreDenied)
    keytar.setPassword.mockRejectedValue(credentialStoreDenied)
    keytar.deletePassword.mockRejectedValue(credentialStoreDenied)
    const [appServiceModule, tokenStoreModule, httpModule] = await Promise.all([
      import('../appService.js'),
      import('../tokenStore.js'),
      import('../httpClient.js'),
    ])
    AppService = appServiceModule.AppService
    TokenStore = tokenStoreModule.TokenStore
    setSessionInvalidationHandler = httpModule.setSessionInvalidationHandler
    // Keep the compiler-visible originals for the exact-environment cleanup below.
    ;(
      fixture as typeof fixture & { oldRest?: string; oldRpc?: string; oldConfigPath?: string }
    ).oldRest = oldRest
    ;(fixture as typeof fixture & { oldRpc?: string; oldConfigPath?: string }).oldRpc = oldRpc
    ;(fixture as typeof fixture & { oldConfigPath?: string }).oldConfigPath = oldConfigPath
  })

  afterEach(async () => {
    setSessionInvalidationHandler?.(undefined)
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    if (directory) await fs.rm(directory, { recursive: true, force: true })
    const env = fixture as typeof fixture & {
      oldRest?: string
      oldRpc?: string
      oldConfigPath?: string
    }
    if (env.oldRest === undefined) delete process.env.EXTERNAL_REST_API_BASE_URL
    else process.env.EXTERNAL_REST_API_BASE_URL = env.oldRest
    if (env.oldRpc === undefined) delete process.env.RPC_PROXY_BASE_URL
    else process.env.RPC_PROXY_BASE_URL = env.oldRpc
    if (env.oldConfigPath === undefined) delete process.env.CLERUM_DESKTOP_CONFIG_PATH
    else process.env.CLERUM_DESKTOP_CONFIG_PATH = env.oldConfigPath
    vi.resetModules()
  })

  function credentialResponse(token: string, user = me) {
    return new Response(JSON.stringify({ token, me: user }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }

  function meResponse(user = me) {
    return new Response(JSON.stringify(user), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }

  function rpcTokenResponse(
    token = 'derived-rpc-credential',
    issuedScopes = scopes,
    issuedHostRefs = hostRefs,
    teamId = me.teamId
  ) {
    return new Response(
      JSON.stringify({
        token,
        accessScope: 'team',
        teamId,
        scopes: issuedScopes,
        hostRefs: issuedHostRefs,
        expiresInSeconds: 300,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    )
  }

  function createService() {
    return new AppService({ tokenStore: new TokenStore(), getUserDataDirectory: () => directory })
  }

  it('does not dispatch an RPC mint that finishes after the temporary lease expires', async () => {
    let resolveMint!: (response: Response) => void
    const mintPending = new Promise<Response>(resolve => {
      resolveMint = resolve
    })
    const accessToken = sessionToken()
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/api/v1/auth/v2/password-login'))
        return Promise.resolve(credentialResponse(accessToken))
      if (url.endsWith('/api/v1/me')) return Promise.resolve(meResponse())
      if (url.endsWith('/api/v1/rpc/token')) return mintPending
      if (url.endsWith('/api/v1/sandbox-ui/apps'))
        return Promise.resolve(
          new Response(JSON.stringify({ apps: [] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        )
      return Promise.reject(new Error(`unexpected HTTP request: ${url}`))
    })
    vi.stubGlobal('fetch', fetchMock)

    const service = createService()
    vi.spyOn(service as any, 'resolveRuntimeConfigIfNeeded').mockResolvedValue(undefined)
    await service.passwordLogin('rpc-lease@example.test', 'fixture-password')
    const rpcClient = (service as any).rpcClient
    const downstream = vi.spyOn(rpcClient, 'listSandboxUiApps')
    const mintingOperation = service.listSandboxUiApps().then(
      value => ({ value }),
      error => ({ error })
    )
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3))
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 25 * 60 * 60 * 1000)
    expect(service.checkTemporarySessionExpiry()).toBe(true)
    resolveMint(rpcTokenResponse())

    await expect(mintingOperation).resolves.toHaveProperty('error')
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(downstream).not.toHaveBeenCalled()
    expect(service.getCachedUserId()).toBeNull()
    await (service as any).memoryOnlySessionTermination
  })

  it('rejects an in-flight RPC mint after logout before downstream dispatch', async () => {
    let resolveMint!: (response: Response) => void
    const mintPending = new Promise<Response>(resolve => {
      resolveMint = resolve
    })
    const accessToken = sessionToken()
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/api/v1/auth/v2/password-login'))
        return Promise.resolve(credentialResponse(accessToken))
      if (url.endsWith('/api/v1/me')) return Promise.resolve(meResponse())
      if (url.endsWith('/api/v1/rpc/token')) return mintPending
      if (url.endsWith('/api/v1/sandbox-ui/apps'))
        return Promise.resolve(
          new Response(JSON.stringify({ apps: [] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        )
      return Promise.reject(new Error(`unexpected HTTP request: ${url}`))
    })
    vi.stubGlobal('fetch', fetchMock)

    const service = createService()
    vi.spyOn(service as any, 'resolveRuntimeConfigIfNeeded').mockResolvedValue(undefined)
    await service.passwordLogin('rpc-lease@example.test', 'fixture-password')
    const rpcClient = (service as any).rpcClient
    const downstream = vi.spyOn(rpcClient, 'listSandboxUiApps')
    const operation = service.listSandboxUiApps().then(
      value => ({ value }),
      error => ({ error })
    )
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3))

    await service.logout()
    const callsBeforeMintCompletion = fetchMock.mock.calls.length
    resolveMint(rpcTokenResponse('late-rpc-credential-after-logout'))

    await expect(operation).resolves.toHaveProperty('error')
    expect(fetchMock).toHaveBeenCalledTimes(callsBeforeMintCompletion)
    expect(downstream).not.toHaveBeenCalled()
    expect(service.getCachedUserId()).toBeNull()
  })

  it('rejects an in-flight RPC mint after account replacement before downstream dispatch', async () => {
    let resolveMint!: (response: Response) => void
    const mintPending = new Promise<Response>(resolve => {
      resolveMint = resolve
    })
    const firstToken = sessionToken('rpc-lease-user-a')
    const secondUser = { ...me, id: 'rpc-lease-user-b', email: 'new@example.test' }
    const secondToken = sessionToken(secondUser.id)
    let loginNumber = 0
    let rpcTokenNumber = 0
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/api/v1/auth/v2/password-login')) {
        loginNumber += 1
        return Promise.resolve(
          credentialResponse(
            loginNumber === 1 ? firstToken : secondToken,
            loginNumber === 1 ? me : secondUser
          )
        )
      }
      if (url.endsWith('/api/v1/me')) {
        const authorization = new Headers(init?.headers).get('authorization')
        return Promise.resolve(
          meResponse(authorization === `Bearer ${secondToken}` ? secondUser : me)
        )
      }
      if (url.endsWith('/api/v1/rpc/token')) {
        rpcTokenNumber += 1
        return rpcTokenNumber === 1
          ? mintPending
          : Promise.resolve(rpcTokenResponse('rpc-token-for-replacement-session'))
      }
      if (url.endsWith('/api/v1/sandbox-ui/apps'))
        return Promise.resolve(
          new Response(JSON.stringify({ apps: [] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        )
      return Promise.reject(new Error(`unexpected HTTP request: ${url}`))
    })
    vi.stubGlobal('fetch', fetchMock)

    const service = createService()
    vi.spyOn(service as any, 'resolveRuntimeConfigIfNeeded').mockResolvedValue(undefined)
    await service.passwordLogin('rpc-lease@example.test', 'first-password')
    const rpcClient = (service as any).rpcClient
    const downstream = vi.spyOn(rpcClient, 'listSandboxUiApps')
    const operation = service.listSandboxUiApps().then(
      value => ({ value }),
      error => ({ error })
    )
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3))

    await service.passwordLogin('new@example.test', 'second-password')
    const callsBeforeMintCompletion = fetchMock.mock.calls.length
    resolveMint(rpcTokenResponse('late-rpc-credential-from-old-account'))

    await expect(operation).resolves.toHaveProperty('error')
    expect(fetchMock).toHaveBeenCalledTimes(callsBeforeMintCompletion)
    expect(downstream).not.toHaveBeenCalled()
    expect(service.getCachedUserId()).toBe(secondUser.id)
  })

  it('rejects an in-flight RPC mint from A after logout and a fresh B login', async () => {
    let resolveMint!: (response: Response) => void
    const mintPending = new Promise<Response>(resolve => {
      resolveMint = resolve
    })
    const firstToken = sessionToken('rpc-env-user-a')
    const secondUser = { ...me, id: 'rpc-env-user-b', email: 'environment-b@example.test' }
    const secondToken = sessionToken(secondUser.id)
    let loginNumber = 0
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/api/v1/auth/v2/password-login')) {
        loginNumber += 1
        return Promise.resolve(
          credentialResponse(
            loginNumber === 1 ? firstToken : secondToken,
            loginNumber === 1 ? me : secondUser
          )
        )
      }
      if (url.endsWith('/api/v1/me')) {
        const authorization = new Headers(init?.headers).get('authorization')
        return Promise.resolve(
          meResponse(authorization === `Bearer ${secondToken}` ? secondUser : me)
        )
      }
      if (url.endsWith('/api/v1/rpc/token')) return mintPending
      if (url.endsWith('/api/v1/sandbox-ui/apps'))
        return Promise.resolve(
          new Response(JSON.stringify({ apps: [] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        )
      return Promise.reject(new Error(`unexpected HTTP request: ${url}`))
    })
    vi.stubGlobal('fetch', fetchMock)

    const config = await import('../config.js')
    await config.saveDesktopRuntimeConfig({
      externalRestApiBaseUrl: 'http://rest.rpc-lease.test',
      rpcProxyBaseUrl: 'http://proxy.rpc-lease.test',
      appName: 'Environment A',
    })
    const service = createService()
    vi.spyOn(service as any, 'resolveRuntimeConfigIfNeeded').mockResolvedValue(undefined)
    const credentials = new Map<string, string>()
    keytar.getPassword.mockImplementation(
      async (service, account) => credentials.get(`${service}::${account}`) ?? null
    )
    keytar.setPassword.mockImplementation(async (service, account, value) => {
      credentials.set(`${service}::${account}`, value)
    })
    keytar.deletePassword.mockImplementation(async (service, account) =>
      credentials.delete(`${service}::${account}`)
    )
    const firstLogin = await service.passwordLogin('rpc-lease@example.test', 'first-password')
    expect(firstLogin).toMatchObject({ authenticated: true })
    const firstEnvKey = config.getActiveEnvKey()
    const { readSessionAuthoritySourceSelection } = await import('../sessionAuthorityAcceptance.js')
    await expect(
      (service as any).sessionAuthority.getProfileSelectedEnvironmentKey()
    ).resolves.toBe(firstEnvKey)
    expect(
      await readSessionAuthoritySourceSelection({
        tokenStore: new TokenStore(),
        envKey: firstEnvKey,
      })
    ).toMatchObject({
      status: 'accepted',
      session: { accepted: { record: { frame: { mode: 'persistent' } } } },
    })
    const rpcClient = (service as any).rpcClient
    const downstream = vi.spyOn(rpcClient, 'listSandboxUiApps')
    const operation = service.listSandboxUiApps().then(
      value => ({ value }),
      error => ({ error })
    )
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3))
    expect(config.getActiveEnvKey()).toBe(firstEnvKey)
    await expect(
      (service as any).sessionAuthority.inspectAcceptedSessionRestore(firstEnvKey)
    ).resolves.toMatchObject({ status: 'accepted' })

    const logout = await service.logout()
    if (logout.kind !== 'committed') throw new Error('environment A logout did not commit')
    await service.saveRuntimeConfig(
      {
        externalRestApiBaseUrl: 'http://rest.rpc-lease-b.test',
        rpcProxyBaseUrl: 'http://proxy.rpc-lease-b.test',
        appName: 'Environment B',
      },
      logout.sessionGeneration
    )
    expect(config.getActiveEnvKey()).not.toBe(firstEnvKey)
    await service.passwordLogin('environment-b@example.test', 'second-password')
    expect(service.getCachedUserId()).toBe(secondUser.id)

    const callsBeforeMintCompletion = fetchMock.mock.calls.length
    resolveMint(rpcTokenResponse('late-environment-a-rpc-credential'))

    await expect(operation).resolves.toHaveProperty('error')
    expect(fetchMock).toHaveBeenCalledTimes(callsBeforeMintCompletion)
    expect(downstream).not.toHaveBeenCalled()
    expect(service.getCachedUserId()).toBe(secondUser.id)
  })
})
