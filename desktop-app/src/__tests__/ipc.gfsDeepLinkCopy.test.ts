import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AppService } from '../appService.js'
import { buildGfsResourceWebLink } from '../gfsDeepLinks.js'

type Handler = (event: unknown, payload: unknown) => Promise<unknown>

const electron = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  writeText: vi.fn(async () => undefined),
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
  getSessionGeneration: () => 1,
  copyGfsResourceDeepLink: vi.fn(
    async (
      _uri: string,
      writeClipboard: (url: string) => void,
      _expectedSessionGeneration: number
    ) => {
      await writeClipboard(sharedUrl)
      return { url: sharedUrl }
    }
  ),
  copyGfsResourceId: vi.fn(
    async (
      resourceId: string,
      writeClipboard: (value: string) => void,
      _expectedSessionGeneration: number
    ) => {
      await writeClipboard(resourceId)
      return { resourceId }
    }
  ),
}
const trusted = { senderFrame: { url: 'file:///app/index.html' } }

function copyHandler(): Handler {
  const handler = electron.handlers.get('gfs:copyDeepLink')
  if (!handler) throw new Error('gfs:copyDeepLink handler was not registered')
  return handler
}

function copyResourceIdHandler(): Handler {
  const handler = electron.handlers.get('gfs:copyResourceId')
  if (!handler) throw new Error('gfs:copyResourceId handler was not registered')
  return handler
}

beforeAll(async () => {
  const { registerIpcHandlers } = await import('../ipc.js')
  registerIpcHandlers(service as unknown as AppService, async () => 0)
})

afterEach(() => {
  service.copyGfsResourceDeepLink.mockClear()
  service.copyGfsResourceId.mockClear()
  electron.writeText.mockClear()
})

describe('gfs:copyResourceId trusted clipboard handoff', () => {
  it('copies the exact URI through the main-process session owner', async () => {
    await expect(
      copyResourceIdHandler()(trusted, { uri: ` ${uri} `, expectedSessionGeneration: 1 })
    ).resolves.toEqual({ resourceId: uri })

    expect(service.copyGfsResourceId).toHaveBeenCalledOnce()
    expect(service.copyGfsResourceId.mock.calls[0]?.[0]).toBe(uri)
    expect(service.copyGfsResourceId.mock.calls[0]?.[1]).toBeTypeOf('function')
    expect(service.copyGfsResourceId.mock.calls[0]?.[2]).toBe(1)
    expect(electron.writeText).toHaveBeenCalledOnce()
    expect(electron.writeText).toHaveBeenCalledWith(uri)
  })

  it('rejects untrusted senders and invalid generations before clipboard access', async () => {
    await expect(
      copyResourceIdHandler()(
        { senderFrame: { url: 'https://untrusted.example' } },
        { uri, expectedSessionGeneration: 1 }
      )
    ).rejects.toThrow('Untrusted IPC sender')
    await expect(copyResourceIdHandler()(trusted, { uri })).rejects.toThrow(
      'invalid_session_generation'
    )

    expect(service.copyGfsResourceId).not.toHaveBeenCalled()
    expect(electron.writeText).not.toHaveBeenCalled()
  })
})

describe('gfs:copyDeepLink trusted clipboard handoff', () => {
  it('creates and copies the producer URL for the exact canonical resource', async () => {
    await expect(
      copyHandler()(trusted, { uri: ` ${uri} `, expectedSessionGeneration: 1 })
    ).resolves.toEqual({ url: sharedUrl })

    expect(service.copyGfsResourceDeepLink).toHaveBeenCalledOnce()
    expect(service.copyGfsResourceDeepLink.mock.calls[0]?.[0]).toBe(uri)
    expect(service.copyGfsResourceDeepLink.mock.calls[0]?.[1]).toBeTypeOf('function')
    expect(service.copyGfsResourceDeepLink.mock.calls[0]?.[2]).toBe(1)
    expect(electron.writeText).toHaveBeenCalledOnce()
    expect(electron.writeText).toHaveBeenCalledWith(sharedUrl)
  })

  it('does not report success until a pending clipboard write settles', async () => {
    let settleWrite: (() => void) | undefined
    electron.writeText.mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          settleWrite = () => resolve()
        })
    )

    let settled = false
    const result = copyHandler()(trusted, { uri, expectedSessionGeneration: 1 }).then(value => {
      settled = true
      return value
    })

    await vi.waitFor(() => expect(electron.writeText).toHaveBeenCalledOnce())
    expect(settled).toBe(false)
    if (!settleWrite) throw new Error('clipboard write did not start')
    settleWrite()
    await expect(result).resolves.toEqual({ url: sharedUrl })
    expect(settled).toBe(true)
    expect(service.copyGfsResourceDeepLink).toHaveBeenCalledOnce()
    expect(service.copyGfsResourceDeepLink.mock.calls[0]?.[0]).toBe(uri)
    expect(service.copyGfsResourceDeepLink.mock.calls[0]?.[2]).toBe(1)
    expect(electron.writeText).toHaveBeenCalledWith(sharedUrl)
  })

  it('propagates a clipboard write failure instead of reporting success', async () => {
    electron.writeText.mockRejectedValueOnce(new Error('clipboard unavailable'))

    await expect(copyHandler()(trusted, { uri, expectedSessionGeneration: 1 })).rejects.toThrow(
      'clipboard unavailable'
    )

    expect(service.copyGfsResourceDeepLink).toHaveBeenCalledOnce()
    expect(service.copyGfsResourceDeepLink.mock.calls[0]?.[0]).toBe(uri)
    expect(service.copyGfsResourceDeepLink.mock.calls[0]?.[2]).toBe(1)
    expect(electron.writeText).toHaveBeenCalledOnce()
    expect(electron.writeText).toHaveBeenCalledWith(sharedUrl)
  })

  it('rejects untrusted renderer senders before creating or copying a link', async () => {
    await expect(
      copyHandler()(
        { senderFrame: { url: 'https://untrusted.example' } },
        {
          uri,
          expectedSessionGeneration: 1,
        }
      )
    ).rejects.toThrow('Untrusted IPC sender')

    expect(service.copyGfsResourceDeepLink).not.toHaveBeenCalled()
    expect(electron.writeText).not.toHaveBeenCalled()
  })

  it('rejects a missing or non-numeric clicked-row generation', async () => {
    await expect(copyHandler()(trusted, { uri })).rejects.toThrow('invalid_session_generation')
    await expect(copyHandler()(trusted, { uri, expectedSessionGeneration: null })).rejects.toThrow(
      'invalid_session_generation'
    )
    expect(service.copyGfsResourceDeepLink).not.toHaveBeenCalled()
  })
})
