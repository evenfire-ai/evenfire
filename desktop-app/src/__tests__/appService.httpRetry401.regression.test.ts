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

function sessionToken(): string {
  const payload = Buffer.from(
    JSON.stringify({ sub: 'retry-401-user', exp: Math.floor(Date.now() / 1000) + 60 * 60 })
  ).toString('base64url')
  return `header.${payload}.signature`
}

const me = {
  id: 'retry-401-user',
  email: 'retry-401@example.test',
  name: null,
  picture: null,
  teamId: 'retry-401-team',
  teamName: 'Retry team',
  role: 'member',
}

describe('AppService HTTP retry authorization lifecycle', () => {
  let directory = ''
  let AppService: typeof import('../appService.js').AppService
  let TokenStore: typeof import('../tokenStore.js').TokenStore
  let setSessionInvalidationHandler: typeof import('../httpClient.js').setSessionInvalidationHandler

  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    const oldRest = process.env.EXTERNAL_REST_API_BASE_URL
    const oldRpc = process.env.RPC_PROXY_BASE_URL
    process.env.EXTERNAL_REST_API_BASE_URL = 'http://rest.retry-401.test'
    process.env.RPC_PROXY_BASE_URL = 'http://proxy.retry-401.test'
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'evenfire-retry-401-'))
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
    const oldEnv = fixture as typeof fixture & { oldRest?: string; oldRpc?: string }
    if (oldEnv.oldRest === undefined) delete process.env.EXTERNAL_REST_API_BASE_URL
    else process.env.EXTERNAL_REST_API_BASE_URL = oldEnv.oldRest
    if (oldEnv.oldRpc === undefined) delete process.env.RPC_PROXY_BASE_URL
    else process.env.RPC_PROXY_BASE_URL = oldEnv.oldRpc
    vi.resetModules()
  })

  it('ends only the matching temporary session when a retried request returns 401', async () => {
    const accessToken = sessionToken()
    const transientError = Object.assign(new Error('connection reset'), { code: 'ECONNRESET' })
    let workflowRequestCount = 0
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/api/v1/auth/v2/password-login'))
        return Promise.resolve(
          new Response(JSON.stringify({ token: accessToken, me }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        )
      if (url.endsWith('/api/v1/me'))
        return Promise.resolve(
          new Response(JSON.stringify(me), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        )
      if (url.endsWith('/api/v1/workflows/ns/name/runs')) {
        workflowRequestCount += 1
        if (workflowRequestCount === 1) return Promise.reject(transientError)
        return Promise.resolve(new Response('unauthorized', { status: 401 }))
      }
      return Promise.reject(new Error(`unexpected HTTP request: ${url}`))
    })
    vi.stubGlobal('fetch', fetchMock)

    const notifySessionExpired = vi.fn()
    const service = new AppService({
      tokenStore: new TokenStore({ isolatedUserDataPath: directory }),
      getUserDataDirectory: () => directory,
      notifySessionExpired,
    })
    vi.spyOn(service as any, 'resolveRuntimeConfigIfNeeded').mockResolvedValue(undefined)
    await expect(service.passwordLogin(me.email, 'fixture-password')).resolves.toMatchObject({
      authenticated: true,
      me,
      sessionMode: 'temporary',
    })

    await expect(service.listWorkflowRuns('ns', 'name')).rejects.toMatchObject({ status: 401 })

    expect(workflowRequestCount).toBe(2)
    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(service.getCachedUserId()).toBeNull()
    expect(notifySessionExpired).toHaveBeenCalledOnce()
    await (service as any).memoryOnlySessionTermination
  })
})
