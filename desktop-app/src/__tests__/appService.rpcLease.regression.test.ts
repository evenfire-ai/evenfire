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
vi.mock('../chatStoreBinding.js', () => ({
  bindChatStoreForUser: vi.fn(),
  unbindChatStore: vi.fn(),
}))
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
    process.env.EXTERNAL_REST_API_BASE_URL = 'http://rest.rpc-lease.test'
    process.env.RPC_PROXY_BASE_URL = 'http://proxy.rpc-lease.test'
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'evenfire-rpc-lease-'))
    fixture.directory = directory
    keytar.getPassword.mockRejectedValue(new Error('OS credential store unavailable'))
    keytar.setPassword.mockRejectedValue(new Error('OS credential store unavailable'))
    keytar.deletePassword.mockRejectedValue(new Error('OS credential store unavailable'))
    const [appServiceModule, tokenStoreModule, httpModule] = await Promise.all([
      import('../appService.js'),
      import('../tokenStore.js'),
      import('../httpClient.js'),
    ])
    AppService = appServiceModule.AppService
    TokenStore = tokenStoreModule.TokenStore
    setSessionInvalidationHandler = httpModule.setSessionInvalidationHandler
    // Keep the compiler-visible originals for the exact-environment cleanup below.
    ;(fixture as typeof fixture & { oldRest?: string; oldRpc?: string }).oldRest = oldRest
    ;(fixture as typeof fixture & { oldRpc?: string }).oldRpc = oldRpc
  })

  afterEach(async () => {
    setSessionInvalidationHandler?.(undefined)
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    if (directory) await fs.rm(directory, { recursive: true, force: true })
    const env = fixture as typeof fixture & { oldRest?: string; oldRpc?: string }
    if (env.oldRest === undefined) delete process.env.EXTERNAL_REST_API_BASE_URL
    else process.env.EXTERNAL_REST_API_BASE_URL = env.oldRest
    if (env.oldRpc === undefined) delete process.env.RPC_PROXY_BASE_URL
    else process.env.RPC_PROXY_BASE_URL = env.oldRpc
    vi.resetModules()
  })

  function credentialResponse(token: string, user = me) {
    return new Response(JSON.stringify({ token, me: user }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }

  function rpcTokenResponse(token = 'derived-rpc-credential') {
    return new Response(
      JSON.stringify({
        token,
        accessScope: 'team',
        teamId: me.teamId,
        scopes,
        hostRefs,
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
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/api/v1/auth/password-login'))
        return Promise.resolve(credentialResponse(accessToken))
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
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 25 * 60 * 60 * 1000)
    expect(service.checkTemporarySessionExpiry()).toBe(true)
    resolveMint(rpcTokenResponse())

    await expect(mintingOperation).resolves.toHaveProperty('error')
    expect(fetchMock).toHaveBeenCalledTimes(2)
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
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/api/v1/auth/password-login'))
        return Promise.resolve(credentialResponse(accessToken))
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
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))

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
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/api/v1/auth/password-login')) {
        loginNumber += 1
        return Promise.resolve(
          credentialResponse(
            loginNumber === 1 ? firstToken : secondToken,
            loginNumber === 1 ? me : secondUser
          )
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
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))

    await service.passwordLogin('new@example.test', 'second-password')
    const callsBeforeMintCompletion = fetchMock.mock.calls.length
    resolveMint(rpcTokenResponse('late-rpc-credential-from-old-account'))

    await expect(operation).resolves.toHaveProperty('error')
    expect(fetchMock).toHaveBeenCalledTimes(callsBeforeMintCompletion)
    expect(downstream).not.toHaveBeenCalled()
    expect(service.getCachedUserId()).toBe(secondUser.id)
  })
})
