import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { AppService } from '../appService.js'

type Handler = (event: any, payload: unknown) => unknown

const electron = vi.hoisted(() => ({ handlers: new Map<string, Handler>() }))

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: vi.fn(), getAllWindows: vi.fn(() => []) },
  Notification: vi.fn(),
  app: { on: vi.fn(), getPath: vi.fn(), getVersion: vi.fn() },
  clipboard: { writeText: vi.fn() },
  dialog: { showSaveDialog: vi.fn() },
  ipcMain: {
    handle: vi.fn((channel: string, handler: Handler) => electron.handlers.set(channel, handler)),
    on: vi.fn(),
    removeHandler: vi.fn(),
  },
}))
vi.mock('../appService.js', () => ({ AppService: class {} }))

const binding = {
  requestId: 'tab-a:close-1',
  tabId: 'tab-a',
  sessionGeneration: 9,
  ownerIdentities: ['owner-a'],
}
const destroyedListeners = new Map<string, () => void>()
const sender = {
  id: 17,
  senderFrame: { url: 'file:///app/index.html' },
  once: vi.fn((event: string, listener: () => void) => destroyedListeners.set(event, listener)),
}
const service = {
  authorizeMarkdownTabClose: vi.fn(() => 'granted'),
  getMarkdownTabClosePermitStatus: vi.fn(() => 'granted'),
  cancelMarkdownTabClosePermit: vi.fn(() => 'granted'),
  consumeMarkdownTabClosePermit: vi.fn(() => 'consumed'),
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
      }) as never
  )
})

describe('Markdown close request IPC binding', () => {
  it('binds each lifecycle operation to the trusted sender WebContents and exact request', () => {
    const event = { senderFrame: sender.senderFrame, sender }

    expect(handler('auth:authorizeMarkdownTabClose')(event, binding)).toBe('granted')
    expect(handler('auth:getMarkdownTabClosePermitStatus')(event, binding)).toBe('granted')
    expect(handler('auth:cancelMarkdownTabClosePermit')(event, binding)).toBe('granted')
    expect(handler('auth:consumeMarkdownTabClosePermit')(event, binding)).toBe('consumed')

    expect(service.authorizeMarkdownTabClose).toHaveBeenCalledWith(sender.id, binding)
    expect(service.getMarkdownTabClosePermitStatus).toHaveBeenCalledWith(sender.id, binding)
    expect(service.cancelMarkdownTabClosePermit).toHaveBeenCalledWith(sender.id, binding)
    expect(service.consumeMarkdownTabClosePermit).toHaveBeenCalledWith(sender.id, binding)
    expect(sender.once).toHaveBeenCalledWith('destroyed', expect.any(Function))

    destroyedListeners.get('destroyed')?.()
    expect(service.clearMarkdownTabCloseRequests).toHaveBeenCalledWith(sender.id)
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
    expect(service.authorizeMarkdownTabClose).toHaveBeenCalledTimes(1)
    expect(service.getMarkdownTabClosePermitStatus).toHaveBeenCalledTimes(1)
  })

  it('rejects malformed owner identity bindings at the IPC boundary', () => {
    expect(() =>
      handler('auth:authorizeMarkdownTabClose')(
        { sender, senderFrame: sender.senderFrame },
        { ...binding, ownerIdentities: 'owner-a' }
      )
    ).toThrow('Invalid Markdown tab close binding')
    expect(service.authorizeMarkdownTabClose).toHaveBeenCalledTimes(1)
  })
})
