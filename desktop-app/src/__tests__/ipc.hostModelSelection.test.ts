/**
 * Issue #654 L1/L2 — the IPC boundary refuses an invalid model-selection
 * revision instead of dropping it. Dropping it would turn a conditional
 * (compare-and-set) write into an unconditional one.
 */
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
// ipc.ts only uses AppService as a type at registration; the real module would
// pull in the whole main-process graph.
vi.mock('../appService.js', () => ({ AppService: class {} }))

const service = {
  setHostModel: vi.fn(async () => ({ effective: 'next-task' })),
  invokeHostMessage: vi.fn(async () => ({ taskId: 'task-1' })),
}
const trusted = { senderFrame: { url: 'file:///app/index.html' } }

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
  service.setHostModel.mockClear()
  service.invokeHostMessage.mockClear()
})

describe('rpc:setHostModel expectedRevision', () => {
  const base = { hostRef: 'agent-x', chatId: 'chat-1', model: 'glm-5.3-flash' }

  it('forwards a valid revision as the CAS base', async () => {
    await handler('rpc:setHostModel')(trusted, { ...base, expectedRevision: 4 })
    expect(service.setHostModel).toHaveBeenCalledWith(
      'agent-x',
      'chat-1',
      'glm-5.3-flash',
      undefined,
      4
    )
  })

  it('forwards an absent revision as absent (hosts without CAS)', async () => {
    await handler('rpc:setHostModel')(trusted, base)
    expect(service.setHostModel).toHaveBeenCalledWith(
      'agent-x',
      'chat-1',
      'glm-5.3-flash',
      undefined,
      undefined
    )
  })

  it.each([1.5, -1, Number.NaN, '3', null])(
    'rejects %s instead of dropping the CAS base',
    async expectedRevision => {
      await expect(
        handler('rpc:setHostModel')(trusted, { ...base, expectedRevision })
      ).rejects.toThrow('expectedRevision must be a non-negative integer')
      expect(service.setHostModel).toHaveBeenCalledTimes(0)
    }
  )
})

describe('rpc:invokeHostMessage model fields', () => {
  const send = (payload: Record<string, unknown>) =>
    handler('rpc:invokeHostMessage')(trusted, {
      hostRef: 'agent-x',
      payload: { content: 'hi', ...payload },
    })

  it('forwards a valid model and revision', async () => {
    await send({ model: 'glm-5.3-flash', modelSelectionRevision: 3 })
    expect(service.invokeHostMessage).toHaveBeenCalledWith(
      'agent-x',
      expect.objectContaining({ model: 'glm-5.3-flash', modelSelectionRevision: 3 }),
      undefined,
      undefined
    )
  })

  it.each([
    [{ modelSelectionRevision: '3' }, 'modelSelectionRevision'],
    [{ modelSelectionRevision: -1 }, 'modelSelectionRevision'],
    [{ modelSelectionRevision: 2.5 }, 'modelSelectionRevision'],
    [{ model: '' }, 'model'],
    [{ model: '   ' }, 'model'],
    [{ model: 7 }, 'model'],
  ])('rejects %o', async (fields, field) => {
    await expect(send(fields)).rejects.toThrow(`Invalid host message request: ${field}`)
    expect(service.invokeHostMessage).toHaveBeenCalledTimes(0)
  })
})
