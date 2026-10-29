import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
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

const trusted = { senderFrame: { url: 'file:///app/index.html' } }
const service = {
  getSessionGeneration: vi.fn(() => 7),
  moveGfsResource: vi.fn(async () => ({ resourceId: 'source-a', version: 9 })),
}

function moveHandler(): Handler {
  const handler = electron.handlers.get('gfs:moveResource')
  if (!handler) throw new Error('gfs:moveResource handler was not registered')
  return handler
}

beforeAll(async () => {
  const { registerIpcHandlers } = await import('../ipc.js')
  registerIpcHandlers(service as unknown as AppService, async () => 0)
})

afterEach(() => service.moveGfsResource.mockClear())

describe('gfs:moveResource generation boundary', () => {
  it('forwards the captured generation and exact Move request through trusted IPC', async () => {
    await moveHandler()(trusted, {
      resourceId: ' source-a ',
      destinationId: ' destination-b ',
      expectedSessionGeneration: 7,
      drive: 'main',
      ifMatch: 8,
      newName: 'notes (1).txt',
    })

    expect(service.moveGfsResource).toHaveBeenCalledOnce()
    expect(service.moveGfsResource).toHaveBeenCalledWith(
      'source-a',
      'destination-b',
      7,
      'main',
      8,
      'notes (1).txt'
    )
  })

  it('rejects an invalid expected generation before calling AppService', async () => {
    await expect(
      moveHandler()(trusted, {
        resourceId: 'source-a',
        destinationId: 'destination-b',
        expectedSessionGeneration: Number.MAX_SAFE_INTEGER + 1,
        drive: 'main',
      })
    ).rejects.toThrow('invalid_session_generation')

    expect(service.moveGfsResource).not.toHaveBeenCalled()
  })
})
