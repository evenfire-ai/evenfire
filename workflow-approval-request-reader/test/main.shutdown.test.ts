import { afterEach, describe, expect, it, vi } from 'vitest'

const fakeServer = vi.hoisted(() => {
  const server = {
    listen: vi.fn(() => server),
    close: vi.fn(),
  }
  return server
})

vi.mock('../src/server.js', () => ({
  createServer: vi.fn(() => fakeServer),
}))

describe('reader shutdown', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('drops pending decision retries when the process is asked to stop', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const handlers = new Map<string, () => void>()
    vi.spyOn(process, 'once').mockImplementation(((event: string, listener: () => void) => {
      handlers.set(event, listener)
      return process
    }) as typeof process.once)
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)

    await import('../src/main.js')
    const { decisionAdmissionRetries } = await import('../src/decisionAdmissionRetry.js')
    const runner = vi.fn()
    expect(
      decisionAdmissionRetries.schedule(
        '99999999-8888-7777-6666-555555555555',
        { providerUserId: 'U123', decision: 'approve' },
        7,
        runner
      )
    ).toBe('scheduled')

    const sigterm = handlers.get('SIGTERM')
    expect(sigterm).toBeTypeOf('function')
    sigterm?.()

    // Witness: the shutdown handler ran and closed the server.
    expect(fakeServer.close).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(runner).not.toHaveBeenCalled()
    expect(decisionAdmissionRetries.size).toBe(0)
    expect(
      decisionAdmissionRetries.schedule(
        '99999999-8888-7777-6666-555555555556',
        { providerUserId: 'U123', decision: 'approve' },
        7,
        vi.fn()
      )
    ).toBe('closed')
    expect(exit).not.toHaveBeenCalled()
  })
})
