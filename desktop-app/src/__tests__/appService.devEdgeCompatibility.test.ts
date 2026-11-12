import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppService } from '../appService.js'
import { getActiveEnvKey, getActiveLegacyEnvKeys } from '../config.js'

// The saved-session restore talks to the configured External REST endpoint.
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

afterEach(() => {
  vi.unstubAllGlobals()
})

const SAVED_TOKEN = 'synthetic-saved-session-token'

/**
 * Startup restore (`initialize()` -> `restoreSavedSession`) against each edge a
 * new Desktop can meet during a staged rollout or a rollback. The `/me` answer
 * comes over the real transport (`AuthClient.getMe` -> `requestJson`), so the
 * error the restore classifies is the one production builds from the response.
 */
async function restoreAgainst(response: () => Response) {
  const fetchSpy = vi.fn(async () => response())
  vi.stubGlobal('fetch', fetchSpy)
  const tokenStore = {
    getSessionToken: vi.fn().mockResolvedValue(SAVED_TOKEN),
    clearSessionToken: vi.fn().mockResolvedValue(undefined),
    setSessionToken: vi.fn().mockResolvedValue(undefined),
  }
  const service = new AppService({ tokenStore: tokenStore as never })

  const session = await service.initialize()

  // Witness: the restore asked /me exactly once, with the saved token.
  expect(fetchSpy).toHaveBeenCalledTimes(1)
  const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit]
  expect(url).toBe('https://api.example.test/api/v1/me')
  expect(init.method).toBe('GET')
  expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${SAVED_TOKEN}`)
  expect(tokenStore.getSessionToken).toHaveBeenCalledTimes(1)
  return { session, tokenStore }
}

function expectSavedTokenCleared(tokenStore: { clearSessionToken: ReturnType<typeof vi.fn> }) {
  expect(tokenStore.clearSessionToken).toHaveBeenCalledTimes(1)
  expect(tokenStore.clearSessionToken).toHaveBeenCalledWith(getActiveEnvKey(), {
    legacyEnvKeys: getActiveLegacyEnvKeys(),
  })
}

const signedOut = { authenticated: false, me: null, sessionGeneration: 0 }

describe('AppService saved-session restore across edge versions', () => {
  it('clears the saved token when an earlier edge answers /me with a bare 401', async () => {
    // The earlier edge's requireAuth answers an invalid or expired session token
    // with exactly this status and body.
    const { session, tokenStore } = await restoreAgainst(
      () =>
        new Response('{"error":"Unauthorized"}', {
          status: 401,
          statusText: 'Unauthorized',
          headers: { 'content-type': 'application/json' },
        })
    )

    expect(session).toEqual(signedOut)
    expectSavedTokenCleared(tokenStore)
  })

  it('clears the saved token when the current edge answers /me with invalid_session', async () => {
    const { session, tokenStore } = await restoreAgainst(
      () =>
        new Response(
          JSON.stringify({
            error: {
              code: 'invalid_session',
              message: 'The session is not valid.',
              correlationId: 'synthetic-correlation',
              retryable: false,
            },
          }),
          {
            status: 401,
            statusText: 'Unauthorized',
            headers: { 'content-type': 'application/json' },
          }
        )
    )

    expect(session).toEqual(signedOut)
    expectSavedTokenCleared(tokenStore)
  })

  it('keeps the saved token when /me answers 503', async () => {
    const { session, tokenStore } = await restoreAgainst(
      () =>
        new Response('{"error":"Service Unavailable"}', {
          status: 503,
          statusText: 'Service Unavailable',
          headers: { 'content-type': 'application/json' },
        })
    )

    // An outage is no verdict on the session: this start signs out, the token stays.
    expect(session).toEqual(signedOut)
    expect(tokenStore.clearSessionToken).not.toHaveBeenCalled()
  })
})
