import { beforeEach, describe, expect, it, vi } from 'vitest'
import { registerIpcHandlers } from '../src/ipc.js'

const testState = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const ipcMainMock = {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    }),
  }
  return { handlers, ipcMainMock }
})

vi.mock('electron', () => ({
  ipcMain: testState.ipcMainMock,
  app: { getPath: () => '/tmp/clerum-test-prewarm' },
}))

function makeTrustedEvent(senderId = 77) {
  return {
    senderFrame: { url: 'file:///index.html' },
    sender: { id: senderId, send: vi.fn(), once: vi.fn() },
  }
}

describe('ipc rpc:prewarmHost handler', () => {
  const service = {
    prewarmHost: vi.fn(),
  }

  beforeEach(() => {
    testState.handlers.clear()
    vi.clearAllMocks()
    registerIpcHandlers(service as never)
  })

  it('forwards sanitized args to the service and passes the structured result through', async () => {
    service.prewarmHost.mockResolvedValue({ requested: false, skipped: 'cooldown' })
    const handler = testState.handlers.get('rpc:prewarmHost')
    expect(handler).toBeDefined()

    const result = await Promise.resolve(
      handler?.(makeTrustedEvent(), { hostRef: '  chatllm  ', hostRefs: [' chatllm ', '', 'b'] })
    )

    expect(service.prewarmHost).toHaveBeenCalledTimes(1)
    expect(service.prewarmHost).toHaveBeenCalledWith('chatllm', ['chatllm', 'b'])
    // Fire-and-forget contract: the structured result reaches the renderer
    // unchanged — never re-shaped or converted into a throw.
    expect(result).toEqual({ requested: false, skipped: 'cooldown' })
  })

  it('rejects an untrusted sender', async () => {
    const handler = testState.handlers.get('rpc:prewarmHost')
    await expect(
      Promise.resolve(
        handler?.(
          {
            senderFrame: { url: 'https://evil.example.com' },
            sender: { id: 1, send: vi.fn(), once: vi.fn() },
          },
          { hostRef: 'chatllm' }
        )
      )
    ).rejects.toThrow('Untrusted IPC sender')
    expect(service.prewarmHost).not.toHaveBeenCalled()
  })

  it('rejects a missing hostRef', async () => {
    const handler = testState.handlers.get('rpc:prewarmHost')
    await expect(
      Promise.resolve(handler?.(makeTrustedEvent(), { hostRef: '   ' }))
    ).rejects.toThrow('hostRef is required')
    expect(service.prewarmHost).not.toHaveBeenCalled()
  })

  it('omits hostRefs when the payload does not carry an array', async () => {
    service.prewarmHost.mockResolvedValue({ requested: true, status: 'active' })
    const handler = testState.handlers.get('rpc:prewarmHost')

    await Promise.resolve(handler?.(makeTrustedEvent(), { hostRef: 'chatllm' }))

    expect(service.prewarmHost).toHaveBeenCalledWith('chatllm', undefined)
  })
})
