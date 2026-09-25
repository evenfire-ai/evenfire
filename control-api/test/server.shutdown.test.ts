import { describe, expect, it, vi } from 'vitest'
import { ControlApiServer } from '../src/server.js'

describe('ControlApiServer shutdown idempotency', () => {
  it('makes concurrent stop callers await the same HTTP close operation', async () => {
    let finishClose!: () => void
    const httpServer = {
      close: vi.fn((callback: () => void) => {
        finishClose = callback
      }),
      closeAllConnections: vi.fn(),
    }
    const server = new ControlApiServer({} as never, 0) as any
    server.httpServer = httpServer

    const first = server.stop()
    const second = server.stop()
    let secondFinished = false
    void second.then(() => {
      secondFinished = true
    })
    await Promise.resolve()

    expect(httpServer.close).toHaveBeenCalledOnce()
    expect(secondFinished).toBe(false)
    finishClose()
    await Promise.all([first, second])
    expect(secondFinished).toBe(true)
  })
})
