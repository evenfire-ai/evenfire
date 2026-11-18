import { afterAll, describe, expect, it, vi } from 'vitest'

const order = vi.hoisted(() => [] as string[])
const captured = vi.hoisted(() => ({ shutdown: null as null | (() => Promise<void>) }))

// Boot parks on the schema check, so main.ts registers its shutdown and
// opens nothing else.
vi.mock('../src/db.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/db.js')>()),
  assertDbReady: () => new Promise<never>(() => {}),
}))

// The process module owns the watch pool; it is the boundary whose closer
// the shutdown must reach.
vi.mock('../src/services/gfsWatch/process.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/services/gfsWatch/process.js')>()),
  closeGfsWatchPool: vi.fn(async () => {
    order.push('watch-pool')
  }),
}))

// Wraps the real handler only to reach the shutdown main.ts builds.
vi.mock('../src/shutdown.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/shutdown.js')>()
  return {
    ...actual,
    createShutdownHandler: (run: () => Promise<void>) =>
      (captured.shutdown = actual.createShutdownHandler(run)),
  }
})

const signalListenersBefore = {
  SIGTERM: process.listeners('SIGTERM'),
  SIGINT: process.listeners('SIGINT'),
}
const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
const db = await import('../src/db.js')
vi.spyOn(db.pool, 'end').mockImplementation((async () => {
  order.push('core-pool')
}) as never)
vi.spyOn(db.rateLimitPool, 'end').mockImplementation((async () => {
  order.push('rate-limit-pool')
}) as never)
const watchProcess = await import('../src/services/gfsWatch/process.js')
await import('../src/main.js')

afterAll(() => {
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    for (const l of process.listeners(signal)) {
      if (!signalListenersBefore[signal].includes(l)) process.off(signal, l)
    }
  }
  exit.mockRestore()
  vi.restoreAllMocks()
})

describe('control-api process shutdown of the GFS watch pool', () => {
  it('ends the watch pool through its closer, before the core and rate-limit pools', async () => {
    expect(captured.shutdown).not.toBeNull()
    // A boot that failed before parking would already have run this same
    // shutdown through its fatal path, and the order below would still hold.
    expect(exit).not.toHaveBeenCalled()
    expect(order).toEqual([])

    await captured.shutdown!()

    expect(watchProcess.closeGfsWatchPool).toHaveBeenCalledOnce()
    expect(order).toEqual(['watch-pool', 'core-pool', 'rate-limit-pool'])
    expect(exit).toHaveBeenCalledOnce()
  })
})
