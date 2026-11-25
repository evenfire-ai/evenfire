import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeWebContents } from '../../testSupport/gfsWatch/fakeWebContents.js'
import { USER_A, key } from '../../testSupport/gfsWatch/sessionTokens.js'
import { WatchHarness } from '../../testSupport/gfsWatch/watchHarness.js'
import type { AppService } from '../appService.js'

type Handler = (event: unknown, payload?: unknown) => unknown

const electron = vi.hoisted(() => ({ handlers: new Map<string, Handler>() }))

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: vi.fn(), getAllWindows: vi.fn(() => []) },
  Notification: vi.fn(),
  app: { on: vi.fn(), getPath: vi.fn(), getVersion: vi.fn(), isReady: vi.fn(() => false) },
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

const keys1 = [key('file', 1), key('dir', 2)]
const keys2 = [key('file', 3)]

let h: WatchHarness

beforeEach(async () => {
  h = await new WatchHarness().start()
  const { registerIpcHandlers } = await import('../ipc.js')
  registerIpcHandlers({ gfsWatch: h.client } as unknown as AppService, async () => 0)
  await h.login(USER_A)
  expect(h.linkKind()).toBe('Ready')
})

afterEach(async () => {
  await h.stop()
})

function handler(channel: string): Handler {
  const registered = electron.handlers.get(channel)
  if (!registered) throw new Error(`no IPC handler for ${channel}`)
  return registered
}

async function setSubscriptions(
  event: unknown,
  payload: unknown
): Promise<{ sessionExpired: boolean }> {
  const result = (await handler('gfsWatch:setSubscriptions')(event, payload)) as {
    sessionExpired: boolean
  }
  await h.settle()
  return result
}

async function stop(event: unknown) {
  await handler('gfsWatch:stop')(event)
  await h.settle()
}

const sent = () => h.client.inspect().sent

