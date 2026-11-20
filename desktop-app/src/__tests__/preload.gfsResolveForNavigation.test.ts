import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppService } from '../appService.js'

type Handler = (event: unknown, payload: unknown) => Promise<unknown>

const electron = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn(),
  handlers: new Map<string, Handler>(),
}))

// One mock serves both sides of the bridge: preload's `ipcRenderer.invoke` and
// main's `ipcMain.handle`, so the request preload emits is fed to the handler
// ipc.ts actually registered instead of to a channel name copied into the test.
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: electron.exposeInMainWorld },
  ipcRenderer: { invoke: electron.invoke, on: vi.fn(), off: vi.fn(), removeListener: vi.fn() },
  webUtils: { getPathForFile: vi.fn() },
  BrowserWindow: { fromWebContents: vi.fn(), getAllWindows: vi.fn(() => []) },
  Notification: vi.fn(),
  app: { on: vi.fn(), getPath: vi.fn(), getVersion: vi.fn() },
  clipboard: { writeText: vi.fn() },
  dialog: { showSaveDialog: vi.fn() },
  ipcMain: {
    handle: vi.fn((channel: string, handler: Handler) => {
      electron.handlers.set(channel, handler)
    }),
    on: vi.fn(),
    removeHandler: vi.fn(),
  },
}))
vi.mock('../appService.js', () => ({ AppService: class {} }))

const uri = 'gfs://main/0123456789abcdef0123456789abcdef'

afterEach(() => {
  electron.exposeInMainWorld.mockReset()
  electron.invoke.mockReset()
  electron.handlers.clear()
  vi.resetModules()
})

async function exposedGfs() {
  await import('../preload.js')
  const exposed = electron.exposeInMainWorld.mock.calls.find(([name]) => name === 'clerum')?.[1]
  return (exposed as typeof window.clerum).gfs
}

describe('preload gfs.resolveForNavigation', () => {
  it('invokes gfs:resolveForNavigation with the { uri } payload and returns its result', async () => {
    const gfs = await exposedGfs()
    electron.invoke.mockResolvedValueOnce({ status: 'superseded' })

    await expect(gfs.resolveForNavigation(uri)).resolves.toEqual({ status: 'superseded' })
    expect(electron.invoke.mock.calls).toEqual([['gfs:resolveForNavigation', { uri }]])
  })

  it('reaches the main-process navigation resolver through the handler ipc.ts registers', async () => {
    const service = {
      resolveGfsUriForNavigation: vi.fn(async () => ({ status: 'superseded' as const })),
      resolveGfsUri: vi.fn(),
    }
    const { registerIpcHandlers } = await import('../ipc.js')
    registerIpcHandlers(service as unknown as AppService, async () => 0)

    const gfs = await exposedGfs()
    electron.invoke.mockImplementationOnce((channel: string, payload: unknown) => {
      const handler = electron.handlers.get(channel)
      if (!handler) throw new Error(`No handler registered for ${channel}`)
      return handler({ senderFrame: { url: 'file:///app/index.html' } }, payload)
    })

    await expect(gfs.resolveForNavigation(uri)).resolves.toEqual({ status: 'superseded' })
    expect(service.resolveGfsUriForNavigation).toHaveBeenCalledWith(uri)
    expect(service.resolveGfsUri).not.toHaveBeenCalled()
  })
})
