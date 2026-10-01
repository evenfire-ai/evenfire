import { beforeAll, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { AppService } from '../appService.js'

type Handler = (event: unknown, payload?: unknown) => Promise<unknown>

const electron = vi.hoisted(() => ({ handlers: new Map<string, Handler>() }))

vi.mock('electron', () => ({
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

const service = {
  startEntityChangeStream: vi.fn(),
  stopEntityChangeStreamsForOwner: vi.fn(),
}

function entityChangesStartHandler(): Handler {
  const registered = electron.handlers.get('entityChanges:streamStart')
  if (!registered) throw new Error('no IPC handler registered for entityChanges:streamStart')
  return registered
}

beforeAll(async () => {
  const { registerIpcHandlers } = await import('../ipc.js')
  registerIpcHandlers(service as unknown as AppService)
})

describe('entityChanges:streamStart renderer lifecycle', () => {
  it('releases subscribers only after committed main-frame navigation', async () => {
    const sender = Object.assign(new EventEmitter(), { id: 71, send: vi.fn() })
    const event = { sender, senderFrame: { url: 'file:///app/index.html' } }

    await entityChangesStartHandler()(event)
    expect(service.startEntityChangeStream).toHaveBeenCalledTimes(1)

    sender.emit('did-start-navigation', {}, 'file:///app/child', false, false)
    expect(service.stopEntityChangeStreamsForOwner).not.toHaveBeenCalled()

    // A navigation may be prevented after it starts; an in-place navigation
    // also retains the current document and its stream owner.
    sender.emit('did-start-navigation', {}, 'file:///app/blocked', false, true)
    sender.emit('did-start-navigation', {}, 'file:///app/index.html#tab', true, true)
    expect(service.stopEntityChangeStreamsForOwner).not.toHaveBeenCalled()

    sender.emit('did-navigate', {}, 'file:///app/index.html', 200, 'OK')
    expect(service.stopEntityChangeStreamsForOwner).toHaveBeenCalledTimes(1)
    expect(service.stopEntityChangeStreamsForOwner).toHaveBeenCalledWith(71)

    await entityChangesStartHandler()(event)
    expect(service.startEntityChangeStream).toHaveBeenCalledTimes(2)
    sender.emit('destroyed')
    expect(service.stopEntityChangeStreamsForOwner).toHaveBeenCalledTimes(2)
  })
})
