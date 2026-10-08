import { afterEach, describe, expect, it, vi } from 'vitest'
import * as net from 'node:net'
import type { AddressInfo } from 'node:net'
import { RPCServer } from '../server'

// The RPC server reports its lifecycle through the service logger (repository
// logging standard), with the error reduced by the logger to name and code.
const logger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}))
vi.mock('../logger', async importOriginal => ({
  ...(await importOriginal<typeof import('../logger')>()),
  logger,
}))

afterEach(() => {
  vi.clearAllMocks()
})

function boundPort(server: RPCServer): number {
  return (server as unknown as { server: { address(): AddressInfo } }).server.address().port
}

describe('RPCServer lifecycle logging', () => {
  it('logs listening and stopped through the service logger', async () => {
    const server = new RPCServer(0)
    await server.start()
    try {
      expect(logger.info).toHaveBeenCalledWith(
        { component: 'Server', port: 0 },
        'RPC server listening'
      )
      // Witness: the logged start is a real bind.
      expect(boundPort(server)).toBeGreaterThan(0)
    } finally {
      await server.stop()
    }
    expect(logger.info).toHaveBeenCalledWith({ component: 'Server' }, 'RPC server stopped')
  })

  it('logs a listen failure through the service logger and rejects with it', async () => {
    // Hold the wildcard address the server binds when given an explicit port.
    const blocker = net.createServer()
    await new Promise<void>(resolve => blocker.listen(0, '::', resolve))
    const { port } = blocker.address() as AddressInfo
    try {
      await expect(new RPCServer(port).start()).rejects.toMatchObject({ code: 'EADDRINUSE' })
      expect(logger.error).toHaveBeenCalledTimes(1)
      const [fields, message] = logger.error.mock.calls[0]
      expect(message).toBe('RPC server error')
      expect(fields).toMatchObject({ component: 'Server', err: { code: 'EADDRINUSE' } })
    } finally {
      await new Promise(resolve => blocker.close(resolve))
    }
  })
})
