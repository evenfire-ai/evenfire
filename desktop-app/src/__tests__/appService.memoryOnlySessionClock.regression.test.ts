import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const testRuntime = vi.hoisted(() => ({ userDataDirectory: '' }))

vi.mock('keytar', () => ({}))
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => testRuntime.userDataDirectory),
    isReady: vi.fn(() => true),
  },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => false),
    getSelectedStorageBackend: vi.fn(() => 'gnome_libsecret'),
    encryptString: vi.fn((value: string) => Buffer.from(value, 'utf8')),
    decryptString: vi.fn((value: Buffer) => value.toString('utf8')),
  },
}))
vi.mock('../chatStoreBinding.js', async () => {
  const { createChatStoreBindingMock } = await import('../../testSupport/chatStoreBindingMock.js')
  return createChatStoreBindingMock()
})
vi.mock('../pluginSdkRuntime.js', () => ({
  tryGetPluginSdkRuntime: () => ({
    notifySessionChanged: vi.fn(),
    unpinAllSandboxUiSurfaces: vi.fn(),
  }),
}))

const user = {
  id: 'memory-clock-user',
  email: 'memory-clock@example.test',
  name: null,
  picture: null,
  teamId: 'memory-clock-team',
  teamName: 'Clock test',
  role: 'member' as const,
}

const HOUR_MS = 60 * 60 * 1000
const TWELVE_HOURS_MS = 12 * HOUR_MS
const THIRTY_SIX_HOURS_SECONDS = 36 * 60 * 60

let userDataDirectory = ''
let AppServiceClass: typeof import('../appService.js').AppService
let TokenStoreClass: typeof import('../tokenStore.js').TokenStore
let serviceForCleanup: InstanceType<typeof AppServiceClass>[] = []
let wallNow = 0
let monotonicNow = 0

function setClock(): void {
  wallNow = Math.floor(Date.now() / 1000) * 1000
  monotonicNow = 50_000
  vi.spyOn(Date, 'now').mockImplementation(() => wallNow)
  vi.spyOn(performance, 'now').mockImplementation(() => monotonicNow)
}

async function issueControlApiSessionToken(ttlSeconds?: number): Promise<string> {
  // Use the Control API's actual test key setup and RS256 session-token producer.
  const keyNames = [
    'CONTROL_API_RPC_JWT_PRIVATE_KEY',
    'CONTROL_API_SESSION_JWT_PRIVATE_KEY',
    'CONTROL_API_ADMIN_JWT_PRIVATE_KEY',
  ]
  const priorValues = new Map(keyNames.map(name => [name, process.env[name]]))
  try {
    await import('../../../control-api/test/jwtKeys.setup.js')
    const { signExternalSessionToken } =
      await import('../../../control-api/src/utils/auth/externalSessionAuthToken.js')
    const claims = {
      userId: user.id,
      email: user.email,
      teamId: user.teamId,
      role: user.role,
      authGeneration: 1,
    }
    return ttlSeconds === undefined
      ? signExternalSessionToken(claims)
      : signExternalSessionToken(claims, ttlSeconds)
  } finally {
    for (const name of keyNames) {
      const priorValue = priorValues.get(name)
      if (priorValue === undefined) delete process.env[name]
      else process.env[name] = priorValue
    }
  }
}

type GetMeBarrier = {
  entered: Promise<void>
  release(): void
  markEntered(): void
  blocked: Promise<void>
}

function createGetMeBarrier(): GetMeBarrier {
  let markEntered!: () => void
  let release!: () => void
  const entered = new Promise<void>(resolve => {
    markEntered = resolve
  })
  const blocked = new Promise<void>(resolve => {
    release = resolve
  })
  return { entered, blocked, markEntered, release }
}

