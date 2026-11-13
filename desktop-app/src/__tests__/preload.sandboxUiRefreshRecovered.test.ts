import { afterEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn(),
  off: vi.fn(),
  on: vi.fn(),
}))

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: electron.exposeInMainWorld },
  ipcRenderer: {
    invoke: electron.invoke,
    off: electron.off,
    on: electron.on,
  },
  webUtils: { getPathForFile: vi.fn() },
}))

afterEach(() => {
  electron.exposeInMainWorld.mockReset()
  electron.invoke.mockReset()
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
    const failureListener = electron.on.mock.calls.find(
      ([channel]) => channel === 'auth:profileUiDispatchFailed'
    )?.[1]
    expect(failureListener).toBeTypeOf('function')

    const action = exposed.auth.openForgotPassword('user@example.test')
    failureListener?.({}, { correlationId: 'profile-action-1' })
    expect(callback).not.toHaveBeenCalled()
    resolveInvoke({
      dispatchAccepted: true,
      correlationId: 'profile-action-1',
      profileUiUrl: 'https://profile.example.test/forgot-password',
    })
    await expect(action).resolves.toMatchObject({ correlationId: 'profile-action-1' })
    expect(callback).toHaveBeenCalledOnce()
    expect(callback).toHaveBeenCalledWith('profile-action-1')

    dispose?.()
  })

  it('reports a Profile UI failure that arrives after dispatch acceptance', async () => {
    electron.invoke.mockResolvedValue({
      dispatchAccepted: true,
      correlationId: 'profile-action-late',
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
    failureListener?.({}, { correlationId: 'different-action' })
    expect(callback).not.toHaveBeenCalled()
    failureListener?.({}, { correlationId: 'profile-action-late' })

    expect(callback).toHaveBeenCalledOnce()
    expect(callback).toHaveBeenCalledWith('profile-action-late')
    dispose?.()
  })
})
