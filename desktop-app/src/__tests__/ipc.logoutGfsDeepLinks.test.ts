import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AppService } from '../appService.js'
import { buildGfsResourceDeepLink, parseGfsResourceDeepLink } from '../gfsDeepLinks.js'
import {
  GfsResourceDeepLinkQueue,
  createLogoutWithGfsResourceDeepLinkClear,
} from '../gfsResourceDeepLinkQueue.js'

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

const queue = new GfsResourceDeepLinkQueue()
const service = { logout: vi.fn(async () => 7) }
const logoutWithQueueCleanup = createLogoutWithGfsResourceDeepLinkClear(queue, () =>
  service.logout()
)
const trusted = { senderFrame: { url: 'file:///app/index.html' } }

function producedTarget(uri: string) {
  const target = parseGfsResourceDeepLink(buildGfsResourceDeepLink(uri))
  if (!target) throw new Error('The shared producer rejected the GFS resource URI fixture')
  return target
}

function handler(channel: string): Handler {
  const registered = electron.handlers.get(channel)
  if (!registered) throw new Error(`no IPC handler registered for ${channel}`)
  return registered
}

beforeAll(async () => {
  const { registerIpcHandlers } = await import('../ipc.js')
  registerIpcHandlers(service as unknown as AppService, logoutWithQueueCleanup)
})

afterEach(() => {
  queue.clear()
  service.logout.mockClear()
})

describe('auth:logout GFS deep-link queue cleanup', () => {
  it('clears user A before logout and accepts user B links afterward', async () => {
    const userALink = queue.enqueue(producedTarget('gfs://main/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'))

    const result = await handler('auth:logout')(trusted, undefined)

    expect(service.logout).toHaveBeenCalledOnce()
    expect(result).toEqual({ ok: true, sessionGeneration: 7 })
    expect(queue.list()).toEqual([])
    const userBLink = queue.enqueue(producedTarget('gfs://main/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'))
    expect(userBLink.id).toBeGreaterThan(userALink.id)
    expect(queue.list()).toEqual([userBLink])
  })

  it('keeps the trusted-sender boundary ahead of queue cleanup', async () => {
    const pending = queue.enqueue(producedTarget('gfs://main/cccccccccccccccccccccccccccccccc'))

    await expect(
      handler('auth:logout')({ senderFrame: { url: 'https://untrusted.example' } }, undefined)
    ).rejects.toThrow('Untrusted IPC sender')

    expect(queue.list()).toEqual([pending])
    expect(service.logout).not.toHaveBeenCalled()
  })

  it('clears links activated before the asynchronous logout finishes', async () => {
    let finishLogout!: () => void
    service.logout.mockImplementationOnce(
      () =>
        new Promise<number>(resolve => {
          finishLogout = () => resolve(8)
        })
    )
    queue.enqueue(producedTarget('gfs://main/dddddddddddddddddddddddddddddddd'))

    const logoutOperation = handler('auth:logout')(trusted, undefined)
    const duringLogout = queue.enqueue(
      producedTarget('gfs://main/eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee')
    )
    expect(queue.list()).toEqual([duringLogout])

    finishLogout()
    await expect(logoutOperation).resolves.toEqual({ ok: true, sessionGeneration: 8 })
    expect(queue.list()).toEqual([])
    expect(service.logout).toHaveBeenCalledOnce()

    const afterLogout = queue.enqueue(producedTarget('gfs://main/ffffffffffffffffffffffffffffffff'))
    expect(queue.list()).toEqual([afterLogout])
  })
})
