import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AppService } from '../appService.js'
import { buildGfsResourceWebLink } from '../gfsDeepLinks.js'

type Handler = (event: unknown, payload: unknown) => Promise<unknown>

const electron = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  writeText: vi.fn(),
}))

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: vi.fn(), getAllWindows: vi.fn(() => []) },
  Notification: vi.fn(),
  app: { on: vi.fn(), getPath: vi.fn(), getVersion: vi.fn() },
  clipboard: { writeText: electron.writeText },
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
const sharedUrl = buildGfsResourceWebLink('https://profile.example', uri)
const service = {
  createGfsResourceDeepLink: vi.fn(async () => ({ url: sharedUrl })),
}
const trusted = { senderFrame: { url: 'file:///app/index.html' } }

function copyHandler(): Handler {
  const handler = electron.handlers.get('gfs:copyDeepLink')
  if (!handler) throw new Error('gfs:copyDeepLink handler was not registered')
  return handler
}

beforeAll(async () => {
  const { registerIpcHandlers } = await import('../ipc.js')
  registerIpcHandlers(service as unknown as AppService, async () => 0)
})

afterEach(() => {
  service.createGfsResourceDeepLink.mockClear()
  electron.writeText.mockClear()
})

describe('gfs:copyDeepLink trusted clipboard handoff', () => {
  it('creates and copies the producer URL for the exact canonical resource', async () => {
    await expect(copyHandler()(trusted, { uri: ` ${uri} ` })).resolves.toEqual({ url: sharedUrl })

    expect(service.createGfsResourceDeepLink).toHaveBeenCalledOnce()
    expect(service.createGfsResourceDeepLink).toHaveBeenCalledWith(uri)
    expect(electron.writeText).toHaveBeenCalledOnce()
    expect(electron.writeText).toHaveBeenCalledWith(sharedUrl)
  })

  it('rejects untrusted renderer senders before creating or copying a link', async () => {
    await expect(
      copyHandler()({ senderFrame: { url: 'https://untrusted.example' } }, { uri })
    ).rejects.toThrow('Untrusted IPC sender')

    expect(service.createGfsResourceDeepLink).not.toHaveBeenCalled()
    expect(electron.writeText).not.toHaveBeenCalled()
  })
})
