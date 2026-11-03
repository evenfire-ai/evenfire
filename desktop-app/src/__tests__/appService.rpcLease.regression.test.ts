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
const electronIpc = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}))

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: vi.fn(() => null), getAllWindows: vi.fn(() => []) },
  Notification: Object.assign(vi.fn(), { isSupported: vi.fn(() => false) }),
  app: { getPath: vi.fn(() => fixture.directory), isReady: vi.fn(() => true) },
  safeStorage: { isEncryptionAvailable: vi.fn(() => false) },
  shell: { openExternal: vi.fn() },
  clipboard: { writeText: vi.fn() },
  dialog: { showSaveDialog: vi.fn() },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      electronIpc.handlers.set(channel, handler)
    }),
    on: vi.fn(),
    removeHandler: vi.fn(),
  },
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
  let requestJson: typeof import('../httpClient.js').requestJson
  let runWithSessionRequestContext: typeof import('../httpClient.js').runWithSessionRequestContext

  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    electronIpc.handlers.clear()
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
    requestJson = httpModule.requestJson
    runWithSessionRequestContext = httpModule.runWithSessionRequestContext
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

  it('rejects a persistent session bearer held before logout at the final HTTP dispatch guard', async () => {
    const firstToken = sessionToken('rpc-lease-user-a')
    const secondUser = { ...me, id: 'rpc-lease-user-b', email: 'new@example.test' }
    const secondToken = firstToken
    let loginNumber = 0
    let meReadNumber = 0
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/api/v1/auth/v2/password-login')) {
        loginNumber += 1
        return credentialResponse(
          loginNumber === 1 ? firstToken : secondToken,
          loginNumber === 1 ? me : secondUser
        )
      }
      if (url.endsWith('/api/v1/me')) {
        meReadNumber += 1
        return meResponse(meReadNumber === 1 ? me : secondUser)
      }
      if (url.endsWith('/api/v1/me/agents'))
        return new Response(JSON.stringify({ agents: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
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
    await expect(service.passwordLogin(me.email, 'first-password')).resolves.toMatchObject({
      authenticated: true,
    })

    const entered = deferred<string>()
    const release = deferred<void>()
    const authClient = (service as any).authClient
    const getMyAgents = authClient.getMyAgents.bind(authClient)
    vi.spyOn(authClient, 'getMyAgents').mockImplementation(async (token: string) => {
      if (token === firstToken) {
        entered.resolve(token)
        await release.promise
      }
      return getMyAgents(token)
    })
    const pendingA = service.listMyAgents()
    await expect(entered.promise).resolves.toBe(firstToken)

    const logout = await service.logout()
    if (logout.kind !== 'committed') throw new Error('session A logout did not commit')
    await expect(service.passwordLogin(secondUser.email, 'second-password')).resolves.toMatchObject(
      {
        authenticated: true,
      }
    )
    const callsBeforeRelease = fetchMock.mock.calls.length
    release.resolve()

    await expect(pendingA).rejects.toThrow(
      'The credential is not owned by the current authenticated session'
    )
    expect(fetchMock).toHaveBeenCalledTimes(callsBeforeRelease)
    expect(service.getCachedUserId()).toBe(secondUser.id)
    await expect(service.listMyAgents()).resolves.toEqual([])
    expect(String(fetchMock.mock.calls.at(-1)?.[0])).toContain('/api/v1/me/agents')
    expect(new Headers(fetchMock.mock.calls.at(-1)?.[1]?.headers).get('authorization')).toBe(
      `Bearer ${secondToken}`
    )
  })

  it('rejects a persistent bearer without its captured owner at the final HTTP dispatch guard', async () => {
    const token = sessionToken('rpc-lease-user-a')
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/api/v1/auth/v2/password-login')) return credentialResponse(token)
      if (url.endsWith('/api/v1/me')) return meResponse()
      return Promise.reject(new Error(`unexpected HTTP request: ${url}`))
    })
    vi.stubGlobal('fetch', fetchMock)

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
    await expect(service.passwordLogin(me.email, 'fixture-password')).resolves.toMatchObject({
      authenticated: true,
    })

    const callsBeforeDispatch = fetchMock.mock.calls.length
    await expect(
      runWithSessionRequestContext(undefined, () =>
        requestJson('GET', 'http://rest.rpc-lease.test/api/v1/me', { token })
      )
    ).rejects.toThrow('The credential is not owned by the current authenticated session')
    expect(fetchMock).toHaveBeenCalledTimes(callsBeforeDispatch)
  })

  it('rejects a persistent derived RPC bearer held before logout and keeps session B usable', async () => {
    const firstToken = sessionToken('rpc-lease-user-a')
    const secondUser = { ...me, id: 'rpc-lease-user-b', email: 'new@example.test' }
    const secondToken = firstToken
    let loginNumber = 0
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/api/v1/auth/v2/password-login')) {
        loginNumber += 1
        return credentialResponse(
          loginNumber === 1 ? firstToken : secondToken,
          loginNumber === 1 ? me : secondUser
        )
      }
      if (url.endsWith('/api/v1/me')) {
        return meResponse(url.includes('rest.rpc-lease-b.test') ? secondUser : me)
      }
      if (url.endsWith('/api/v1/rpc/token')) return rpcTokenResponse('derived-rpc-bearer-shared')
      if (url.endsWith('/api/v1/sandbox-ui/apps'))
        return new Response(JSON.stringify({ apps: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
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
    await expect(service.passwordLogin(me.email, 'first-password')).resolves.toMatchObject({
      authenticated: true,
    })

    const entered = deferred<string>()
    const release = deferred<void>()
    let heldA = false
    const rpcClient = (service as any).rpcClient
    const listSandboxUiApps = rpcClient.listSandboxUiApps.bind(rpcClient)
    vi.spyOn(rpcClient, 'listSandboxUiApps').mockImplementation(async (token: string) => {
      if (token === 'derived-rpc-bearer-shared' && !heldA) {
        heldA = true
        entered.resolve(token)
        await release.promise
      }
      return listSandboxUiApps(token)
    })
    const pendingA = service.listSandboxUiApps()
    await expect(entered.promise).resolves.toBe('derived-rpc-bearer-shared')

    const logout = await service.logout()
    if (logout.kind !== 'committed') throw new Error('session A logout did not commit')
    await service.saveRuntimeConfig(
      {
        externalRestApiBaseUrl: 'http://rest.rpc-lease-b.test',
        rpcProxyBaseUrl: 'http://proxy.rpc-lease-b.test',
        appName: 'Environment B',
      },
      logout.sessionGeneration
    )
    await expect(service.passwordLogin(secondUser.email, 'second-password')).resolves.toMatchObject(
      {
        authenticated: true,
      }
    )
    await expect(service.listSandboxUiApps()).resolves.toEqual({ apps: [] })
    expect(fetchMock.mock.calls.at(-1)?.[0]).toMatch('proxy.rpc-lease-b.test')
    expect(new Headers(fetchMock.mock.calls.at(-1)?.[1]?.headers).get('authorization')).toBe(
      'Bearer derived-rpc-bearer-shared' // PUBLIC_SYNTHETIC_BEARER_FIXTURE
    )
    const callsBeforeRelease = fetchMock.mock.calls.length
    release.resolve()

    await expect(pendingA).rejects.toThrow(
      'The credential is not owned by the current authenticated session'
    )
    expect(fetchMock).toHaveBeenCalledTimes(callsBeforeRelease)
    expect(service.getCachedUserId()).toBe(secondUser.id)
    await expect(service.listSandboxUiApps()).resolves.toEqual({ apps: [] })
    expect(new Headers(fetchMock.mock.calls.at(-1)?.[1]?.headers).get('authorization')).toBe(
      'Bearer derived-rpc-bearer-shared' // PUBLIC_SYNTHETIC_BEARER_FIXTURE
    )
  })

  it('rejects distinct stale A RPC bearer through the public operation after B is accepted', async () => {
    const firstToken = sessionToken('rpc-lease-user-a')
    const secondUser = { ...me, id: 'rpc-lease-user-b', email: 'new@example.test' }
    const secondToken = sessionToken(secondUser.id)
    const rpcTokenA = 'derived-rpc-bearer-owner-a' // PUBLIC_SYNTHETIC_BEARER_FIXTURE
    const rpcTokenB = 'derived-rpc-bearer-owner-b' // PUBLIC_SYNTHETIC_BEARER_FIXTURE
    let loginNumber = 0
    const dispatchedAuthorization: Array<string | null> = []
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/api/v1/auth/v2/password-login')) {
        loginNumber += 1
        return credentialResponse(
          loginNumber === 1 ? firstToken : secondToken,
          loginNumber === 1 ? me : secondUser
        )
      }
      if (url.endsWith('/api/v1/me')) {
        return meResponse(url.includes('rest.rpc-lease-b.test') ? secondUser : me)
      }
      if (url.endsWith('/api/v1/rpc/token'))
        return rpcTokenResponse(loginNumber === 1 ? rpcTokenA : rpcTokenB)
      if (url.endsWith('/api/v1/sandbox-ui/apps')) {
        dispatchedAuthorization.push(new Headers(init?.headers).get('authorization'))
        return new Response(JSON.stringify({ apps: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
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
    await expect(service.passwordLogin(me.email, 'first-password')).resolves.toMatchObject({
      authenticated: true,
    })

    const entered = deferred<string>()
    const release = deferred<void>()
    const rpcClient = (service as any).rpcClient
    const listSandboxUiApps = rpcClient.listSandboxUiApps.bind(rpcClient)
    vi.spyOn(rpcClient, 'listSandboxUiApps').mockImplementation(async (token: string) => {
      if (token === rpcTokenA) {
        entered.resolve(token)
        await release.promise
      }
      return listSandboxUiApps(token)
    })

    // The public AppService operation has already captured A's distinct derived RPC bearer.
    const pendingA = service.listSandboxUiApps()
    await expect(entered.promise).resolves.toBe(rpcTokenA)

    const logout = await service.logout()
    if (logout.kind !== 'committed') throw new Error('session A logout did not commit')
    await service.saveRuntimeConfig(
      {
        externalRestApiBaseUrl: 'http://rest.rpc-lease-b.test',
        rpcProxyBaseUrl: 'http://proxy.rpc-lease-b.test',
        appName: 'Environment B',
      },
      logout.sessionGeneration
    )
    await expect(service.passwordLogin(secondUser.email, 'second-password')).resolves.toMatchObject(
      {
        authenticated: true,
      }
    )
    await expect(service.listSandboxUiApps()).resolves.toEqual({ apps: [] })
    expect(dispatchedAuthorization).toEqual([`Bearer ${rpcTokenB}`])

    const callsBeforeRelease = fetchMock.mock.calls.length
    release.resolve()
    await expect(pendingA).rejects.toThrow(
      'The credential is not owned by the current authenticated session'
    )
    expect(fetchMock).toHaveBeenCalledTimes(callsBeforeRelease)
    expect(dispatchedAuthorization).toEqual([`Bearer ${rpcTokenB}`])
    expect(service.getCachedUserId()).toBe(secondUser.id)
    await expect(service.listSandboxUiApps()).resolves.toEqual({ apps: [] })
    expect(dispatchedAuthorization.at(-1)).toBe(`Bearer ${rpcTokenB}`)
  })

  it('rejects a persistent GFS stream bearer held before logout at the fetch dispatch boundary', async () => {
    const firstToken = sessionToken('rpc-lease-user-a')
    const firstUser = { ...me, id: 'rpc-lease-user-a', email: 'first@example.test' }
    const secondUser = { ...me, id: 'rpc-lease-user-b', email: 'new@example.test' }
    const secondToken = sessionToken(secondUser.id)
    let loginNumber = 0
    const proxyCalls: Array<{ url: string; authorization: string | null }> = []
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/api/v1/auth/v2/password-login')) {
        loginNumber += 1
        return credentialResponse(
          loginNumber === 1 ? firstToken : secondToken,
          loginNumber === 1 ? firstUser : secondUser
        )
      }
      if (url.endsWith('/api/v1/me')) return meResponse(loginNumber === 1 ? firstUser : secondUser)
      if (url.includes('/api/v1/me/gfs/resolve?uri=')) {
        return new Response(
          JSON.stringify({
            ok: true,
            data: {
              drive: 'main',
              resourceId: 'resource-1',
              parentResourceId: null,
              gfsUri: 'gfs://main/resource-1',
              name: 'file.bin',
              kind: 'file',
              version: 1,
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      }
      if (url.includes('/api/v1/me/gfs/proxy/')) {
        proxyCalls.push({
          url,
          authorization: new Headers(init?.headers).get('authorization'),
        })
        return new Response(new Uint8Array([1, 2, 3]), { status: 200 })
      }
      return Promise.reject(new Error(`unexpected HTTP request: ${url}`))
    })
    vi.stubGlobal('fetch', fetchMock)

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
    await expect(service.passwordLogin(firstUser.email, 'first-password')).resolves.toMatchObject({
      authenticated: true,
    })
    const { readSessionAuthoritySourceSelection } = await import('../sessionAuthorityAcceptance.js')
    const envKey = await (service as any).sessionAuthority.getProfileSelectedEnvironmentKey()
    await expect(
      readSessionAuthoritySourceSelection({ tokenStore: new TokenStore(), envKey })
    ).resolves.toMatchObject({
      status: 'accepted',
      session: {
        accepted: { record: { frame: { mode: 'persistent', source: { kind: 'keytar' } } } },
      },
    })

    const entered = deferred<string>()
    const release = deferred<void>()
    const transport = (service as any).gfsClient.transport as {
      fetchByteStream: (
        url: string,
        token: string,
        opts: { maxBytes: number; signal?: AbortSignal },
        onChunk: (chunk: Uint8Array) => Promise<void>
      ) => Promise<number>
    }
    const fetchByteStream = transport.fetchByteStream.bind(transport)
    let heldA = false
    transport.fetchByteStream = async (url, token, opts, onChunk) => {
      if (token === firstToken && !heldA) {
        heldA = true
        entered.resolve(token)
        await release.promise
      }
      return fetchByteStream(url, token, opts, onChunk)
    }

    const pendingA = service.downloadGfsUriInto(
      'gfs://main/resource-1',
      1024,
      undefined,
      async () => {}
    )
    await expect(entered.promise).resolves.toBe(firstToken)
    expect(proxyCalls).toHaveLength(0)

    const logout = await service.logout()
    if (logout.kind !== 'committed') throw new Error('session A logout did not commit')
    await expect(service.passwordLogin(secondUser.email, 'second-password')).resolves.toMatchObject(
      {
        authenticated: true,
      }
    )
    const bytesB: Uint8Array[] = []
    await expect(
      service.downloadGfsUriInto('gfs://main/resource-1', 1024, undefined, async chunk => {
        bytesB.push(chunk)
      })
    ).resolves.toMatchObject({ bytes: 3 })
    expect(bytesB).toHaveLength(1)
    expect(proxyCalls).toHaveLength(1)
    expect(proxyCalls[0]?.authorization).toBe(`Bearer ${secondToken}`)

    const callsBeforeRelease = fetchMock.mock.calls.length
    release.resolve()
    await expect(pendingA).rejects.toThrow(
      'The credential is not owned by the current authenticated session'
    )
    expect(fetchMock).toHaveBeenCalledTimes(callsBeforeRelease)
    expect(proxyCalls).toHaveLength(1)
    expect(service.getCachedUserId()).toBe(secondUser.id)
  })

  it('rejects a queued ZIP GFS append admitted under A after logout before B can dispatch it', async () => {
    const firstUser = { ...me, id: 'rpc-lease-user-a', email: 'first@example.test' }
    const firstToken = sessionToken(firstUser.id)
    const secondUser = { ...me, id: 'rpc-lease-user-b', email: 'new@example.test' }
    const secondToken = sessionToken(secondUser.id)
    let loginNumber = 0
    const proxyCalls: string[] = []
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/api/v1/auth/v2/password-login')) {
        loginNumber += 1
        return credentialResponse(
          loginNumber === 1 ? firstToken : secondToken,
          loginNumber === 1 ? firstUser : secondUser
        )
      }
      if (url.endsWith('/api/v1/me')) {
        const authorization = new Headers(init?.headers).get('authorization')
        return meResponse(authorization === `Bearer ${secondToken}` ? secondUser : firstUser)
      }
      if (url.includes('/api/v1/me/gfs/resolve?uri=')) {
        return new Response(
          JSON.stringify({
            ok: true,
            data: {
              drive: 'main',
              resourceId: 'resource-1',
              parentResourceId: null,
              gfsUri: 'gfs://main/resource-1',
              name: 'file.bin',
              kind: 'file',
              version: 1,
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      }
      if (url.includes('/api/v1/me/gfs/proxy/')) {
        proxyCalls.push(new Headers(init?.headers).get('authorization') ?? '')
        return new Response(new Uint8Array([1, 2, 3]), { status: 200 })
      }
      return Promise.reject(new Error(`unexpected HTTP request: ${url}`))
    })
    vi.stubGlobal('fetch', fetchMock)

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
    await expect(service.passwordLogin(firstUser.email, 'first-password')).resolves.toMatchObject({
      authenticated: true,
    })

    const { registerIpcHandlers } = await import('../ipc.js')
    registerIpcHandlers(service as any)
    const event = { senderFrame: { url: 'file:///app/index.html' }, sender: { id: 7 } }
    const startHandler = electronIpc.handlers.get('gfs:zipStream:start')
    const appendHandler = electronIpc.handlers.get('gfs:zipStream:appendFromUri')
    const abortHandler = electronIpc.handlers.get('gfs:zipStream:abort')
    if (!startHandler || !appendHandler || !abortHandler) {
      throw new Error('ZIP stream IPC handlers were not registered')
    }
    const { jobId } = (await startHandler(event, {})) as { jobId: string }

    const entered = deferred<string>()
    const release = deferred<void>()
    const transport = (service as any).gfsClient.transport as {
      fetchByteStream: (
        url: string,
        token: string,
        opts: { maxBytes: number; signal?: AbortSignal },
        onChunk: (chunk: Uint8Array) => Promise<void>
      ) => Promise<number>
    }
    const fetchByteStream = transport.fetchByteStream.bind(transport)
    let heldA = false
    transport.fetchByteStream = async (url, token, opts, onChunk) => {
      if (token === firstToken && !heldA) {
        heldA = true
        entered.resolve(token)
        await release.promise
      }
      return fetchByteStream(url, token, opts, onChunk)
    }

    try {
      const firstAppend = appendHandler(event, {
        jobId,
        name: 'Docs/first.bin',
        uri: 'gfs://main/first',
        maxBytes: 1024,
      })
      await expect(entered.promise).resolves.toBe(firstToken)
      const queuedAppend = appendHandler(event, {
        jobId,
        name: 'Docs/queued.bin',
        uri: 'gfs://main/queued',
        maxBytes: 1024,
      })
      expect(proxyCalls).toHaveLength(0)

      const logout = await service.logout()
      if (logout.kind !== 'committed') throw new Error('session A logout did not commit')
      await expect(
        service.passwordLogin(secondUser.email, 'second-password')
      ).resolves.toMatchObject({ authenticated: true })
      await expect(
        service.downloadGfsUriInto('gfs://main/resource-1', 1024, undefined, async () => {})
      ).resolves.toMatchObject({ bytes: 3 })
      expect(proxyCalls).toEqual([`Bearer ${secondToken}`])

      const callsBeforeRelease = fetchMock.mock.calls.length
      release.resolve()
      await expect(firstAppend).rejects.toThrow(
        'The credential is not owned by the current authenticated session'
      )
      await expect(queuedAppend).rejects.toThrow(
        'The credential is not owned by the current authenticated session'
      )
      expect(fetchMock).toHaveBeenCalledTimes(callsBeforeRelease)
      expect(proxyCalls).toEqual([`Bearer ${secondToken}`])
      expect(service.getCachedUserId()).toBe(secondUser.id)
    } finally {
      release.resolve()
      await Promise.resolve(abortHandler(event, { jobId })).catch(() => undefined)
      await service.logout().catch(() => undefined)
    }
  })

  it('rejects invokeHostMessage from A held before dispatch after logout and a fresh B login', async () => {
    const firstToken = sessionToken('rpc-lease-user-a')
    const secondUser = { ...me, id: 'rpc-lease-user-b', email: 'new@example.test' }
    const secondToken = sessionToken(secondUser.id)
    let loginNumber = 0
    let meReadNumber = 0
    let rpcTokenCount = 0
    let messageDispatchCount = 0
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
        meReadNumber += 1
        return Promise.resolve(meResponse(meReadNumber === 1 ? me : secondUser))
      }
      if (url.endsWith('/api/v1/rpc/token')) {
        rpcTokenCount += 1
        const body = JSON.parse(String(init?.body || '{}')) as {
          scopes?: string[]
          hostRefs?: string[]
        }
        return Promise.resolve(
          rpcTokenResponse(
            'derived-rpc-bearer-shared',
            body.scopes,
            body.hostRefs,
            secondUser.teamId
          )
        )
      }
      if (url.includes('/api/v1/rpc/hosts/') && url.endsWith('/messages')) {
        messageDispatchCount += 1
        return Promise.resolve(
          new Response(JSON.stringify({ success: true, response: 'ok' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        )
      }
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
    await expect(service.passwordLogin(me.email, 'first-password')).resolves.toMatchObject({
      authenticated: true,
    })

    const entered = deferred<string>()
    const release = deferred<void>()
    let heldA = false
    const rpcClient = (service as any).rpcClient
    const invokeHostMessage = rpcClient.invokeHostMessage.bind(rpcClient)
    vi.spyOn(rpcClient, 'invokeHostMessage').mockImplementation(
      async (token: string, ...args: unknown[]) => {
        if (token === 'derived-rpc-bearer-shared' && !heldA) {
          heldA = true
          entered.resolve(token)
          await release.promise
        }
        return invokeHostMessage(token, ...(args as [string, any, { async?: boolean }?]))
      }
    )
    const pendingA = service.invokeHostMessage('chatllm', { content: 'A' }, ['chatllm'])
    await expect(entered.promise).resolves.toBe('derived-rpc-bearer-shared')

    const logout = await service.logout()
    if (logout.kind !== 'committed') throw new Error('session A logout did not commit')
    await expect(service.passwordLogin(secondUser.email, 'second-password')).resolves.toMatchObject(
      {
        authenticated: true,
      }
    )
    await expect(
      service.invokeHostMessage('chatllm', { content: 'B' }, ['chatllm'])
    ).resolves.toMatchObject({ success: true })
    expect(messageDispatchCount).toBe(1)
    const callsBeforeRelease = fetchMock.mock.calls.length
    release.resolve()

    await expect(pendingA).rejects.toThrow(
      'The credential is not owned by the current authenticated session'
    )
    expect(fetchMock).toHaveBeenCalledTimes(callsBeforeRelease)
    expect(messageDispatchCount).toBe(1)
    expect(rpcTokenCount).toBe(2)
    expect(service.getCachedUserId()).toBe(secondUser.id)
    await expect(
      service.invokeHostMessage('chatllm', { content: 'B again' }, ['chatllm'])
    ).resolves.toMatchObject({ success: true })
    expect(service.getCachedUserId()).toBe(secondUser.id)
  })

  it('does not refresh or redispatch a delayed A RPC 401 after B is accepted', async () => {
    const firstToken = sessionToken('rpc-lease-user-a')
    const secondUser = { ...me, id: 'rpc-lease-user-b', email: 'new@example.test' }
    const secondToken = sessionToken(secondUser.id)
    const firstResponse = deferred<Response>()
    let loginNumber = 0
    let meReadNumber = 0
    let rpcTokenCount = 0
    let messageDispatchCount = 0
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
        meReadNumber += 1
        return Promise.resolve(meResponse(meReadNumber === 1 ? me : secondUser))
      }
      if (url.endsWith('/api/v1/rpc/token')) {
        rpcTokenCount += 1
        const body = JSON.parse(String(init?.body || '{}')) as {
          scopes?: string[]
          hostRefs?: string[]
        }
        return Promise.resolve(
          rpcTokenResponse(
            'derived-rpc-bearer-shared',
            body.scopes,
            body.hostRefs,
            secondUser.teamId
          )
        )
      }
      if (url.includes('/api/v1/rpc/hosts/') && url.endsWith('/messages')) {
        messageDispatchCount += 1
        return messageDispatchCount === 1
          ? firstResponse.promise
          : Promise.resolve(
              new Response(JSON.stringify({ success: true, response: 'ok' }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
              })
            )
      }
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
    await expect(service.passwordLogin(me.email, 'first-password')).resolves.toMatchObject({
      authenticated: true,
    })

    const pendingA = service.invokeHostMessage('chatllm', { content: 'A' }, ['chatllm'])
    await vi.waitFor(() => expect(messageDispatchCount).toBe(1))
    const logout = await service.logout()
    if (logout.kind !== 'committed') throw new Error('session A logout did not commit')
    await expect(service.passwordLogin(secondUser.email, 'second-password')).resolves.toMatchObject(
      {
        authenticated: true,
      }
    )
    await expect(
      service.invokeHostMessage('chatllm', { content: 'B' }, ['chatllm'])
    ).resolves.toMatchObject({ success: true })
    expect(rpcTokenCount).toBe(2)
    const callsBefore401 = fetchMock.mock.calls.length
    firstResponse.resolve(new Response('unauthorized', { status: 401 }))

    await expect(pendingA).rejects.toThrow(
      'The credential is not owned by the current authenticated session'
    )
    expect(fetchMock).toHaveBeenCalledTimes(callsBefore401)
    expect(rpcTokenCount).toBe(2)
    expect(messageDispatchCount).toBe(2)
    expect(service.getCachedUserId()).toBe(secondUser.id)
    await expect(
      service.invokeHostMessage('chatllm', { content: 'B again' }, ['chatllm'])
    ).resolves.toMatchObject({ success: true })
    expect(service.getCachedUserId()).toBe(secondUser.id)
  })

  it('rejects a late public openDesktop session exchange after logout and session replacement', async () => {
    const firstToken = sessionToken('rpc-lease-user-a')
    const secondUser = { ...me, id: 'rpc-lease-user-b', email: 'new@example.test' }
    const secondToken = sessionToken(secondUser.id)
    let loginNumber = 0
    let meReadNumber = 0
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
        meReadNumber += 1
        return Promise.resolve(meResponse(meReadNumber === 1 ? me : secondUser))
      }
      if (url.endsWith('/api/v1/rpc/token')) {
        const body = JSON.parse(String(init?.body || '{}')) as {
          scopes?: string[]
          hostRefs?: string[]
        }
        return Promise.resolve(
          rpcTokenResponse('desktop-rpc-bearer', body.scopes, body.hostRefs, me.teamId)
        )
      }
      if (url.endsWith('/api/v1/me/agents'))
        return Promise.resolve(
          new Response(JSON.stringify({ agents: [] }), {
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
    await expect(service.passwordLogin(me.email, 'first-password')).resolves.toMatchObject({
      authenticated: true,
    })

    const entered = deferred<{
      assertRequestOwnerCurrent?: () => void
    }>()
    const release = deferred<void>()
    const publishWindow = vi.fn()
    const closeAllDesktopWindows = vi.fn().mockResolvedValue(undefined)
    const openDesktopWindow = vi.fn(async (args: { assertRequestOwnerCurrent?: () => void }) => {
      entered.resolve(args)
      await release.promise
      args.assertRequestOwnerCurrent?.()
      publishWindow()
    })
    vi.doMock('../desktopWindow.js', () => ({ openDesktopWindow, closeAllDesktopWindows }))
    let pendingAError: unknown
    const pendingA = service.openDesktop('chatllm').then(
      () => undefined,
      error => {
        pendingAError = error
      }
    )
    await entered.promise

    const logout = await service.logout()
    if (logout.kind !== 'committed') throw new Error('session A logout did not commit')
    await expect(service.passwordLogin(secondUser.email, 'second-password')).resolves.toMatchObject(
      {
        authenticated: true,
      }
    )
    await expect(service.listMyAgents()).resolves.toEqual([])
    release.resolve()

    await pendingA
    expect(publishWindow).not.toHaveBeenCalled()
    expect(pendingAError).toMatchObject({
      message: 'The credential is not owned by the current authenticated session',
    })
    expect(closeAllDesktopWindows).toHaveBeenCalledOnce()
    expect(service.getCachedUserId()).toBe(secondUser.id)
    await expect(service.listMyAgents()).resolves.toEqual([])
  })

  it('retires prior Desktop windows before publishing an accepted session replacement', async () => {
    const firstToken = sessionToken('rpc-lease-user-a')
    const secondToken = sessionToken('rpc-lease-user-a-next')
    let loginNumber = 0
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/api/v1/auth/v2/password-login')) {
        loginNumber += 1
        return credentialResponse(loginNumber === 1 ? firstToken : secondToken)
      }
      if (url.endsWith('/api/v1/me')) return meResponse()
      if (url.endsWith('/api/v1/rpc/token')) {
        const body = JSON.parse(String(init?.body || '{}')) as {
          scopes?: string[]
          hostRefs?: string[]
        }
        return rpcTokenResponse('desktop-rpc-bearer', body.scopes, body.hostRefs, me.teamId)
      }
      if (url.endsWith('/api/v1/me/agents'))
        return new Response(JSON.stringify({ agents: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
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
    await expect(service.passwordLogin(me.email, 'first-password')).resolves.toMatchObject({
      authenticated: true,
    })

    let openWindowOwner: unknown
    let retiredWindowOwner: unknown
    let tokenAtRetirement: string | null | undefined
    const openDesktopWindow = vi.fn(async (args: { requestOwnerContext?: unknown }) => {
      openWindowOwner = args.requestOwnerContext
    })
    const closeAllDesktopWindows = vi.fn(async () => {
      retiredWindowOwner = openWindowOwner
      tokenAtRetirement = (service as any).sessionToken
      openWindowOwner = undefined
    })
    vi.doMock('../desktopWindow.js', () => ({ openDesktopWindow, closeAllDesktopWindows }))

    await service.openDesktop('chatllm')
    expect(openDesktopWindow).toHaveBeenCalledOnce()
    const priorGeneration = (service as any).sessionGeneration

    await expect(service.passwordLogin(me.email, 'second-password')).resolves.toMatchObject({
      authenticated: true,
    })

    expect(closeAllDesktopWindows).toHaveBeenCalledOnce()
    expect(retiredWindowOwner).toBeDefined()
    expect(openWindowOwner).toBeUndefined()
    expect(tokenAtRetirement).toBe(firstToken)
    expect((service as any).sessionToken).toBe(secondToken)
    expect((service as any).sessionGeneration).toBeGreaterThan(priorGeneration)
    await expect(service.listMyAgents()).resolves.toEqual([])
    expect(new Headers(fetchMock.mock.calls.at(-1)?.[1]?.headers).get('authorization')).toBe(
      `Bearer ${secondToken}`
    )
  })

  it('keeps session B usable when an already-dispatched session A request returns 401', async () => {
    const firstToken = sessionToken('rpc-lease-user-a')
    const secondUser = { ...me, id: 'rpc-lease-user-b', email: 'new@example.test' }
    const secondToken = sessionToken(secondUser.id)
    const firstAgentResponse = deferred<Response>()
    let loginNumber = 0
    let agentRequestCount = 0
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
      if (url.endsWith('/api/v1/me/agents')) {
        agentRequestCount += 1
        if (agentRequestCount === 1) return firstAgentResponse.promise
        return Promise.resolve(
          new Response(JSON.stringify({ agents: [] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        )
      }
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
    await expect(service.passwordLogin(me.email, 'first-password')).resolves.toMatchObject({
      authenticated: true,
    })

    const pendingA = service.listMyAgents()
    await vi.waitFor(() => expect(agentRequestCount).toBe(1))
    const logout = await service.logout()
    if (logout.kind !== 'committed') throw new Error('session A logout did not commit')
    await expect(service.passwordLogin(secondUser.email, 'second-password')).resolves.toMatchObject(
      {
        authenticated: true,
      }
    )
    firstAgentResponse.resolve(new Response('unauthorized', { status: 401 }))

    await expect(pendingA).rejects.toMatchObject({ status: 401 })
    expect(service.getCachedUserId()).toBe(secondUser.id)
    await expect(service.listMyAgents()).resolves.toEqual([])
    expect(agentRequestCount).toBe(2)
    expect(new Headers(fetchMock.mock.calls.at(-1)?.[1]?.headers).get('authorization')).toBe(
      `Bearer ${secondToken}`
    )
  })

  it('does not retry a dispatched session A request after logout and session B acceptance', async () => {
    const firstToken = sessionToken('rpc-lease-user-a')
    const secondUser = { ...me, id: 'rpc-lease-user-b', email: 'new@example.test' }
    const secondToken = sessionToken(secondUser.id)
    const firstHealthResponse = deferred<Response>()
    let loginNumber = 0
    let healthRequestCount = 0
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
      if (url.endsWith('/api/v1/workflows/example/workflow/health')) {
        healthRequestCount += 1
        return firstHealthResponse.promise
      }
      if (url.endsWith('/api/v1/me/agents'))
        return Promise.resolve(
          new Response(JSON.stringify({ agents: [] }), {
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
    await expect(service.passwordLogin(me.email, 'first-password')).resolves.toMatchObject({
      authenticated: true,
    })

    const pendingRetryA = service.getWorkflowHealth('example', 'workflow')
    await vi.waitFor(() => expect(healthRequestCount).toBe(1))
    const logout = await service.logout()
    if (logout.kind !== 'committed') throw new Error('session A logout did not commit')
    await expect(service.passwordLogin(secondUser.email, 'second-password')).resolves.toMatchObject(
      {
        authenticated: true,
      }
    )
    const callsBeforeRetry = fetchMock.mock.calls.length
    firstHealthResponse.reject(new TypeError('fetch failed'))

    await expect(pendingRetryA).rejects.toThrow(
      'The credential is not owned by the current authenticated session'
    )
    expect(fetchMock).toHaveBeenCalledTimes(callsBeforeRetry)
    expect(service.getCachedUserId()).toBe(secondUser.id)
    await expect(service.listMyAgents()).resolves.toEqual([])
  })
})
