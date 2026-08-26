import { afterEach, describe, expect, it, vi } from 'vitest'
import { HostContextLogger } from './logger'

// Capture the single-line JSON entry emitted for a given log call.
function captureEntry(run: (logger: HostContextLogger) => void): Record<string, unknown> {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    run(new HostContextLogger())
    expect(spy).toHaveBeenCalledTimes(1)
    return JSON.parse(spy.mock.calls[0][0] as string) as Record<string, unknown>
  } finally {
    spy.mockRestore()
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('HostContextLogger sanitize', () => {
  it('flattens a bare Error to name and message instead of {}', () => {
    const entry = captureEntry(logger => logger.error('boom', { err: new Error('kaboom') }))
    expect(entry.err).toEqual({ name: 'Error', message: 'kaboom' })
  })

  it('preserves Error.cause one level deep', () => {
    const err = new Error('outer', { cause: new Error('inner') })
    const entry = captureEntry(logger => logger.error('boom', { err }))
    expect(entry.err).toEqual({
      name: 'Error',
      message: 'outer',
      cause: { name: 'Error', message: 'inner' },
    })
  })

  it('recurses a chain of Error.cause', () => {
    const root = new Error('root')
    const mid = new Error('mid', { cause: root })
    const top = new Error('top', { cause: mid })
    const entry = captureEntry(logger => logger.error('boom', { err: top }))
    expect(entry.err).toEqual({
      name: 'Error',
      message: 'top',
      cause: {
        name: 'Error',
        message: 'mid',
        cause: { name: 'Error', message: 'root' },
      },
    })
  })

  it('flattens AggregateError.errors', () => {
    const agg = new AggregateError([new Error('a'), new TypeError('b')], 'many failures')
    const entry = captureEntry(logger => logger.error('boom', { err: agg }))
    expect(entry.err).toMatchObject({
      name: 'AggregateError',
      message: 'many failures',
      errors: [
        { name: 'Error', message: 'a' },
        { name: 'TypeError', message: 'b' },
      ],
    })
  })

  it('bounds AggregateError.errors and records how many were truncated', () => {
    const inners = Array.from({ length: 13 }, (_, i) => new Error(`e${i}`))
    const agg = new AggregateError(inners, 'too many')
    const entry = captureEntry(logger => logger.error('boom', { err: agg }))
    const err = entry.err as { errors: unknown[]; errors_truncated: number }
    expect(err.errors).toHaveLength(10)
    expect(err.errors_truncated).toBe(3)
  })

  it('handles a nested cause on an AggregateError entry', () => {
    const agg = new AggregateError(
      [new Error('wrap', { cause: new Error('deep') })],
      'agg'
    )
    const entry = captureEntry(logger => logger.error('boom', { err: agg }))
    expect(entry.err).toMatchObject({
      name: 'AggregateError',
      errors: [{ name: 'Error', message: 'wrap', cause: { name: 'Error', message: 'deep' } }],
    })
  })

  it('breaks cause cycles instead of recursing forever', () => {
    const a = new Error('a')
    const b = new Error('b')
    ;(a as { cause?: unknown }).cause = b
    ;(b as { cause?: unknown }).cause = a
    const entry = captureEntry(logger => logger.error('boom', { err: a }))
    expect(entry.err).toEqual({
      name: 'Error',
      message: 'a',
      cause: { name: 'Error', message: 'b', cause: '[Circular]' },
    })
  })

  it('redacts sensitive keys on custom Error fields and does not leak stack', () => {
    class AuthError extends Error {
      constructor(
        readonly statusCode: number,
        readonly token: string,
        message: string
      ) {
        super(message)
        this.name = 'AuthError'
      }
    }
    const entry = captureEntry(logger =>
      logger.error('boom', { err: new AuthError(401, 'super-secret', 'denied') })
    )
    expect(entry.err).toEqual({
      name: 'AuthError',
      message: 'denied',
      statusCode: 401,
      token: '[redacted]',
    })
    expect(entry.err).not.toHaveProperty('stack')
  })

  it('preserves a non-Error cause value through normal sanitization', () => {
    const err = new Error('outer', { cause: { detail: 'context', apiKey: 'nope' } })
    const entry = captureEntry(logger => logger.error('boom', { err }))
    expect(entry.err).toEqual({
      name: 'Error',
      message: 'outer',
      cause: { detail: 'context', apiKey: '[redacted]' },
    })
  })
})
