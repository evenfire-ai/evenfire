import { afterEach, describe, expect, it, vi } from 'vitest'
import { once } from 'node:events'
import { request as httpRequest } from 'node:http'
import { Server as NetServer } from 'node:net'
import type { AddressInfo } from 'node:net'

const order = vi.hoisted(() => [] as string[])

// The process module owns the LISTEN client and the watch pool; it is the
// boundary this test replaces so the boot opens no database connection.
vi.mock('../src/services/gfsWatch/process.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/services/gfsWatch/process.js')>()),
  startGfsWatchProcess: vi.fn(() => order.push('start-gfs-watch-process')),
  stopGfsWatchRegistry: vi.fn(),
}))

const { ControlApiServer } = await import('../src/server.js')
const { MockGateway } = await import('./mockGateway.js')
const watchProcess = await import('../src/services/gfsWatch/process.js')

describe('ControlApiServer boot of the GFS watch', () => {
  const listen = NetServer.prototype.listen
  let server: InstanceType<typeof ControlApiServer> | null = null

  afterEach(async () => {
    NetServer.prototype.listen = listen
    await server?.stop()
    server = null
    order.length = 0
  })

  it('starts the watch process once, before the HTTP server accepts connections', async () => {
    let bound: NetServer | null = null
    NetServer.prototype.listen = function (this: NetServer, ...args: unknown[]) {
      order.push('listen')
      bound = this
      return (listen as (...a: unknown[]) => NetServer).apply(this, args)
    } as typeof listen
    server = new ControlApiServer(new MockGateway('mcp-server') as never, 0)

    await server.start()

    expect(watchProcess.startGfsWatchProcess).toHaveBeenCalledOnce()
    expect(order).toEqual(['start-gfs-watch-process', 'listen'])
    // The server that start() resolved on is the one serving: a request reaches it.
    const port = ((bound as NetServer | null)!.address() as AddressInfo).port
    const req = httpRequest({ host: '127.0.0.1', port, path: '/health', method: 'GET' })
    req.end()
    const [res] = (await once(req, 'response')) as [import('node:http').IncomingMessage]
    res.resume()
    expect(res.statusCode).toBe(200)
  })
})
