import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GfsWatchEvent } from '../types.js'

type Listener = (event: unknown, payload: unknown) => void

const electron = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn(),
  listeners: new Map<string, Set<(event: unknown, payload: unknown) => void>>(),
}))

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: electron.exposeInMainWorld },
  ipcRenderer: {
    invoke: electron.invoke,
    on: (channel: string, listener: Listener) => {
      if (!electron.listeners.has(channel)) electron.listeners.set(channel, new Set())
      electron.listeners.get(channel)!.add(listener)
    },
    off: (channel: string, listener: Listener) => electron.listeners.get(channel)?.delete(listener),
    removeListener: (channel: string, listener: Listener) =>
      electron.listeners.get(channel)?.delete(listener),
  },
  webUtils: { getPathForFile: vi.fn() },
}))

/** main's `webContents.send` to this renderer. */
const push = (channel: string, payload: unknown) =>
  electron.listeners.get(channel)?.forEach(listener => listener({}, payload))

afterEach(() => {
  electron.exposeInMainWorld.mockReset()
  electron.invoke.mockReset()
  electron.listeners.clear()
  vi.resetModules()
})

async function exposedGfsWatch() {
  await import('../preload.js')
  const exposed = electron.exposeInMainWorld.mock.calls.find(([name]) => name === 'clerum')?.[1]
  return (exposed as typeof window.clerum).gfsWatch
}

describe('preload gfsWatch', () => {
  it('T-CB31: an event emitted while the first setSubscriptions is in flight is delivered', async () => {
    const gfsWatch = await exposedGfsWatch()
    let answer!: (value: unknown) => void
    electron.invoke.mockImplementationOnce(() => new Promise(resolve => (answer = resolve)))
    const received: GfsWatchEvent[] = []
    const opening = gfsWatch.open(event => received.push(event), {
      keys: ['file:gfs://d1/00000000000000000000000000000001'],
      userId: 'user-1',
    })

    expect(electron.invoke).toHaveBeenCalledWith('gfsWatch:setSubscriptions', {
      keys: ['file:gfs://d1/00000000000000000000000000000001'],
      userId: 'user-1',
    })
    push('gfsWatch:event', { type: 'accessChanged' })
    answer({ sessionExpired: true })
    const handle = await opening

    expect(received).toEqual([{ type: 'accessChanged' }])
    expect(handle.sessionExpired).toBe(true)

    electron.invoke.mockResolvedValueOnce({ sessionExpired: false })
    await expect(handle.setSubscriptions({ keys: [], userId: 'user-1' })).resolves.toEqual({
      sessionExpired: false,
    })

    electron.invoke.mockResolvedValueOnce({ ok: true })
    await handle.close()
    expect(electron.invoke).toHaveBeenLastCalledWith('gfsWatch:stop')
    push('gfsWatch:event', { type: 'accessChanged' })
    expect(received).toHaveLength(1)
  })

  it('removes the listener when the first request fails', async () => {
    const gfsWatch = await exposedGfsWatch()
    electron.invoke.mockRejectedValueOnce(new Error('Untrusted IPC sender'))
    await expect(gfsWatch.open(() => undefined, { keys: [], userId: null })).rejects.toThrow(
      'Untrusted IPC sender'
    )
    expect(electron.listeners.get('gfsWatch:event')?.size ?? 0).toBe(0)
  })
})
