import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppService } from '../appService.js'

type Handler = (event: any, payload: unknown) => unknown

const electron = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  notifications: [] as Array<{
    emit: (...args: unknown[]) => void
    show: ReturnType<typeof vi.fn>
  }>,
  owner: null as Record<string, any> | null,
  canReveal: true,
}))

vi.mock('electron', async () => {
  const { EventEmitter: MockEventEmitter } = await import('node:events')
  class MockNotification extends MockEventEmitter {
    static isSupported = vi.fn(() => true)
    readonly show = vi.fn()
    constructor(readonly options: unknown) {
      super()
      electron.notifications.push(this)
    }
  }
  return {
    BrowserWindow: {
      fromWebContents: vi.fn(() => electron.owner),
      getAllWindows: vi.fn(() => []),
    },
    Notification: MockNotification,
    app: { on: vi.fn(), getPath: vi.fn(), getVersion: vi.fn() },
    clipboard: { writeText: vi.fn() },
    dialog: { showSaveDialog: vi.fn() },
    ipcMain: {
      handle: vi.fn((channel: string, handler: Handler) => electron.handlers.set(channel, handler)),
      on: vi.fn(),
      removeHandler: vi.fn(),
    },
  }
})
vi.mock('../appService.js', () => ({ AppService: class {} }))

const binding = {
  requestId: 'tab-a:close-1',
  documentEpoch: '00000000-0000-4000-8000-000000000042',
  sequence: 1,
  tabId: 'tab-a',
  sessionGeneration: 9,
  ownerIdentities: ['owner-a'],
}
const destroyedListeners = new Map<string, () => void>()
const lifecycleListeners = new Map<string, () => void>()
const sender = {
  id: 17,
  senderFrame: { url: 'file:///app/index.html' },
  mainFrame: null as unknown as object,
  once: vi.fn((event: string, listener: () => void) => destroyedListeners.set(event, listener)),
  on: vi.fn((event: string, listener: () => void) => lifecycleListeners.set(event, listener)),
  removeListener: vi.fn((event: string) => lifecycleListeners.delete(event)),
  isDestroyed: vi.fn(() => false),
  send: vi.fn(),
}
sender.mainFrame = sender.senderFrame
const service = {
  authorizeMarkdownTabClose: vi.fn(() => 'granted'),
  getMarkdownTabClosePermitStatus: vi.fn(() => 'granted'),
  cancelMarkdownTabClosePermit: vi.fn(() => 'granted'),
  consumeMarkdownTabClosePermit: vi.fn(() => 'consumed'),
  acknowledgeMarkdownTabClose: vi.fn(() => 2),
  retireMarkdownTabCloseDocument: vi.fn(),
  clearMarkdownTabCloseRequests: vi.fn(),
}

function handler(channel: string): Handler {
  const current = electron.handlers.get(channel)
  if (!current) throw new Error(`missing IPC handler: ${channel}`)
  return current
}

beforeAll(async () => {
  const { registerIpcHandlers } = await import('../ipc.js')
  registerIpcHandlers(
    service as unknown as AppService,
    async () => 0,
    () =>
      ({
        webContents: sender,
      }) as never,
    () => electron.canReveal
  )
})

beforeEach(() => {
  vi.clearAllMocks()
  electron.notifications.splice(0)
  electron.owner = null
  electron.canReveal = true
})

