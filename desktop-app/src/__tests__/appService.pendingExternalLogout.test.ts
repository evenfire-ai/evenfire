import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let userDataDirectory = ''
let AppServiceClass: typeof import('../appService.js').AppService
let markerStore: typeof import('../pendingExternalLogout.js')

vi.mock('../chatStoreBinding.js', () => ({
  bindChatStoreForUser: vi.fn(),
  unbindChatStore: vi.fn(),
  __setChatStoreBaseDirForTests: vi.fn(),
}))

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => userDataDirectory),
    isReady: vi.fn(() => true),
  },
  safeStorage: { isEncryptionAvailable: vi.fn(() => false) },
}))

beforeEach(async () => {
  userDataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'evenfire-app-pending-logout-'))
  vi.resetModules()
  const [{ AppService }, pendingLogout] = await Promise.all([
    import('../appService.js'),
    import('../pendingExternalLogout.js'),
  ])
  AppServiceClass = AppService
  markerStore = pendingLogout
})

afterEach(async () => {
  vi.restoreAllMocks()
  if (userDataDirectory) await fs.rm(userDataDirectory, { recursive: true, force: true })
  userDataDirectory = ''
  vi.resetModules()
})

function createService(clearSessionToken = vi.fn().mockResolvedValue(undefined)) {
  const tokenStore = { clearSessionToken } as unknown as InstanceType<
    typeof import('../tokenStore.js').TokenStore
  >
  const service = new AppServiceClass({
    tokenStore,
    getUserDataDirectory: () => userDataDirectory,
    reportDeferredLogoutFailure: vi.fn(),
  })
  const internal = service as unknown as {
    restoreSavedSession: (options?: { runLaunchMaintenance?: boolean }) => Promise<unknown>
    restoreSavedSessionOnce: (options?: { runLaunchMaintenance?: boolean }) => Promise<unknown>
    logoutOnce: (options?: { strictTokenClear?: boolean }) => Promise<void>
  }
  return { clearSessionToken, internal, service }
}

describe('AppService pending external logout', () => {
  it('clears the pending session before restore and removes the marker on success', async () => {
    markerStore.recordPendingExternalLogout(userDataDirectory)
    const { clearSessionToken, internal, service } = createService()
    const restore = vi.spyOn(internal, 'restoreSavedSessionOnce')

    await expect(service.initialize()).resolves.toEqual({ authenticated: false, me: null })

    expect(clearSessionToken).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ throwOnStorageError: true })
    )
    expect(restore).not.toHaveBeenCalled()
    expect(markerStore.hasPendingExternalLogout(userDataDirectory)).toBe(false)
  })

  it('keeps the marker and skips restore when saved credentials cannot be cleared', async () => {
    markerStore.recordPendingExternalLogout(userDataDirectory)
    const failure = new Error('storage failed')
    const reportFailure = vi.fn()
    const clearSessionToken = vi.fn().mockRejectedValue(failure)
    const { internal, service } = createService(clearSessionToken)
    const restore = vi.spyOn(internal, 'restoreSavedSessionOnce')
    const serviceOptions = service as unknown as {
      reportDeferredLogoutFailure: (error: unknown) => void
    }
    const report = vi.spyOn(serviceOptions, 'reportDeferredLogoutFailure')
    report.mockImplementation(reportFailure)

    await expect(service.initialize()).resolves.toEqual({ authenticated: false, me: null })

    expect(restore).not.toHaveBeenCalled()
    expect(markerStore.hasPendingExternalLogout(userDataDirectory)).toBe(true)
    expect(reportFailure).toHaveBeenCalledWith(failure)
  })

  it('retries a pending logout after canceled quit and only clears its marker on success', async () => {
    markerStore.recordPendingExternalLogout(userDataDirectory)
    const { internal, service } = createService()
    const logoutOnce = vi.spyOn(internal, 'logoutOnce').mockResolvedValue(undefined)

    await expect(service.applyPendingExternalLogoutIntent()).resolves.toBe(true)

    expect(logoutOnce).toHaveBeenCalledWith({ strictTokenClear: true })
    expect(markerStore.hasPendingExternalLogout(userDataDirectory)).toBe(false)
  })

  it('clears a pending marker only after an explicit login is persisted', async () => {
    markerStore.recordPendingExternalLogout(userDataDirectory)
    const setSessionToken = vi.fn(async () => {
      expect(markerStore.hasPendingExternalLogout(userDataDirectory)).toBe(true)
    })
    const tokenStore = { setSessionToken } as unknown as InstanceType<
      typeof import('../tokenStore.js').TokenStore
    >
    const service = new AppServiceClass({
      tokenStore,
      getUserDataDirectory: () => userDataDirectory,
    })
    const internal = service as unknown as {
      installAuthenticatedLoginOnce: (result: {
        token: string
        me: {
          id: string
          email: string
          name: string | null
          picture: string | null
          teamId: string
          teamName: string
          role: string
        }
      }) => Promise<unknown>
    }

    await internal.installAuthenticatedLoginOnce({
      token: 'new-session-token',
      me: {
        id: 'user-1',
        email: 'user@example.com',
        name: null,
        picture: null,
        teamId: 'team-1',
        teamName: 'Team 1',
        role: 'member',
      },
    })

    expect(setSessionToken).toHaveBeenCalledOnce()
    expect(markerStore.hasPendingExternalLogout(userDataDirectory)).toBe(false)
  })

  it('retains a pending logout marker when canceled-quit retry fails', async () => {
    markerStore.recordPendingExternalLogout(userDataDirectory)
    const { internal, service } = createService()
    vi.spyOn(internal, 'logoutOnce').mockRejectedValue(new Error('storage failed'))

    await expect(service.applyPendingExternalLogoutIntent()).rejects.toThrow('storage failed')

    expect(markerStore.hasPendingExternalLogout(userDataDirectory)).toBe(true)
  })
})
