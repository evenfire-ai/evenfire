/**
 * R1-H4 — the preview download ceiling is authoritative in main. The renderer
 * is untrusted: it may request a smaller per-type limit, but a request above
 * GFS_PREVIEW_MAX_BYTES is rejected at the IPC boundary before it reaches the
 * service, instead of being obeyed unbounded.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AppService } from '../appService.js'
import { GFS_PREVIEW_MAX_BYTES } from '../gfs/previewLimits.js'

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
// ipc.ts only uses AppService as a type at registration; the real module would
// pull in the whole main-process graph.
vi.mock('../appService.js', () => ({ AppService: class {} }))

const service = {
  downloadGfsUri: vi.fn(async () => new ArrayBuffer(0)),
}
const trusted = { senderFrame: { url: 'file:///app/index.html' } }
const uri = 'gfs://drive/resource'

function handler(channel: string): Handler {
  const registered = electron.handlers.get(channel)
  if (!registered) throw new Error(`no IPC handler registered for ${channel}`)
  return registered
}

beforeAll(async () => {
  const { registerIpcHandlers } = await import('../ipc.js')
  registerIpcHandlers(service as unknown as AppService)
})

afterEach(() => {
  service.downloadGfsUri.mockClear()
})

describe('gfs:downloadPreview maxBytes ceiling', () => {
  it.each([GFS_PREVIEW_MAX_BYTES + 1, Number.MAX_SAFE_INTEGER])(
    'rejects an over-cap maxBytes (%i) without calling the service',
    async maxBytes => {
      await expect(handler('gfs:downloadPreview')(trusted, { uri, maxBytes })).rejects.toThrow(
        'preview download limit exceeds the allowed maximum'
      )
      expect(service.downloadGfsUri).not.toHaveBeenCalled()
    }
  )

  it.each([
    ['at the ceiling', GFS_PREVIEW_MAX_BYTES],
    ['a smaller per-type limit (image, 10 MiB)', 10 * 1024 * 1024],
  ])('forwards %s to the service', async (_label, maxBytes) => {
    await handler('gfs:downloadPreview')(trusted, { uri, maxBytes })
    expect(service.downloadGfsUri).toHaveBeenCalledWith(uri, maxBytes)
  })
})
