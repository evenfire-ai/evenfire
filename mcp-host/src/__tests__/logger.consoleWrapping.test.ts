import { type Mock, describe, expect, it, vi } from 'vitest'

type StructuredEntry = {
  timestamp: string
  level: string
  msg: string
}

type ConsoleSinks = {
  log: Mock
  error: Mock
  warn: Mock
}

function createConsole(): { console: Console; sinks: ConsoleSinks } {
  const sinks = { log: vi.fn(), error: vi.fn(), warn: vi.fn() }
  const console = { log: sinks.log, error: sinks.error, warn: sinks.warn }
  return { console: console as unknown as Console, sinks }
}

function entries(sink: Mock): StructuredEntry[] {
  return sink.mock.calls.map(([line]) => JSON.parse(String(line)) as StructuredEntry)
}

describe('logger console wrapping', () => {
  it('reuses writers across module re-evaluation and console replacement', async () => {
    const originalConsole = console
    const first = createConsole()
    const replacement = createConsole()

    try {
      globalThis.console = first.console
      vi.resetModules()
      const firstModule = await import('../logger')
      console.log('[LoggerRegression] first direct')
      firstModule.logger.error({}, '[LoggerRegression] first explicit')

      vi.resetModules()
      const reloadedModule = await import('../logger')
      console.warn('[LoggerRegression] reloaded direct')
      reloadedModule.logger.info({}, '[LoggerRegression] reloaded explicit')

      globalThis.console = replacement.console
      vi.resetModules()
      const replacementModule = await import('../logger')
      console.error('[LoggerRegression] replacement direct')
      replacementModule.logger.warn({}, '[LoggerRegression] replacement explicit')
    } finally {
      globalThis.console = originalConsole
    }

    expect(entries(first.sinks.log)).toEqual([
      expect.objectContaining({
        component: 'LoggerRegression',
        level: 'info',
        msg: 'first direct',
      }),
      expect.objectContaining({
        level: 'info',
        msg: '[LoggerRegression] reloaded explicit',
      }),
    ])
    expect(entries(first.sinks.error)).toEqual([
      expect.objectContaining({
        level: 'error',
        msg: '[LoggerRegression] first explicit',
      }),
    ])
    expect(entries(first.sinks.warn)).toEqual([
      expect.objectContaining({
        component: 'LoggerRegression',
        level: 'warn',
        msg: 'reloaded direct',
      }),
    ])

    expect(entries(replacement.sinks.error)).toEqual([
      expect.objectContaining({
        component: 'LoggerRegression',
        level: 'error',
        msg: 'replacement direct',
      }),
    ])
    expect(entries(replacement.sinks.warn)).toEqual([
      expect.objectContaining({
        level: 'warn',
        msg: '[LoggerRegression] replacement explicit',
      }),
    ])
    expect(replacement.sinks.log).not.toHaveBeenCalled()
  })
})