describe('Markdown close request IPC binding', () => {
  it('binds each lifecycle operation to the trusted sender WebContents and exact request', () => {
    const event = { senderFrame: sender.senderFrame, sender }

    expect(handler('auth:authorizeMarkdownTabClose')(event, binding)).toBe('granted')
    expect(handler('auth:getMarkdownTabClosePermitStatus')(event, binding)).toBe('granted')
    expect(handler('auth:cancelMarkdownTabClosePermit')(event, binding)).toBe('granted')
    expect(handler('auth:consumeMarkdownTabClosePermit')(event, binding)).toBe('consumed')
    expect(handler('auth:acknowledgeMarkdownTabClose')(event, binding)).toBe(2)

    expect(service.authorizeMarkdownTabClose).toHaveBeenCalledWith(sender.id, binding)
    expect(service.getMarkdownTabClosePermitStatus).toHaveBeenCalledWith(sender.id, binding)
    expect(service.cancelMarkdownTabClosePermit).toHaveBeenCalledWith(sender.id, binding)
    expect(service.consumeMarkdownTabClosePermit).toHaveBeenCalledWith(sender.id, binding)
    expect(service.acknowledgeMarkdownTabClose).toHaveBeenCalledWith(sender.id, binding)
    expect(sender.once).toHaveBeenCalledWith('destroyed', expect.any(Function))

    destroyedListeners.get('destroyed')?.()
    expect(service.retireMarkdownTabCloseDocument).toHaveBeenCalledWith(sender.id)
  })

  it('rejects untrusted or non-owning renderers before reaching the service', () => {
    const untrusted = {
      sender,
      senderFrame: { url: 'https://attacker.example/' },
    }
    expect(() => handler('auth:authorizeMarkdownTabClose')(untrusted, binding)).toThrow(
      'Untrusted IPC sender'
    )

    const otherSender = { ...sender, id: 18 }
    expect(() =>
      handler('auth:getMarkdownTabClosePermitStatus')(
        { sender: otherSender, senderFrame: sender.senderFrame },
        binding
      )
    ).toThrow('Markdown tab close requires the owning window')
    expect(service.authorizeMarkdownTabClose).not.toHaveBeenCalled()
    expect(service.getMarkdownTabClosePermitStatus).not.toHaveBeenCalled()
  })

  it('rejects malformed owner identity bindings at the IPC boundary', () => {
    expect(() =>
      handler('auth:authorizeMarkdownTabClose')(
        { sender, senderFrame: sender.senderFrame },
        { ...binding, ownerIdentities: 'owner-a' }
      )
    ).toThrow('Invalid Markdown tab close binding')
    expect(service.authorizeMarkdownTabClose).not.toHaveBeenCalled()
  })

  it('retires the sender document slot on committed navigation and process loss', () => {
    const event = { senderFrame: sender.senderFrame, sender }
    handler('auth:authorizeMarkdownTabClose')(event, binding)
    expect(lifecycleListeners.get('did-navigate')).toBeDefined()
    lifecycleListeners.get('did-navigate')?.()
    expect(service.retireMarkdownTabCloseDocument).toHaveBeenCalledWith(sender.id)
    lifecycleListeners.get('render-process-gone')?.()
    expect(service.retireMarkdownTabCloseDocument).toHaveBeenCalledTimes(2)
  })

  it('rejects stale subframe close IPC before calling AppService', () => {
    expect(() =>
      handler('auth:authorizeMarkdownTabClose')(
        { sender, senderFrame: { url: 'file:///app/iframe.html' } },
        binding
      )
    ).toThrow('current main frame')
    expect(service.authorizeMarkdownTabClose).not.toHaveBeenCalled()
  })

  it('does not reveal or dispatch notification actions to an ineligible owner window', async () => {
    const owner = {
      webContents: sender,
      isDestroyed: vi.fn(() => false),
      isMinimized: vi.fn(() => false),
      restore: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
    }
    electron.owner = owner
    electron.canReveal = false
    const event = { senderFrame: sender.senderFrame, sender }

    await expect(
      handler('notifications:show')(event, {
        id: 'notification-1',
        title: 'Action required',
        actions: [{ title: 'Open', action: 'open' }],
      })
    ).resolves.toMatchObject({ supported: true, id: 'notification-1' })
    const notification = electron.notifications[0]
    if (!notification) throw new Error('IPC did not create a Desktop notification')
    notification.emit('click')
    notification.emit('action', { actionIndex: 0 }, 0)

    expect(owner.restore).not.toHaveBeenCalled()
    expect(owner.show).not.toHaveBeenCalled()
    expect(owner.focus).not.toHaveBeenCalled()
    expect(sender.send).not.toHaveBeenCalled()
  })
})
