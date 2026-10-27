import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const fixture = vi.hoisted(() => ({ directory: '' }))
vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => fixture.directory), isReady: vi.fn(() => true) },
  safeStorage: { isEncryptionAvailable: vi.fn(() => false) },
  shell: { openExternal: vi.fn() },
}))
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

describe('AppService stale session invalidation', () => {
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
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'evenfire-rpc-invalidation-'))
    fixture.directory = directory
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

  function createService() {
    return new AppService({
      tokenStore: new TokenStore({ isolatedUserDataPath: directory }),
      getUserDataDirectory: () => directory,
    })
  }

  it('does not let an old session 401 invalidate its replacement', async () => {
    let resolveProbe!: (response: Response) => void
    const probePending = new Promise<Response>(resolve => {
      resolveProbe = resolve
    })
    const firstToken = sessionToken(firstMe.id)
    const secondToken = sessionToken(secondMe.id)
    let loginNumber = 0
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/api/v1/auth/v2/password-login')) {
        loginNumber += 1
        return Promise.resolve(
          loginNumber === 1
            ? credentialResponse(firstToken, firstMe)
            : credentialResponse(secondToken, secondMe)
        )
      }
      if (url.endsWith('/api/v1/me'))
        return Promise.resolve(
          new Response(JSON.stringify(loginNumber === 1 ? firstMe : secondMe), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        )
      if (url.endsWith('/api/v1/probe')) return probePending
      if (url.endsWith('/api/v1/rpc/token')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              token: 'derived-rpc-credential',
              scopes,
              hostRefs,
              expiresInSeconds: 300,
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )
        )
      }
      return Promise.reject(new Error(`unexpected HTTP request: ${url}`))
    })
    vi.stubGlobal('fetch', fetchMock)

    const service = createService()
    vi.spyOn(service as any, 'resolveRuntimeConfigIfNeeded').mockResolvedValue(undefined)
    await service.passwordLogin(firstMe.email, 'first-password')
    const { requestJson } = await import('../httpClient.js')
    const oldRequest = requestJson('GET', 'http://rest.rpc-lease.test/api/v1/probe', {
      token: firstToken,
    }).then(
      value => ({ value }),
      error => ({ error })
    )
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3))

    await service.passwordLogin(secondMe.email, 'second-password')
    resolveProbe(new Response('unauthorized', { status: 401 }))

    await expect(oldRequest).resolves.toHaveProperty('error')
    expect(service.getCachedUserId()).toBe(secondMe.id)
  })

  it('does not let a stale 401 invalidate a reauthenticated session with the same token', async () => {
    let resolveProbe!: (response: Response) => void
    const probePending = new Promise<Response>(resolve => {
      resolveProbe = resolve
    })
    const accessToken = sessionToken(firstMe.id)
    let loginNumber = 0
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/api/v1/auth/v2/password-login')) {
        loginNumber += 1
        return Promise.resolve(credentialResponse(accessToken, firstMe))
      }
      if (url.endsWith('/api/v1/me'))
        return Promise.resolve(
          new Response(JSON.stringify(firstMe), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        )
      if (url.endsWith('/api/v1/probe')) return probePending
      return Promise.reject(new Error(`unexpected HTTP request: ${url}`))
    })
    vi.stubGlobal('fetch', fetchMock)

    const service = createService()
    vi.spyOn(service as any, 'resolveRuntimeConfigIfNeeded').mockResolvedValue(undefined)
    await service.passwordLogin(firstMe.email, 'first-password')
    const { requestJson } = await import('../httpClient.js')
    const oldRequest = requestJson('GET', 'http://rest.rpc-lease.test/api/v1/probe', {
      token: accessToken,
    }).then(
      value => ({ value }),
      error => ({ error })
    )
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3))

    await service.passwordLogin(firstMe.email, 'reauthenticated-password')
    resolveProbe(new Response('unauthorized', { status: 401 }))

    await expect(oldRequest).resolves.toHaveProperty('error')
    expect(service.getCachedUserId()).toBe(firstMe.id)
    expect((service as any).memoryOnlySession).toBeDefined()
    await service.logout()
  })
})
