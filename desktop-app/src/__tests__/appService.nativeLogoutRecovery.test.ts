import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  cleanupNativeCommitTestHarness,
  createNativeCommitTestHarness,
} from '../../testSupport/appService.nativeCommitTestHarness.js'
import { testLoginResult, testSessionMe } from '../../testSupport/authTestFixtures.js'
import { buildGfsResourceDeepLink, parseGfsResourceDeepLink } from '../gfsDeepLinks.js'
import {
  GfsResourceDeepLinkQueue,
  createLogoutWithGfsResourceDeepLinkClear,
} from '../gfsResourceDeepLinkQueue.js'
import { readPendingExternalLogoutIntent } from '../pendingExternalLogout.js'

afterEach(cleanupNativeCommitTestHarness)

describe('AppService logout recovery ownership', () => {
  it('preserves an actual committed cleanup-pending result through GFS queue clearing', async () => {
    const { service } = await createNativeCommitTestHarness({ keytarAvailable: true })
    service.authClient = {
      googleLogin: vi.fn().mockResolvedValue(testLoginResult()),
      getMe: vi.fn().mockResolvedValue(testSessionMe()),
    } as never
    await service.googleLogin('initial-login')
    service.tokenStore.clearSessionTokenStrictly = vi
      .fn()
      .mockRejectedValue(new Error('keychain unavailable'))

    const queue = new GfsResourceDeepLinkQueue()
    const target = parseGfsResourceDeepLink(
      buildGfsResourceDeepLink('gfs://main/0123456789abcdef0123456789abcdef')
    )
    if (!target) throw new Error('The shared GFS producer rejected the resource fixture')
    queue.enqueue(target, service.getSessionGeneration())
    let producedOutcome: Awaited<ReturnType<typeof service.logout>> | undefined
    const logoutWithQueueClear = createLogoutWithGfsResourceDeepLinkClear(queue, async () => {
      producedOutcome = await service.logout()
      return producedOutcome
    })

    const result = await logoutWithQueueClear()

    expect(producedOutcome).toMatchObject({ kind: 'committed', cleanup: 'pending' })
    expect(result).toBe(producedOutcome)
    expect(result).toMatchObject({ kind: 'committed', cleanup: 'pending' })
    expect(queue.list()).toEqual([])
  })

  it('preserves an actual committed cleanup-complete result through GFS queue clearing', async () => {
    const { service } = await createNativeCommitTestHarness({ keytarAvailable: false })
    service.authClient = {
      googleLogin: vi.fn().mockResolvedValue(testLoginResult()),
      getMe: vi.fn().mockResolvedValue(testSessionMe()),
    } as never
    await service.googleLogin('initial-login')

    const queue = new GfsResourceDeepLinkQueue()
    const target = parseGfsResourceDeepLink(
      buildGfsResourceDeepLink('gfs://main/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
    )
    if (!target) throw new Error('The shared GFS producer rejected the resource fixture')
    queue.enqueue(target, service.getSessionGeneration())
    let producedOutcome: Awaited<ReturnType<typeof service.logout>> | undefined
    const logoutWithQueueClear = createLogoutWithGfsResourceDeepLinkClear(queue, async () => {
      producedOutcome = await service.logout()
      return producedOutcome
    })

    const result = await logoutWithQueueClear()

    expect(producedOutcome).toMatchObject({ kind: 'committed', cleanup: 'not-required' })
    expect(result).toBe(producedOutcome)
    expect(result).toMatchObject({ kind: 'committed', cleanup: 'not-required' })
    expect(service.getCachedUserId()).toBeNull()
    expect(queue.list()).toEqual([])
  })

  it('preserves an actual non-committed result through GFS queue clearing', async () => {
    const { service, runtimeConfig } = await createNativeCommitTestHarness({
      keytarAvailable: true,
    })
    await service.tokenStore.setSessionToken(
      'unowned-historical-token',
      runtimeConfig.getActiveEnvKey()
    )
    const queue = new GfsResourceDeepLinkQueue()
    const target = parseGfsResourceDeepLink(
      buildGfsResourceDeepLink('gfs://main/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')
    )
    if (!target) throw new Error('The shared GFS producer rejected the resource fixture')
    queue.enqueue(target)
    let producedOutcome: Awaited<ReturnType<typeof service.logout>> | undefined
    const logoutWithQueueClear = createLogoutWithGfsResourceDeepLinkClear(queue, async () => {
      producedOutcome = await service.logout()
      return producedOutcome
    })

    const result = await logoutWithQueueClear()

    expect(producedOutcome).toMatchObject({ kind: 'not-committed' })
    expect(result).toBe(producedOutcome)
    expect(result).toMatchObject({ kind: 'not-committed' })
    expect(queue.list()).toEqual([])
    await expect(service.tokenStore.getSessionToken(runtimeConfig.getActiveEnvKey())).resolves.toBe(
      'unowned-historical-token'
    )
  })

  it('fails closed and fences restart restore when strict token removal fails', async () => {
    const { service, runtimeConfig, userDataDir } = await createNativeCommitTestHarness({
      keytarAvailable: true,
    })
    const getMe = vi.fn().mockResolvedValue(testSessionMe())
    service.authClient = {
      googleLogin: vi.fn().mockResolvedValue(testLoginResult()),
      getMe,
    } as never
    await service.googleLogin('initial-login')
    getMe.mockClear()
    service.tokenStore.clearSessionTokenStrictly = vi
      .fn()
      .mockRejectedValue(new Error('keychain unavailable'))

    await expect(service.logout()).resolves.toMatchObject({
      kind: 'committed',
      cleanup: 'pending',
    })

    expect(service.getCachedUserId()).toBeNull()
    expect(service.sessionToken).toBeNull()
    expect(readPendingExternalLogoutIntent(userDataDir, runtimeConfig.getActiveEnvKey())).toEqual({
      intent: 'logout-pending',
    })
    await expect(service.getSessionState()).resolves.toEqual({ authenticated: false, me: null })
    expect(getMe).not.toHaveBeenCalled()
  })
})
