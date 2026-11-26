/**
 * Workflow run cancel across the Electron boundary: the preload exposes
 * `workflows.cancelRun(ns, name, runId)` on the `workflows:cancelRun` channel, and
 * the main process handles that channel by calling the service with the same run.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AppService } from '../appService.js'

type Handler = (event: unknown, payload: unknown) => Promise<unknown>

const electron = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn(),
}))

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
  contextBridge: { exposeInMainWorld: electron.exposeInMainWorld },
  ipcRenderer: { invoke: electron.invoke, off: vi.fn(), on: vi.fn() },
  webUtils: { getPathForFile: vi.fn() },
}))
// ipc.ts only uses AppService as a type at registration; the real module would
// pull in the whole main-process graph.
vi.mock('../appService.js', () => ({ AppService: class {} }))

const CANCEL_RESULT = { run: { id: 'run-1', phase: 'Running' } }
const service = {
  cancelWorkflowRun: vi.fn(async () => CANCEL_RESULT),
}
const trusted = { senderFrame: { url: 'file:///app/index.html' } }
const untrusted = { senderFrame: { url: 'https://attacker.example.test/' } }

function handler(channel: string): Handler {
  const registered = electron.handlers.get(channel)
  if (!registered) throw new Error(`no IPC handler registered for ${channel}`)
  return registered
}

beforeAll(async () => {
  const { registerIpcHandlers } = await import('../ipc.js')
  registerIpcHandlers(service as unknown as AppService, async () => 0)
})

afterEach(() => {
  service.cancelWorkflowRun.mockClear()
  electron.invoke.mockReset()
})

describe('workflows:cancelRun', () => {
  it('the preload exposes workflows.cancelRun on the workflows:cancelRun channel', async () => {
    electron.invoke.mockResolvedValue(CANCEL_RESULT)
    await import('../preload.js')
    const exposed = electron.exposeInMainWorld.mock.calls.find(
      ([name]) => name === 'clerum'
    )?.[1] as { workflows: typeof window.clerum.workflows }
    expect(exposed).toBeTruthy()

    await expect(exposed.workflows.cancelRun('sandbox-recipes', 'two-step', 'run-1')).resolves.toBe(
      CANCEL_RESULT
    )

    expect(electron.invoke.mock.calls).toEqual([
      ['workflows:cancelRun', { ns: 'sandbox-recipes', name: 'two-step', runId: 'run-1' }],
    ])
  })

  it('the main process handles the channel by cancelling that run through the service', async () => {
    await expect(
      handler('workflows:cancelRun')(trusted, {
        ns: ' sandbox-recipes ',
        name: 'two-step',
        runId: 'run-1',
      })
    ).resolves.toBe(CANCEL_RESULT)

    expect(service.cancelWorkflowRun).toHaveBeenCalledTimes(1)
    expect(service.cancelWorkflowRun).toHaveBeenCalledWith('sandbox-recipes', 'two-step', 'run-1')
  })

  it('refuses an untrusted sender and a missing run id without calling the service', async () => {
    const cancel = handler('workflows:cancelRun')
    await expect(
      cancel(untrusted, { ns: 'sandbox-recipes', name: 'two-step', runId: 'run-1' })
    ).rejects.toThrow('Untrusted IPC sender')
    await expect(
      cancel(trusted, { ns: 'sandbox-recipes', name: 'two-step', runId: '  ' })
    ).rejects.toThrow('ns, name, and runId are required')
    expect(service.cancelWorkflowRun).not.toHaveBeenCalled()

    // Liveness witness: the same handler does reach the service for a valid request.
    await cancel(trusted, { ns: 'sandbox-recipes', name: 'two-step', runId: 'run-1' })
    expect(service.cancelWorkflowRun).toHaveBeenCalledTimes(1)
  })
})