async function createServiceForProducerToken(
  token: string,
  getMeBarrier?: GetMeBarrier,
  loginBarrier?: GetMeBarrier,
  loginPath = '/api/v1/auth/v2/password-login'
) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.endsWith(loginPath)) {
      if (loginBarrier) {
        loginBarrier.markEntered()
        await loginBarrier.blocked
      }
      return new Response(JSON.stringify({ token, me: user }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (url.endsWith('/api/v1/me')) {
      if (getMeBarrier) {
        getMeBarrier.markEntered()
        await getMeBarrier.blocked
      }
      return new Response(JSON.stringify(user), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    throw new Error(`unexpected HTTP request in memory-only clock test: ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)

  const service = new AppServiceClass({
    tokenStore: new TokenStoreClass({ isolatedUserDataPath: userDataDirectory }),
    getUserDataDirectory: () => userDataDirectory,
  })
  serviceForCleanup.push(service)
  return { service, fetchMock }
}

async function signInWithProducerToken(ttlSeconds?: number) {
  const token = await issueControlApiSessionToken(ttlSeconds)
  const { service, fetchMock } = await createServiceForProducerToken(token)
  await expect(service.passwordLogin(user.email, 'synthetic-password')).resolves.toMatchObject({
    authenticated: true,
    sessionMode: 'temporary',
    me: user,
  })
  return { service, fetchMock, token }
}

async function expectRestartDenied(): Promise<void> {
  const restarted = new AppServiceClass({
    tokenStore: new TokenStoreClass({ isolatedUserDataPath: userDataDirectory }),
    getUserDataDirectory: () => userDataDirectory,
  })
  serviceForCleanup.push(restarted)
  const getMe = vi.spyOn((restarted as any).authClient, 'getMe')
  await expect(restarted.initialize()).resolves.toEqual({ authenticated: false, me: null })
  expect(getMe).not.toHaveBeenCalled()
}

function simulateSystemSuspend(service: InstanceType<typeof AppServiceClass>): void {
  const endForSuspend = (
    service as unknown as {
      endMemoryOnlySessionForSystemSuspend?: () => void
    }
  ).endMemoryOnlySessionForSystemSuspend
  endForSuspend?.call(service)
}

beforeEach(async () => {
  userDataDirectory = await mkdtemp(path.join(os.tmpdir(), 'evenfire-memory-clock-'))
  testRuntime.userDataDirectory = userDataDirectory
  serviceForCleanup = []
  vi.clearAllMocks()
  vi.resetModules()
  const [appService, tokenStore, config] = await Promise.all([
    import('../appService.js'),
    import('../tokenStore.js'),
    import('../config.js'),
  ])
  AppServiceClass = appService.AppService
  TokenStoreClass = tokenStore.TokenStore
  await config.saveDesktopRuntimeConfig({
    externalRestApiBaseUrl: 'https://auth.example.test/api',
    rpcProxyBaseUrl: '',
  })
  setClock()
})

afterEach(async () => {
  for (const service of serviceForCleanup) await service.prepareForQuit()
  serviceForCleanup = []
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  if (userDataDirectory)
    await rm(userDataDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 })
  userDataDirectory = ''
  testRuntime.userDataDirectory = ''
  vi.resetModules()
})

describe('memory-only session clock bounds through public password login', () => {
  it('revokes the default 12-hour producer session after elapsed time despite wall rollback', async () => {
    const startWall = wallNow
    const startMonotonic = monotonicNow
    const { service, fetchMock } = await signInWithProducerToken()

    wallNow = startWall - 2 * HOUR_MS
    monotonicNow = startMonotonic + TWELVE_HOURS_MS

    expect(service.checkTemporarySessionExpiry()).toBe(true)
    expect(service.getCachedUserId()).toBeNull()
    const callsAtExpiry = fetchMock.mock.calls.length
    await expect(service.listGfsUploadSessions()).rejects.toThrow()
    expect(fetchMock).toHaveBeenCalledTimes(callsAtExpiry)
    await expectRestartDenied()
  })

  it('keeps the 24-hour local cap and expires early after a forward wall-clock jump', async () => {
    const startWall = wallNow
    const startMonotonic = monotonicNow
    const { service } = await signInWithProducerToken(THIRTY_SIX_HOURS_SECONDS)
    const lease = (service as any).memoryOnlySession as {
      expiresAt: number
      expiresAtMonotonicMs: number
    }

    expect(lease.expiresAt).toBe(startWall + 24 * HOUR_MS)
    expect(lease.expiresAtMonotonicMs).toBe(startMonotonic + 24 * HOUR_MS)

    wallNow = startWall + 25 * HOUR_MS
    monotonicNow = startMonotonic + HOUR_MS
    expect(service.checkTemporarySessionExpiry()).toBe(true)
    expect(service.getCachedUserId()).toBeNull()
    await expectRestartDenied()
  })

  it('enforces the 24-hour cap after elapsed time despite wall rollback', async () => {
    const startWall = wallNow
    const startMonotonic = monotonicNow
    const { service, fetchMock } = await signInWithProducerToken(THIRTY_SIX_HOURS_SECONDS)
    const lease = (service as any).memoryOnlySession as {
      expiresAt: number
      expiresAtMonotonicMs: number
    }

    wallNow = startWall - 2 * HOUR_MS
    monotonicNow = startMonotonic + 24 * HOUR_MS

    expect(service.checkTemporarySessionExpiry()).toBe(true)
    expect(lease.expiresAt).toBe(startWall + 24 * HOUR_MS)
    expect(lease.expiresAtMonotonicMs).toBe(startMonotonic + 24 * HOUR_MS)
    expect(service.getCachedUserId()).toBeNull()
    const callsAtExpiry = fetchMock.mock.calls.length
    await expect(service.listGfsUploadSessions()).rejects.toThrow()
    expect(fetchMock).toHaveBeenCalledTimes(callsAtExpiry)
    await expectRestartDenied()
  })

  it('ends a memory-only session synchronously at suspend and leaves restart denied', async () => {
    const { service } = await signInWithProducerToken()

    simulateSystemSuspend(service)

    expect(service.getCachedUserId()).toBeNull()
    expect(service.checkTemporarySessionExpiry()).toBe(false)
    await expectRestartDenied()
  })

  it('rejects an in-flight memory-only acceptance that crosses a system suspend', async () => {
    const token = await issueControlApiSessionToken()
    const getMeBarrier = createGetMeBarrier()
    const { service } = await createServiceForProducerToken(token, getMeBarrier)
    const login = service.passwordLogin(user.email, 'synthetic-password')
    await getMeBarrier.entered

    simulateSystemSuspend(service)
    getMeBarrier.release()

    await expect(login).rejects.toThrow()
    expect(service.getCachedUserId()).toBeNull()
    await expectRestartDenied()
  })

  it('rejects a public password response that crosses a system suspend', async () => {
    const token = await issueControlApiSessionToken()
    const loginBarrier = createGetMeBarrier()
    const { service, fetchMock } = await createServiceForProducerToken(
      token,
      undefined,
      loginBarrier
    )
    const login = service.passwordLogin(user.email, 'synthetic-password')
    await loginBarrier.entered

    simulateSystemSuspend(service)
    loginBarrier.release()

    await expect(login).rejects.toThrow()
    expect(
      fetchMock.mock.calls.map(([input]) => String(input)).filter(url => url.endsWith('/api/v1/me'))
    ).toHaveLength(0)
    expect(service.getCachedUserId()).toBeNull()
    await expectRestartDenied()
  })

  it('rejects a public Google response that crosses a system suspend', async () => {
    const token = await issueControlApiSessionToken()
    const loginBarrier = createGetMeBarrier()
    const { service, fetchMock } = await createServiceForProducerToken(
      token,
      undefined,
      loginBarrier,
      '/api/v1/auth/v2/google'
    )
    const login = service.googleLogin('synthetic-oauth-id-token')
    await loginBarrier.entered

    simulateSystemSuspend(service)
    loginBarrier.release()

    await expect(login).rejects.toThrow()
    expect(
      fetchMock.mock.calls.map(([input]) => String(input)).filter(url => url.endsWith('/api/v1/me'))
    ).toHaveLength(0)
    expect(service.getCachedUserId()).toBeNull()
    await expectRestartDenied()
  })
})
