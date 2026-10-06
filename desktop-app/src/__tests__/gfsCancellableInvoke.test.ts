/**
 * R2-L3/R1-M6 — the REAL preload's cancellable GFS bridge, exercised through
 * a mocked Electron boundary. The preload is the sandboxed security surface,
 * so its behavior is tested directly (no extracted helper): an already-aborted
 * signal starts no producer work; a mid-flight abort fires gfs:abort exactly
 * once with the invoke's requestId; a signal-less call is a plain invoke.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => {
  const exposed = new Map<string, unknown>()
  return {
    exposed,
    ipcRenderer: {
      invoke: vi.fn(() => new Promise(() => undefined)),
      send: vi.fn(),
      on: vi.fn(),
      removeAllListeners: vi.fn(),
    },
  }
})

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: vi.fn((name: string, value: unknown) => {
      electron.exposed.set(name, value)
    }),
  },
  ipcRenderer: electron.ipcRenderer,
  webUtils: { getPathForFile: vi.fn() },
}))

type ClerumBridge = {
  gfs: {
    listChildren: (
      resourceId: string,
      drive?: string,
      cursor?: string,
      options?: { signal?: AbortSignal }
    ) => Promise<unknown>
    download: (
      uri: string,
      options?: { maxBytes?: number; signal?: AbortSignal }
    ) => Promise<unknown>
  }
}

let bridge: ClerumBridge

beforeAll(async () => {
  await import('../preload.js')
  bridge = electron.exposed.get('clerum') as ClerumBridge
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('preload cancellable GFS bridge (R2-L3)', () => {
  it('starts no IPC or producer work for an already-aborted signal', async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(
      bridge.gfs.listChildren('folder-1', 'main', undefined, { signal: controller.signal })
    ).rejects.toMatchObject({ name: 'AbortError' })
    await expect(
      bridge.gfs.download('gfs://main/x', { signal: controller.signal })
    ).rejects.toMatchObject({ name: 'AbortError' })

    expect(electron.ipcRenderer.invoke).not.toHaveBeenCalled()
    expect(electron.ipcRenderer.send).not.toHaveBeenCalled()
  })

  it('carries a requestId, fires gfs:abort once on abort, and detaches on settle', async () => {
    const controller = new AbortController()
    const pending = bridge.gfs.listChildren('folder-1', 'main', undefined, {
      signal: controller.signal,
    })
    pending.catch(() => undefined)

    expect(electron.ipcRenderer.invoke).toHaveBeenCalledTimes(1)
    const [channel, payload] = electron.ipcRenderer.invoke.mock.calls[0] as [
      string,
      { requestId?: string },
    ]
    expect(channel).toBe('gfs:listChildren')
    expect(typeof payload.requestId).toBe('string')

    controller.abort()
    expect(electron.ipcRenderer.send).toHaveBeenCalledTimes(1)
    expect(electron.ipcRenderer.send).toHaveBeenCalledWith('gfs:abort', {
      requestId: payload.requestId,
    })
    // A late synthetic abort event must not re-send after cleanup.
    controller.signal.dispatchEvent(new Event('abort'))
    expect(electron.ipcRenderer.send).toHaveBeenCalledTimes(1)
  })

  it('forwards the download bound and passes a signal-less call through untouched', async () => {
    electron.ipcRenderer.invoke.mockReturnValueOnce(Promise.resolve({ ok: true }))
    bridge.gfs.download('gfs://main/x', { maxBytes: 512 })
    expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith('gfs:download', {
      uri: 'gfs://main/x',
      maxBytes: 512,
      requestId: undefined,
    })
  })
})
