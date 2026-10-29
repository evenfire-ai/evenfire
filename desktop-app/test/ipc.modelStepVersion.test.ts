import { beforeEach, describe, expect, it, vi } from 'vitest'
import { registerIpcHandlers } from '../src/ipc.js'

const testState = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  return {
    handlers,
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    }),
  }
})

vi.mock('electron', () => ({ ipcMain: { handle: testState.handle, on: vi.fn() } }))

describe('rpc:continueModelStep version validation', () => {
  const service = { continueModelStep: vi.fn() }
  const event = { senderFrame: { url: 'file:///index.html' } }
  const payload = {
    hostRef: 'chatllm',
    agent: 'chatllm',
    chatId: 'c1',
    checkpointId: 'msc_01J9Z7Q4R2M3N5P6Q7R8S9T0V1',
    version: 1,
  }

  beforeEach(() => {
    testState.handlers.clear()
    vi.clearAllMocks()
    registerIpcHandlers(service as never)
  })

  it('rejects version zero and forwards a positive version', async () => {
    const handler = testState.handlers.get('rpc:continueModelStep')
    expect(handler).toBeDefined()
    await expect(handler?.(event, { ...payload, version: 0 })).rejects.toThrow(
      'version must be a non-negative integer greater than zero'
    )
    expect(service.continueModelStep).not.toHaveBeenCalled()

    service.continueModelStep.mockResolvedValueOnce({ outcome: 'claimed' })
    await expect(handler?.(event, payload)).resolves.toEqual({ outcome: 'claimed' })
    expect(service.continueModelStep).toHaveBeenCalledExactlyOnceWith(
      payload.hostRef,
      payload.agent,
      payload.chatId,
      payload.checkpointId,
      1
    )
  })
})
