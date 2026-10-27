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

function sessionToken(identity: string): string {
  const payload = Buffer.from(
    JSON.stringify({ sub: identity, exp: Math.floor(Date.now() / 1000) + 60 * 60 })
  ).toString('base64url')
  return `header.${payload}.signature`
}

const firstMe = {
  id: 'rpc-lease-user-a',
  email: 'rpc-lease@example.test',
  name: null,
  picture: null,
  teamId: 'rpc-lease-team',
  teamName: 'RPC lease team',
  role: 'member',
}
const secondMe = { ...firstMe, id: 'rpc-lease-user-b', email: 'new@example.test' }
const scopes = ['sandbox:ui:view']
const hostRefs = ['sandbox-ui']

describe('AppService RPC request authority', () => {
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
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'evenfire-rpc-authority-'))
    fixture.directory = directory
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

  function credentialResponse(token: string, me: typeof firstMe | typeof secondMe) {
    return new Response(JSON.stringify({ token, me }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }

  function meResponse(me: typeof firstMe | typeof secondMe) {
    return new Response(JSON.stringify(me), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }

  function rpcTokenResponse(token: string) {
    return new Response(
      JSON.stringify({
        token,
        accessScope: 'team',
        teamId: firstMe.teamId,
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

  it('allows temporary authentication to use its derived RPC credential over HTTP', async () => {
    const accessToken = sessionToken(firstMe.id)
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/api/v1/auth/v2/password-login'))
        return credentialResponse(accessToken, firstMe)
      if (url.endsWith('/api/v1/me')) return meResponse(firstMe)
      if (url.endsWith('/api/v1/rpc/token')) return rpcTokenResponse('derived-rpc-credential')
      if (url.endsWith('/api/v1/sandbox-ui/apps'))
        return new Response(JSON.stringify({ apps: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      if (url.endsWith('/api/v1/sandbox-ui/test-ns/test-recipe/session'))
        return new Response(null, {
          status: 204,
          headers: { 'set-cookie': 'sandbox_session=opaque; Path=/; HttpOnly' },
        })
      throw new Error(`unexpected HTTP request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const service = createService()
    vi.spyOn(service as any, 'resolveRuntimeConfigIfNeeded').mockResolvedValue(undefined)
    await expect(service.passwordLogin(firstMe.email, 'fixture-password')).resolves.toMatchObject({
      authenticated: true,
      me: firstMe,
      sessionMode: 'temporary',
    })
    await expect(service.listSandboxUiApps()).resolves.toEqual({ apps: [] })
    await expect(service.mintSandboxUiSession('test-ns', 'test-recipe')).resolves.toEqual({
      setCookie: 'sandbox_session=opaque; Path=/; HttpOnly',
    })

    expect(fetchMock).toHaveBeenCalledTimes(5)
    expect(fetchMock.mock.calls[2][1]).toMatchObject({
      method: 'POST',
      headers: expect.objectContaining({ authorization: `Bearer ${accessToken}` }),
    })
    expect(fetchMock.mock.calls[3][1]).toMatchObject({
      headers: expect.objectContaining({ authorization: 'Bearer derived-rpc-credential' }),
    })
  })

  it('rejects an old RPC credential before transport after account replacement', async () => {
    const firstToken = sessionToken(firstMe.id)
    const secondToken = sessionToken(secondMe.id)
    let loginNumber = 0
    let rpcTokenNumber = 0
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/api/v1/auth/v2/password-login')) {
        loginNumber += 1
        return loginNumber === 1
          ? credentialResponse(firstToken, firstMe)
          : credentialResponse(secondToken, secondMe)
      }
      if (url.endsWith('/api/v1/me')) {
        const authorization = new Headers(init?.headers).get('authorization')
        return meResponse(authorization === `Bearer ${secondToken}` ? secondMe : firstMe)
      }
      if (url.endsWith('/api/v1/rpc/token'))
        return rpcTokenResponse(`derived-rpc-credential-${++rpcTokenNumber}`)
      if (url.endsWith('/api/v1/sandbox-ui/apps'))
        return new Response(JSON.stringify({ apps: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      throw new Error(`unexpected HTTP request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const service = createService()
    vi.spyOn(service as any, 'resolveRuntimeConfigIfNeeded').mockResolvedValue(undefined)
    await service.passwordLogin(firstMe.email, 'first-password')
    await service.listSandboxUiApps()
    const appsRequest = fetchMock.mock.calls.find(([input]) =>
      String(input).endsWith('/api/v1/sandbox-ui/apps')
    )
    const authorization = appsRequest?.[1]?.headers as Record<string, string> | undefined
    const staleRpcToken = authorization?.authorization?.replace(/^Bearer /, '')
    expect(staleRpcToken).toBe('derived-rpc-credential-1')

    await service.passwordLogin(secondMe.email, 'second-password')
    const callsBeforeStaleRequest = fetchMock.mock.calls.length
    const rpcClient = (service as any).rpcClient as {
      listSandboxUiApps: (token: string) => Promise<unknown>
    }

    await expect(rpcClient.listSandboxUiApps(staleRpcToken!)).rejects.toThrow(
      'The credential is not owned by the current authenticated session'
    )
    expect(fetchMock).toHaveBeenCalledTimes(callsBeforeStaleRequest)
    expect(service.getCachedUserId()).toBe(secondMe.id)
  })
})