describe('gfsWatch IPC', () => {
  it('T-CB31: delivery skips a destroyed window and survives a throwing one', async () => {
    const [w1, w2, w3] = [
      new FakeWebContents(201),
      new FakeWebContents(202),
      new FakeWebContents(203),
    ]
    for (const w of [w1, w2, w3]) await setSubscriptions(w.ipcEvent(), { keys: [], userId: USER_A })
    w1.destroyed = true // still registered: `destroyed` has not been emitted yet
    w2.throwOnSend = true

    h.server.frame({ type: 'roots_changed' })
    await h.settle()

    expect(w1.events()).toEqual([])
    expect(w3.events()).toContainEqual({ type: 'accessChangedRoots' })
  })

  it('T-CB31: an untrusted sender is refused and an ownerId in the payload is ignored', async () => {
    const w = new FakeWebContents(211)
    const untrusted = w.ipcEvent(w.currentFrameToken, 'https://evil.example.test/')
    expect(() =>
      handler('gfsWatch:setSubscriptions')(untrusted, { keys: keys1, userId: USER_A })
    ).toThrow('Untrusted IPC sender')
    expect(() => handler('gfsWatch:stop')(untrusted)).toThrow('Untrusted IPC sender')
    expect(h.client.hasOwner(211)).toBe(false)

    await setSubscriptions(w.ipcEvent(), { keys: keys1, userId: USER_A, ownerId: 999, id: 999 })
    expect(h.client.hasOwner(211)).toBe(true)
    expect(h.client.hasOwner(999)).toBe(false)
    expect(sent()).toEqual(keys1)
  })

  it('T-CB36: the owner outlives reloads; destroyed removes it; stop empties its list only', async () => {
    const w = new FakeWebContents(221)
    await setSubscriptions(w.ipcEvent(), { keys: keys1, userId: USER_A })
    const regOrder = h.client.inspect().owners.get(221)?.regOrder

    for (let i = 0; i < 2; i += 1) {
      w.reload()
      await h.settle()
      expect(sent()).toEqual([])
      expect(h.client.inspect().owners.get(221)).toMatchObject({
        regOrder,
        frameToken: w.currentFrameToken,
        keys: [],
      })
      await setSubscriptions(w.ipcEvent(), { keys: keys1, userId: USER_A })
      expect(sent()).toEqual(keys1)
    }
    // One listener each, however many times the window subscribed or reloaded.
    expect(w.listenerCount('did-navigate')).toBe(1)
    expect(w.listenerCount('render-process-gone')).toBe(1)
    expect(w.listenerCount('destroyed')).toBe(1)

    await stop(w.ipcEvent())
    expect(sent()).toEqual([])
    expect(h.client.inspect().owners.get(221)?.frameToken).toBe(w.currentFrameToken)
    await setSubscriptions(w.ipcEvent(), { keys: keys2, userId: USER_A })
    expect(sent()).toEqual(keys2)

    w.destroy()
    await h.settle()
    expect(h.client.hasOwner(221)).toBe(false)
    expect(sent()).toEqual([])
    expect(w.listenerCount('did-navigate')).toBe(0)
    expect(w.listenerCount('render-process-gone')).toBe(0)
    expect(h.linkKind()).toBe('Ready') // the stream stays open as the session channel
  })

  it('T-CB36/T-CB56: a renderer crash empties the list without reading the frame token; IPC waits for the next navigation', async () => {
    const w = new FakeWebContents(231)
    const other = new FakeWebContents(232)
    await setSubscriptions(w.ipcEvent(), { keys: keys1, userId: USER_A })
    await setSubscriptions(other.ipcEvent(), { keys: keys2, userId: USER_A })
    const tokenBefore = w.currentFrameToken

    w.crash('clean-exit')
    await h.settle()
    expect(h.client.inspect().owners.get(231)).toMatchObject({ keys: [], frameToken: null })
    expect(sent()).toEqual(keys2)
    expect(h.server.current()?.keys).toEqual(new Set(keys2))

    // Nothing is delivered to a window without an accepted document.
    const deliveredBefore = w.events().length
    h.server.frame({ type: 'roots_changed' })
    await h.settle()
    expect(w.events()).toHaveLength(deliveredBefore)
    expect(other.events()).toContainEqual({ type: 'accessChangedRoots' })

    await setSubscriptions(w.ipcEvent(tokenBefore), { keys: keys1, userId: USER_A })
    expect(sent()).toEqual(keys2)

    w.reload()
    await h.settle()
    expect(h.client.inspect().owners.get(231)?.frameToken).toBe(w.currentFrameToken)
    await setSubscriptions(w.ipcEvent(), { keys: keys1, userId: USER_A })
    // Merged by rank, ties by registration order: the crashed window keeps its place.
    expect(sent()).toEqual([keys1[0], keys2[0], keys1[1]])
  })

  it('T-CB47 (double): a late IPC of the previous document and one from a subframe are dropped', async () => {
    const w = new FakeWebContents(241)
    await setSubscriptions(w.ipcEvent(), { keys: keys1, userId: USER_A })
    const stale = w.ipcEvent()
    w.reload()
    await h.settle()

    await setSubscriptions(stale, { keys: keys2, userId: USER_A })
    expect(sent()).toEqual([])
    await setSubscriptions(w.ipcEvent('subframe-token'), { keys: keys2, userId: USER_A })
    expect(sent()).toEqual([])
    // A frame Electron already disposed has no URL either: refused as untrusted.
    expect(() =>
      handler('gfsWatch:setSubscriptions')(w.ipcEvent(null), { keys: keys2, userId: USER_A })
    ).toThrow('Untrusted IPC sender')

    await setSubscriptions(w.ipcEvent(), { keys: keys2, userId: USER_A })
    expect(sent()).toEqual(keys2)
    expect(h.client.inspect().owners.size).toBe(1)
  })

  it('T-CB8: a destroyed window and a new one mounting: one stream with the new list', async () => {
    const w1 = new FakeWebContents(251)
    await setSubscriptions(w1.ipcEvent(), { keys: keys1, userId: USER_A })
    const getsBefore = h.server.gets.length
    w1.destroy()
    await h.settle()
    const w2 = new FakeWebContents(252)
    await setSubscriptions(w2.ipcEvent(), { keys: keys2, userId: USER_A })
    expect(h.server.gets.length).toBe(getsBefore)
    expect(h.server.openStreams()).toHaveLength(1)
    expect(h.server.current()?.keys).toEqual(new Set(keys2))
  })

  it('answers sessionExpired to a window mounted after a terminal', async () => {
    const w1 = new FakeWebContents(261)
    await setSubscriptions(w1.ipcEvent(), { keys: keys1, userId: USER_A })
    h.server.frame({ type: 'stream.closing', reason: 'session_expired' })
    await h.settle()
    expect(w1.events()).toContainEqual({ type: 'sessionExpired' })
    const w2 = new FakeWebContents(262)
    expect(await setSubscriptions(w2.ipcEvent(), { keys: [], userId: USER_A })).toEqual({
      sessionExpired: true,
    })
  })
})
