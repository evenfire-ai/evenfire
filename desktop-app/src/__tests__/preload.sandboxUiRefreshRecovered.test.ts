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
})
