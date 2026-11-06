import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AppService } from '../appService.js'

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

const sharedUrl = 'https://profile.example/apps/open?team=team-1'
const service = {
  createSandboxUiDeepLink: vi.fn(async () => ({ url: sharedUrl })),
}
const trusted = { senderFrame: { url: 'file:///app/index.html' } }

function copyHandler(): Handler {
  const handler = electron.handlers.get('sandboxUi:copyDeepLink')
  if (!handler) throw new Error('sandboxUi:copyDeepLink handler was not registered')
  return handler
}

beforeAll(async () => {
  const { registerIpcHandlers } = await import('../ipc.js')
  registerIpcHandlers(service as unknown as AppService, async () => 0)
})

afterEach(() => {
  service.createSandboxUiDeepLink.mockClear()
  electron.writeText.mockClear()
})

describe('sandboxUi:copyDeepLink trusted clipboard handoff', () => {
  it('creates and copies the producer URL for the sanitized team', async () => {
    await expect(copyHandler()(trusted, { teamId: ' team-1 ' })).resolves.toEqual({
      url: sharedUrl,
    })

    expect(service.createSandboxUiDeepLink).toHaveBeenCalledOnce()
    expect(service.createSandboxUiDeepLink).toHaveBeenCalledWith('team-1')
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
    const result = copyHandler()(trusted, { teamId: 'team-1' }).then(value => {
      settled = true
      return value
    })

    await vi.waitFor(() => expect(electron.writeText).toHaveBeenCalledOnce())
    expect(settled).toBe(false)
    if (!settleWrite) throw new Error('clipboard write did not start')
    settleWrite()
    await expect(result).resolves.toEqual({ url: sharedUrl })
    expect(settled).toBe(true)
    expect(service.createSandboxUiDeepLink).toHaveBeenCalledOnce()
    expect(service.createSandboxUiDeepLink).toHaveBeenCalledWith('team-1')
    expect(electron.writeText).toHaveBeenCalledWith(sharedUrl)
  })

  it('propagates a clipboard write failure instead of reporting success', async () => {
    electron.writeText.mockRejectedValueOnce(new Error('clipboard unavailable'))

    await expect(copyHandler()(trusted, { teamId: 'team-1' })).rejects.toThrow(
      'clipboard unavailable'
    )

    expect(service.createSandboxUiDeepLink).toHaveBeenCalledOnce()
    expect(service.createSandboxUiDeepLink).toHaveBeenCalledWith('team-1')
    expect(electron.writeText).toHaveBeenCalledOnce()
    expect(electron.writeText).toHaveBeenCalledWith(sharedUrl)
  })

  it('rejects untrusted renderer senders before creating or copying a link', async () => {
    await expect(
      copyHandler()({ senderFrame: { url: 'https://untrusted.example' } }, { teamId: 'team-1' })
    ).rejects.toThrow('Untrusted IPC sender')

    expect(service.createSandboxUiDeepLink).not.toHaveBeenCalled()
    expect(electron.writeText).not.toHaveBeenCalled()
  })
})
