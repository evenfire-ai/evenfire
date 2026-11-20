import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { AppService } from '../appService.js'

type Handler = (event: unknown, payload: unknown) => Promise<unknown>

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

const uri = 'gfs://main/0123456789abcdef0123456789abcdef'
const service = {
  resolveGfsUriForNavigation: vi.fn(async () => ({ status: 'superseded' as const })),
}

function handler(): Handler {
  const registered = electron.handlers.get('gfs:resolveForNavigation')
  if (!registered) throw new Error('gfs:resolveForNavigation handler was not registered')
  return registered
}

beforeAll(async () => {
  const { registerIpcHandlers } = await import('../ipc.js')
  registerIpcHandlers(service as unknown as AppService, async () => 0)
})

describe('gfs:resolveForNavigation IPC', () => {
  it('forwards the trimmed URI from a trusted sender and returns the service result', async () => {
    await expect(
      handler()({ senderFrame: { url: 'file:///app/index.html' } }, { uri: ` ${uri} ` })
    ).resolves.toEqual({ status: 'superseded' })
    expect(service.resolveGfsUriForNavigation).toHaveBeenCalledWith(uri)
  })

  it('rejects an untrusted sender before reaching the service', async () => {
    service.resolveGfsUriForNavigation.mockClear()
    await expect(
      handler()({ senderFrame: { url: 'https://evil.example/' } }, { uri })
    ).rejects.toThrow('Untrusted IPC sender')
    expect(service.resolveGfsUriForNavigation).not.toHaveBeenCalled()
  })
})
