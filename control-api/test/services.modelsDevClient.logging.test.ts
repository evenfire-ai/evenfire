/**
 * The vendored fallback must be reported through the service's pino logger: it
 * is the only output that goes through redaction. The root logger is silent in
 * tests, so the child logger is mocked here to observe the call itself.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

const { childLogger, childBindings } = vi.hoisted(() => {
  const childLogger = {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }
  return { childLogger, childBindings: [] as unknown[] }
})

vi.mock('../src/observability/logger.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/observability/logger.js')>()
  return {
    ...actual,
    rootLogger: {
      ...actual.rootLogger,
      child: (bindings: unknown) => {
        childBindings.push(bindings)
        return childLogger
      },
    },
  }
})

const { loadModelsDevCatalog } = await import('../src/services/modelsDevClient.js')

describe('loadModelsDevCatalog — fallback logging', () => {
  afterEach(() => {
    childLogger.warn.mockClear()
  })

  it('warns with the failure reason on the module child logger, never on the console', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const res = await loadModelsDevCatalog({
        fetchImpl: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch,
      })
      expect(res.source).toBe('vendored')
      expect(childBindings).toContainEqual({ module: 'models-dev-client' })
      expect(childLogger.warn).toHaveBeenCalledTimes(1)
      expect(childLogger.warn).toHaveBeenCalledWith(
        { reason: 'ECONNREFUSED' },
        'models.dev live fetch failed; using vendored snapshot'
      )
      expect(consoleWarn).not.toHaveBeenCalled()
    } finally {
      consoleWarn.mockRestore()
    }
  })
})
