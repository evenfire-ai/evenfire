import { describe, expect, it, vi } from 'vitest'
import { AppService } from '../appService.js'
import { ApiError } from '../httpClient.js'

// passwordLogin refuses to run until the desktop runtime is configured.
vi.hoisted(() => {
  process.env.EXTERNAL_REST_API_BASE_URL = 'https://api.example.test'
  process.env.RPC_PROXY_BASE_URL = 'https://rpc.example.test'
})

vi.mock('electron', () => ({
  app: { isReady: vi.fn(() => false), getPath: vi.fn(() => '/tmp/clerum-desktop-test') },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => false),
    encryptString: vi.fn(),
    decryptString: vi.fn(),
  },
  shell: { openExternal: vi.fn() },
}))
vi.mock('../chatStoreBinding.js', () => ({
  bindChatStoreForUser: vi.fn(),
  getChatStore: vi.fn(),
  unbindChatStore: vi.fn(),
}))

// The current edge's /me answer for an ended session: the invalid_session envelope.
const sessionEnded = () =>
  new ApiError(
    '401 Unauthorized: invalid_session',
    401,
    JSON.stringify({
      error: {
        code: 'invalid_session',
        message: 'The session is not valid.',
        correlationId: 'synthetic-correlation',
        retryable: false,
      },
    })
  )
const sessionMe = (id: string, teamId: string | null) => ({
  id,
  email: `${id}@example.test`,
  name: id,
  picture: null,
  teamId,
  teamName: teamId,
  role: 'member',
})

function createService() {
  const tokenStore = {
    clearSessionToken: vi.fn().mockResolvedValue(undefined),
    getSessionToken: vi.fn().mockResolvedValue(null),
    setSessionToken: vi.fn().mockResolvedValue(undefined),
  }
  const onSessionCleared = vi.fn()
  const service = new AppService({ tokenStore: tokenStore as never, onSessionCleared }) as any
  service.sessionToken = 'token-a'
  service.me = sessionMe('user-a', 'team-a')
  service.beginPrewarmAuthTransition = () => () => undefined
  service.bindCurrentChatStore = vi.fn().mockResolvedValue(undefined)
  service.activateGfsAuthScope = vi.fn()
  service.suspendDesktopGfsUploadsForAuthBoundary = vi.fn().mockResolvedValue(undefined)
  return { service, tokenStore, onSessionCleared }
}

async function rejectOldSessionDuringReservedLogin(kind: 'google' | 'password') {
  const { service, tokenStore, onSessionCleared } = createService()
  const endRejected = vi.spyOn(service, 'endSessionRejectedByMe')
  let rejectMe!: (error: unknown) => void
  let resolveLogin!: (value: unknown) => void
  const pendingLogin = () => new Promise(resolve => (resolveLogin = resolve))
  service.authClient = {
    getMe: vi.fn(() => new Promise((_, reject) => (rejectMe = reject))),
    googleLogin: vi.fn(pendingLogin),
    passwordLogin: vi.fn(pendingLogin),
  }
  const dispatched =
    kind === 'google' ? service.authClient.googleLogin : service.authClient.passwordLogin
  const check = service.confirmCommittedSessionWithMe()
  const login =
    kind === 'google'
      ? service.googleLogin('id-token')
      : service.passwordLogin('user-b@example.test', 'password')
  await vi.waitFor(() => expect(dispatched).toHaveBeenCalledTimes(1))

  rejectMe(sessionEnded())
  await check

  // The rejection of the old token reached the close decision.
  expect(service.authClient.getMe).toHaveBeenCalledWith('token-a')
  expect(endRejected).toHaveBeenCalledTimes(1)
  expect(endRejected).toHaveBeenCalledWith('token-a')

  resolveLogin({ token: 'token-b', me: sessionMe('user-b', 'team-b') })
  await expect(login).resolves.toMatchObject({ authenticated: true, me: { id: 'user-b' } })
  expect(service.sessionToken).toBe('token-b')
  expect(tokenStore.setSessionToken).toHaveBeenCalledWith('token-b', expect.any(String))
  expect(tokenStore.clearSessionToken).not.toHaveBeenCalled()
  expect(onSessionCleared).not.toHaveBeenCalled()
}

describe('AppService session rejected by /me while a login is in progress', () => {
  it('keeps a reserved Google login when /me rejects the session it replaces', async () => {
    await rejectOldSessionDuringReservedLogin('google')
  })

  it('keeps a reserved password login when /me rejects the session it replaces', async () => {
    await rejectOldSessionDuringReservedLogin('password')
  })

  it('leaves a login committed before the old rejection arrives', async () => {
    const { service, tokenStore, onSessionCleared } = createService()
    let rejectMe!: (error: unknown) => void
    service.authClient = {
      getMe: vi.fn(() => new Promise((_, reject) => (rejectMe = reject))),
      googleLogin: vi
        .fn()
        .mockResolvedValue({ token: 'token-b', me: sessionMe('user-b', 'team-b') }),
    }
    const check = service.confirmCommittedSessionWithMe()
    await service.googleLogin('id-token')

    rejectMe(sessionEnded())
    await check

    expect(service.authClient.getMe).toHaveBeenCalledWith('token-a')
    expect(service.sessionToken).toBe('token-b')
    expect(tokenStore.clearSessionToken).not.toHaveBeenCalled()
    expect(onSessionCleared).not.toHaveBeenCalled()
  })

  it('ends the session when /me rejects it and no login is in progress', async () => {
    const { service, tokenStore, onSessionCleared } = createService()
    service.authClient = { getMe: vi.fn().mockRejectedValue(sessionEnded()) }

    await service.confirmCommittedSessionWithMe()

    expect(service.sessionToken).toBeNull()
    expect(tokenStore.clearSessionToken).toHaveBeenCalledTimes(1)
    expect(onSessionCleared).toHaveBeenCalledTimes(1)
  })
})
