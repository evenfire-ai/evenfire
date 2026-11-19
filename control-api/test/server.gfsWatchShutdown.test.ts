import { describe, expect, it, vi } from 'vitest'

const order = vi.hoisted(() => [] as string[])

vi.mock('../src/services/gfsWatch/process.js', () => ({
  startGfsWatchProcess: vi.fn(),
  stopGfsWatchRegistry: vi.fn(() => order.push('stop-gfs-watch-registry')),
}))

const { ControlApiServer } = await import('../src/server.js')

describe('ControlApiServer shutdown of the GFS watch', () => {
  it('closes the watch streams before the HTTP server waits for its open connections', async () => {
    const httpServer = {
      close: vi.fn((callback: () => void) => {
        order.push('http-server-close')
        callback()
      }),
      closeAllConnections: vi.fn(),
    }
    const server = new ControlApiServer({} as never, 0) as unknown as {
      httpServer: typeof httpServer
      stop(): Promise<void>
    }
    server.httpServer = httpServer

    await server.stop()

    expect(order).toEqual(['stop-gfs-watch-registry', 'http-server-close'])
  })
})
