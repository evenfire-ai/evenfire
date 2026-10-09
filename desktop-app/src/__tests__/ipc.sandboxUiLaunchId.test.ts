/**
 * Every per-view sandbox-ui event names the open request that mounted the view.
 * A relaunch of the same app keeps the appRef, so the renderer can only tell a
 * late event from the replaced view apart from the live one by this id. The
 * events are produced by the real `sandboxUi:open` handler: the callbacks it
 * hands to AppService are invoked the way AppService invokes them.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AppService } from '../appService.js'

type Handler = (event: unknown, payload: unknown) => Promise<unknown>

const electron = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  send: vi.fn(),
}))

vi.mock('electron', () => ({
  BrowserWindow: {
    fromWebContents: vi.fn(() => ({
      isDestroyed: () => false,
      webContents: { send: electron.send },
    })),
    getAllWindows: vi.fn(() => []),
  },
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

type OpenArgs = Parameters<AppService['openSandboxUi']>[0]
const opens: OpenArgs[] = []
const service = {
  openSandboxUi: vi.fn(async (args: OpenArgs) => {
    opens.push(args)
  }),
}
const trusted = { senderFrame: { url: 'file:///app/index.html' }, sender: {} }
const bounds = { x: 0, y: 0, width: 400, height: 300 }

function open(payload: Record<string, unknown>) {
  const handler = electron.handlers.get('sandboxUi:open')
  if (!handler) throw new Error('no IPC handler registered for sandboxUi:open')
  return handler(trusted, { recipeNs: 'sandbox-recipes', recipeName: 'alpha', bounds, ...payload })
}

beforeAll(async () => {
  const { registerIpcHandlers } = await import('../ipc.js')
  registerIpcHandlers(service as unknown as AppService)
})

afterEach(() => {
  opens.length = 0
  service.openSandboxUi.mockClear()
  electron.send.mockClear()
})

describe('sandboxUi:open launch id', () => {
  it("tags each view's events with the launch id of the open that mounted it", async () => {
    await open({ launchId: 'launch-1' })
    await open({ launchId: 'launch-2' })
    const [first, second] = opens

    // The replaced view reports after the relaunch of the same app.
    first!.onClosed?.()
    first!.onRefreshError?.('refresh failed')
    first!.onTitleChanged?.('Old title')
    second!.onTitleChanged?.('New title')

    expect(electron.send.mock.calls).toEqual([
      ['sandboxUi:closed', { appRef: 'sandbox-recipes/alpha', launchId: 'launch-1' }],
      [
        'sandboxUi:refreshError',
        { appRef: 'sandbox-recipes/alpha', launchId: 'launch-1', message: 'refresh failed' },
      ],
      [
        'sandboxUi:titleChanged',
        { appRef: 'sandbox-recipes/alpha', launchId: 'launch-1', title: 'Old title' },
      ],
      [
        'sandboxUi:titleChanged',
        { appRef: 'sandbox-recipes/alpha', launchId: 'launch-2', title: 'New title' },
      ],
    ])
  })

  it.each([undefined, '', 42, 'a'.repeat(65), 'has space', '../x', { id: 'x' }])(
    'rejects launch id %j before opening anything',
    async launchId => {
      await expect(open({ launchId })).rejects.toThrow(/launchId/)
      expect(service.openSandboxUi).not.toHaveBeenCalled()
    }
  )

  it('accepts a renderer-minted UUID', async () => {
    const launchId = crypto.randomUUID()
    await open({ launchId })
    opens[0]!.onClosed?.()
    expect(electron.send).toHaveBeenCalledWith('sandboxUi:closed', {
      appRef: 'sandbox-recipes/alpha',
      launchId,
    })
  })
})
