import { afterEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn(),
  sendSync: vi.fn(() => true),
  off: vi.fn(),
  on: vi.fn(),
}))

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: electron.exposeInMainWorld },
  ipcRenderer: {
    invoke: electron.invoke,
    sendSync: electron.sendSync,
    off: electron.off,
    on: electron.on,
  },
  webUtils: { getPathForFile: vi.fn() },
}))

afterEach(() => {
  vi.useRealTimers()
  electron.exposeInMainWorld.mockReset()
  electron.invoke.mockReset()
  electron.sendSync.mockReset().mockReturnValue(true)
  electron.off.mockReset()
  electron.on.mockReset()
  vi.resetModules()
})

describe('preload sandboxUi refresh recovery contract', () => {
  it('forwards sandboxUi:refreshRecovered to the subscriber and unsubscribes on dispose', async () => {
    await import('../preload.js')

    const exposed = electron.exposeInMainWorld.mock.calls.find(
      ([name]) => name === 'clerum'
    )?.[1] as {
      sandboxUi: typeof window.clerum.sandboxUi
    }
    expect(exposed).toBeTruthy()

    const callback = vi.fn()
    const dispose = exposed.sandboxUi.onRefreshRecovered(callback)
    const listener = electron.on.mock.calls.find(
      ([channel]) => channel === 'sandboxUi:refreshRecovered'
    )?.[1]
    const event = { appRef: 'app-1', launchId: 'launch-1' }

    listener({}, event)

    expect(callback).toHaveBeenCalledWith(event)
    dispose()
    expect(electron.off).toHaveBeenCalledWith('sandboxUi:refreshRecovered', listener)
  })

  it('correlates a late Profile UI failure with its completed invoke result', async () => {
    let resolveInvoke!: (value: unknown) => void
    electron.invoke.mockImplementation(
      () =>
        new Promise(resolve => {
          resolveInvoke = resolve
        })
    )
    await import('../preload.js')

    const exposed = electron.exposeInMainWorld.mock.calls.find(
      ([name]) => name === 'clerum'
    )?.[1] as { auth: typeof window.clerum.auth }
    const callback = vi.fn()
    const dispose = exposed.auth.onProfileUiDispatchFailed?.(callback)
    const pendingListener = electron.on.mock.calls.find(
      ([channel]) => channel === 'auth:profileUiDispatchFailurePending'
    )?.[1]
    const failureListener = electron.on.mock.calls.find(
      ([channel]) => channel === 'auth:profileUiDispatchFailed'
    )?.[1]
    expect(pendingListener).toBeTypeOf('function')
    expect(failureListener).toBeTypeOf('function')

    const action = exposed.auth.openForgotPassword('user@example.test')
    const documentLease = electron.invoke.mock.calls[0][1].documentLease
    const dispatchDeadline = Date.now() + 5_000
    pendingListener?.({}, { correlationId: 'profile-action-1', documentLease, dispatchDeadline })
    expect(callback).not.toHaveBeenCalled()
    resolveInvoke({
      dispatchAccepted: true,
      correlationId: 'profile-action-1',
      dispatchDeadline,
      profileUiUrl: 'https://profile.example.test/forgot-password',
    })
    await expect(action).resolves.toMatchObject({ correlationId: 'profile-action-1' })
    expect(callback).not.toHaveBeenCalled()
    expect(electron.sendSync).toHaveBeenCalledWith('auth:authorizeProfileUiDispatchFailure', {
      correlationId: 'profile-action-1',
      documentLease,
      dispatchDeadline,
    })
    failureListener?.(
      {},
      {
        correlationId: 'profile-action-1',
        documentLease,
        dispatchDeadline,
        binding: {
          sessionGeneration: 1,
          profileId: 'profile',
          profileIncarnation: 'i1',
          restBaseUrl: 'https://api.example.test',
        },
      }
    )
    expect(callback).toHaveBeenCalledOnce()
    expect(callback.mock.calls[0][0]).toMatchObject({ correlationId: 'profile-action-1' })

    dispose?.()
  })

  it('does not authorize a pending failure from a replaced preload document', async () => {
    let resolveInvoke!: (value: unknown) => void
    electron.invoke.mockImplementation(
      () =>
        new Promise(resolve => {
          resolveInvoke = resolve
        })
    )
    await import('../preload.js')

    const exposed = electron.exposeInMainWorld.mock.calls.find(
      ([name]) => name === 'clerum'
    )?.[1] as { auth: typeof window.clerum.auth }
    const callback = vi.fn()
    exposed.auth.onProfileUiDispatchFailed?.(callback)
    const pendingListener = electron.on.mock.calls.find(
      ([channel]) => channel === 'auth:profileUiDispatchFailurePending'
    )?.[1]
    const dispatchDeadline = Date.now() + 5_000
    const action = exposed.auth.openForgotPassword('user@example.test')
    const correlationId = 'old-document-correlation'
    pendingListener?.(
      {},
      {
        correlationId,
        documentLease: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
        dispatchDeadline,
      }
    )
    resolveInvoke({
      dispatchAccepted: true,
      correlationId,
      dispatchDeadline,
      profileUiUrl: 'https://profile.example.test/forgot-password',
    })
    await action

    expect(electron.sendSync).not.toHaveBeenCalled()
    expect(callback).not.toHaveBeenCalled()
  })

  it('reports a Profile UI failure that arrives after dispatch acceptance', async () => {
    const dispatchDeadline = Date.now() + 5_000
    electron.invoke.mockResolvedValue({
      dispatchAccepted: true,
      correlationId: 'profile-action-late',
      dispatchDeadline,
      profileUiUrl: 'https://profile.example.test/forgot-password',
    })
    await import('../preload.js')

    const exposed = electron.exposeInMainWorld.mock.calls.find(
      ([name]) => name === 'clerum'
    )?.[1] as { auth: typeof window.clerum.auth }
    const callback = vi.fn()
    const dispose = exposed.auth.onProfileUiDispatchFailed?.(callback)
    const failureListener = electron.on.mock.calls.find(
      ([channel]) => channel === 'auth:profileUiDispatchFailed'
    )?.[1]

    await exposed.auth.openForgotPassword('user@example.test')
    const documentLease = electron.invoke.mock.calls[0][1].documentLease
    failureListener?.(
      {},
      {
        correlationId: 'different-action',
        documentLease,
        dispatchDeadline,
        binding: {
          sessionGeneration: 1,
          profileId: 'profile',
          profileIncarnation: 'i1',
          restBaseUrl: 'https://api.example.test',
        },
      }
    )
    expect(callback).not.toHaveBeenCalled()
    failureListener?.(
      {},
      {
        correlationId: 'profile-action-late',
        documentLease,
        dispatchDeadline,
        binding: {
          sessionGeneration: 1,
          profileId: 'profile',
          profileIncarnation: 'i1',
          restBaseUrl: 'https://api.example.test',
        },
      }
    )

    expect(callback).toHaveBeenCalledOnce()
    expect(callback.mock.calls[0][0]).toMatchObject({ correlationId: 'profile-action-late' })
    dispose?.()
  })

  it('drops an accepted dispatch failure at its original absolute deadline', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const dispatchDeadline = 2_000
    electron.invoke.mockResolvedValue({
      dispatchAccepted: true,
      correlationId: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
      dispatchDeadline,
    })
    await import('../preload.js')
    const exposed = electron.exposeInMainWorld.mock.calls.find(
      ([name]) => name === 'clerum'
    )?.[1] as { auth: typeof window.clerum.auth }
    const callback = vi.fn()
    exposed.auth.onProfileUiDispatchFailed?.(callback)
    await exposed.auth.openForgotPassword('user@example.test')
    vi.advanceTimersByTime(1_001)
    const documentLease = electron.invoke.mock.calls[0][1].documentLease
    const failureListener = electron.on.mock.calls.find(
      ([channel]) => channel === 'auth:profileUiDispatchFailed'
    )?.[1]
    failureListener?.(
      {},
      {
        correlationId: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
        documentLease,
        dispatchDeadline,
        binding: {
          sessionGeneration: 1,
          profileId: 'profile',
          profileIncarnation: 'i1',
          restBaseUrl: 'https://api.example.test',
        },
      }
    )
    expect(callback).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('bounds early Profile UI failure correlations at the approved capacity', async () => {
    const pendingInvokes: Array<(value: unknown) => void> = []
    electron.invoke.mockImplementation(
      () =>
        new Promise(resolve => {
          pendingInvokes.push(resolve)
        })
    )
    await import('../preload.js')

    const exposed = electron.exposeInMainWorld.mock.calls.find(
      ([name]) => name === 'clerum'
    )?.[1] as { auth: typeof window.clerum.auth }
    const pendingListener = electron.on.mock.calls.find(
      ([channel]) => channel === 'auth:profileUiDispatchFailurePending'
    )?.[1]
    const deadline = Date.now() + 5_000
    const actions = Array.from({ length: 129 }, (_, index) =>
      exposed.auth.openForgotPassword(`user-${index}@example.test`)
    )
    const documentLease = electron.invoke.mock.calls[0][1].documentLease

    for (let index = 0; index < actions.length; index += 1) {
      pendingListener?.(
        {},
        {
          correlationId: `capacity-${index}`,
          documentLease,
          dispatchDeadline: deadline,
        }
      )
    }
    pendingInvokes.forEach((resolve, index) =>
      resolve({
        dispatchAccepted: true,
        correlationId: `capacity-${index}`,
        dispatchDeadline: deadline,
        profileUiUrl: 'https://profile.example.test/forgot-password',
      })
    )
    await Promise.all(actions)

    expect(electron.sendSync).toHaveBeenCalledTimes(128)
    expect(electron.sendSync).not.toHaveBeenCalledWith(
      'auth:authorizeProfileUiDispatchFailure',
      expect.objectContaining({ correlationId: 'capacity-128' })
    )
  })
})
