/**
 * R1-H2 — an optionally bounded 'gfs:download' is validated in main. The
 * renderer (folder-zip walk) may request a per-transfer bound up to
 * GFS_DOWNLOAD_MAX_BYTES_CEILING; a larger or invalid bound is rejected at the
 * IPC boundary before it reaches the service, and an absent bound keeps the
 * save-to-disk path uncapped.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AppService } from '../appService.js'
import { GFS_DOWNLOAD_MAX_BYTES_CEILING } from '../gfs/downloadLimits.js'

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
  if (!registered) throw new Error(`no handler registered for ${channel}`)
  return registered
}

describe('gfs:download maxBytes boundary (R1-H2)', () => {
  beforeAll(async () => {
    vi.mocked(await import('../appService.js'))
    const { registerIpcHandlers } = await import('../ipc.js')
    registerIpcHandlers(service as unknown as AppService)
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('passes a within-ceiling bound through to the service', async () => {
    await handler('gfs:download')(trusted, { uri, maxBytes: 1024 })
    expect(service.downloadGfsUri).toHaveBeenCalledWith(uri, 1024)
  })

  it('stays uncapped when no bound is requested', async () => {
    await handler('gfs:download')(trusted, { uri })
    expect(service.downloadGfsUri).toHaveBeenCalledWith(uri, undefined)
  })

  it('rejects a bound above the ceiling before reaching the service', async () => {
    await expect(
      handler('gfs:download')(trusted, { uri, maxBytes: GFS_DOWNLOAD_MAX_BYTES_CEILING + 1 })
    ).rejects.toThrow('download limit exceeds the allowed maximum')
    expect(service.downloadGfsUri).not.toHaveBeenCalled()
  })

  it('rejects an invalid bound instead of silently ignoring it', async () => {
    await expect(handler('gfs:download')(trusted, { uri, maxBytes: 0 })).rejects.toThrow(
      'Invalid maxBytes'
    )
    await expect(handler('gfs:download')(trusted, { uri, maxBytes: 'big' })).rejects.toThrow(
      'Invalid maxBytes'
    )
    expect(service.downloadGfsUri).not.toHaveBeenCalled()
  })
})
