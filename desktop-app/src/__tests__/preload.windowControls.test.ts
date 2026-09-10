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

describe('preload window controls contract', () => {
  it('exposes the titlebar controls through clerum with matching IPC channels and cleanup', async () => {
    await import('../preload.js')

    const exposed = electron.exposeInMainWorld.mock.calls.find(
      ([name]) => name === 'clerum'
    )?.[1] as {
      window: typeof window.clerum.window
    }
    expect(exposed).toBeTruthy()

    await exposed.window.getControlsState()
    await exposed.window.minimize()
    await exposed.window.toggleMaximize()
    await exposed.window.close()

    expect(electron.invoke.mock.calls).toEqual([
      ['window:getControlsState'],
      ['window:minimize'],
      ['window:toggleMaximize'],
      ['window:close'],
    ])

    const callback = vi.fn()
    const dispose = exposed.window.onControlsStateChange(callback)
    const listener = electron.on.mock.calls.find(
      ([channel]) => channel === 'window:controlsState'
    )?.[1]
    const state = { fullscreen: false, maximized: true }

    listener({}, state)

    expect(callback).toHaveBeenCalledWith(state)
    dispose()
    expect(electron.off).toHaveBeenCalledWith('window:controlsState', listener)
  })
})
