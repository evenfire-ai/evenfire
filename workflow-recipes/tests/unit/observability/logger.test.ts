import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiException } from '@kubernetes/client-node'
import { runInNewContext } from 'node:vm'
import { createLogger } from '../../../src/observability/logger'

describe('createLogger', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let stdoutSpy: any

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    delete process.env.CLERUM_CORRELATION_ID
    delete process.env.LOG_LEVEL
    // Force non-test mode for logger output
    process.env.NODE_ENV = 'development'
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
    process.env.NODE_ENV = 'test'
  })

  it('emits valid JSON followed by newline', () => {
    const log = createLogger('wrc', 'test-recipe')
    log.info('test message')
    expect(stdoutSpy).toHaveBeenCalledOnce()
    const written = stdoutSpy.mock.calls[0][0] as string
    expect(() => JSON.parse(written.trimEnd())).not.toThrow()
    expect(written.endsWith('\n')).toBe(true)
  })

  it('log entry contains required fields', () => {
    const log = createLogger('coordinator', 'my-recipe')
    log.info('hello')
    const entry = JSON.parse((stdoutSpy.mock.calls[0][0] as string).trimEnd())
    expect(entry).toMatchObject({
      level: 'info',
      component: 'coordinator',
      recipeName: 'my-recipe',
      msg: 'hello',
    })
    expect(typeof entry.ts).toBe('string')
    expect(new Date(entry.ts).toISOString()).toBe(entry.ts)
  })

  it("correlationId falls back to 'unknown' when env var absent", () => {
    const log = createLogger('wrc', 'r')
    log.info('x')
    const entry = JSON.parse((stdoutSpy.mock.calls[0][0] as string).trimEnd())
    expect(entry.correlationId).toBe('unknown')
  })

  it('correlationId reads from CLERUM_CORRELATION_ID env var', () => {
    process.env.CLERUM_CORRELATION_ID = 'test-corr-id'
    const log = createLogger('wrc', 'r')
    log.info('x')
    const entry = JSON.parse((stdoutSpy.mock.calls[0][0] as string).trimEnd())
    expect(entry.correlationId).toBe('test-corr-id')
  })

  it('withStep child logger includes stepId on every entry', () => {
    const log = createLogger('coordinator', 'r').withStep('fetch-data')
    log.info('step log')
    const entry = JSON.parse((stdoutSpy.mock.calls[0][0] as string).trimEnd())
    expect(entry.stepId).toBe('fetch-data')
  })

  it('withStep child inherits parent correlationId and recipeName', () => {
    process.env.CLERUM_CORRELATION_ID = 'parent-id'
    const child = createLogger('coordinator', 'parent-recipe').withStep('s1')
    child.info('x')
    const entry = JSON.parse((stdoutSpy.mock.calls[0][0] as string).trimEnd())
    expect(entry.correlationId).toBe('parent-id')
    expect(entry.recipeName).toBe('parent-recipe')
  })

  it('error level entries include full error detail when passed', () => {
    const log = createLogger('wrc', 'r')
    log.error('fail', { error: 'something broke', stack: 'line 42' })
    const entry = JSON.parse((stdoutSpy.mock.calls[0][0] as string).trimEnd())
    expect(entry.level).toBe('error')
    expect(entry.error).toBe('something broke')
    expect(entry.stack).toBe('line 42')
  })

  it('additional fields passed to info() appear in JSON output', () => {
    const log = createLogger('mcp_host', 'r')
    log.info('tool called', { toolName: 'fetch_data', durationMs: 340 })
    const entry = JSON.parse((stdoutSpy.mock.calls[0][0] as string).trimEnd())
    expect(entry.toolName).toBe('fetch_data')
    expect(entry.durationMs).toBe(340)
  })

  it('serializes native Error diagnostics and cause into the emitted JSON', () => {
    const cause = new Error('upstream unavailable')
    const err = Object.assign(new TypeError('network policy readback failed', { cause }), {
      code: 503,
    })
    createLogger('wrc', 'r').error('reconcile failed', { err })
    const entry = JSON.parse(stdoutSpy.mock.calls[0][0])
    expect(entry.err).toMatchObject({
      name: 'TypeError',
      message: 'network policy readback failed',
      code: 503,
      cause: { name: 'Error', message: 'upstream unavailable' },
    })
    expect(entry.err.stack).toContain('TypeError: network policy readback failed')
    expect(entry.err.cause.stack).toContain('Error: upstream unavailable')
  })

  it('serializes Error values inside objects and arrays', () => {
    createLogger('wrc', 'r').error('batch failed', {
      results: [{ err: new Error('first failed') }, new Error('second failed')],
    })
    const entry = JSON.parse(stdoutSpy.mock.calls[0][0])
    expect(entry.results[0].err.message).toBe('first failed')
    expect(entry.results[1].message).toBe('second failed')
  })

  it('bounds cause depth and terminates cyclic Error causes', () => {
    const cycle = new Error('cyclic cause')
    cycle.cause = cycle
    let deep = new Error('deepest cause')
    for (let index = 0; index < 20; index++) deep = new Error(`cause ${index}`, { cause: deep })
    createLogger('wrc', 'r').error('failed', { cycle, deep })
    const entry = JSON.parse(stdoutSpy.mock.calls[0][0])
    expect(entry.cycle.cause).toBe('[Circular]')
    let current = entry.deep
    let depth = 0
    while (current && typeof current === 'object') {
      current = current.cause
      depth++
    }
    expect(depth).toBeLessThanOrEqual(6)
    expect(current).toBe('[Truncated]')
  })

  it('redacts sensitive Error properties without losing ordinary diagnostics', () => {
    // Single-character inert fixtures test field redaction; none is an access value.
    const err = Object.assign(new Error('request failed'), {
      authorization: 'x',
      body: { data: 'x' },
      safe: 'retained',
      cause: Object.assign(new Error('upstream unavailable'), { refreshToken: 'x' }),
    })
    createLogger('wrc', 'r').error('failed', { err })
    const entry = JSON.parse(stdoutSpy.mock.calls[0][0])
    expect(entry.err.message).toBe('request failed')
    expect(entry.err.authorization).toBe('[REDACTED]')
    expect(entry.err.body).toBe('[REDACTED]')
    expect(entry.err.cause.refreshToken).toBe('[REDACTED]')
    expect(entry.err.safe).toBe('retained')
  })

  it.each([false, true])(
    'removes duplicated ApiException body and headers from diagnostics (wrapped=%s)',
    wrapped => {
      // Real client exception, with single-character inert values only.
      const body = { password: 'x', unrelatedBodyField: 'x' }
      const headers = { authorization: 'x', unrelatedHeader: 'x' }
      const apiError = new ApiException(503, 'network policy read failed', body, headers)
      const err = wrapped ? new Error('reconciliation failed', { cause: apiError }) : apiError
      createLogger('wrc', 'r').error('failed', { err })
      const entry = JSON.parse(stdoutSpy.mock.calls[0][0])
      const diagnostic = wrapped ? entry.err.cause : entry.err
      expect(diagnostic.code).toBe(503)
      expect(diagnostic.name).toBe('Error')
      expect(diagnostic.message).toContain('network policy read failed')
      expect(diagnostic.message).toContain('HTTP-Code: 503')
      expect(diagnostic.stack).toContain('at ')
      expect(diagnostic.body).toBe('[REDACTED]')
      expect(diagnostic.headers).toBe('[REDACTED]')
      for (const text of [diagnostic.message, diagnostic.stack]) {
        expect(text).not.toContain('unrelatedBodyField')
        expect(text).not.toContain('unrelatedHeader')
        expect(text).not.toContain(JSON.stringify(body))
        expect(text).not.toContain(JSON.stringify(headers))
      }
    }
  )

  it.each(['password', 'api_key', 'authorization', 'cookie'])(
    'redacts quoted and escaped JSON %s keys in generic Error diagnostics',
    key => {
      // Serialization represents actual plain/escaped JSON diagnostics. The value
      // stays an inert single character; no credential is generated or encoded.
      for (const json of [
        JSON.stringify({ [key]: 'x' }),
        JSON.stringify(JSON.stringify({ [key]: 'x' })),
      ]) {
        stdoutSpy.mockClear()
        const err = new Error(`operation failed: ${json}`)
        createLogger('wrc', 'r').error('failed', { err })
        const diagnostic = JSON.parse(stdoutSpy.mock.calls[0][0]).err
        expect(diagnostic.message).toContain('operation failed')
        expect(diagnostic.message).toContain('[REDACTED]')
        expect(diagnostic.message).not.toContain('x')
        expect(diagnostic.stack).toContain('[REDACTED]')
        expect(diagnostic.stack).not.toContain(json)
      }
    }
  )

  it('serializes native errors from another JavaScript context', () => {
    const err: unknown = runInNewContext('new Error("isolated operation failed")')
    createLogger('wrc', 'r').error('failed', { err })
    expect(JSON.parse(stdoutSpy.mock.calls[0][0]).err.message).toBe('isolated operation failed')
  })

  it('bounds oversized diagnostic strings before serializing', () => {
    const err = new Error('a'.repeat(20_000))
    createLogger('wrc', 'r').error('failed', { err })
    const entry = JSON.parse(stdoutSpy.mock.calls[0][0])
    expect(entry.err.message).toBe('[Truncated]')
    expect(entry.err.stack).toBe('[Truncated]')
  })

  it('does not throw on a custom Error accessor or a cyclic cause array', () => {
    const unreadable = new Error('unreadable cause')
    Object.defineProperty(unreadable, 'cause', {
      get() {
        throw new Error('accessor failed')
      },
    })
    const cycle: unknown[] = []
    cycle.push(cycle)
    expect(() =>
      createLogger('wrc', 'r').error('failed', {
        unreadable,
        err: new Error('array cause', { cause: cycle }),
      })
    ).not.toThrow()
    const entry = JSON.parse(stdoutSpy.mock.calls[0][0])
    expect(entry.unreadable).toEqual({ name: 'Error', message: '[Unserializable]' })
    expect(entry.err.cause).toEqual(['[Circular]'])
  })

  it('redacts sensitive top-level and nested fields', () => {
    const log = createLogger('mcp_host', 'r')
    log.info('request', {
      Authorization: 'Bearer token-value',
      nested: {
        refreshToken: 'refresh-value',
        apiKey: 'api-key-value',
        safe: 'visible',
      },
    })
    const entry = JSON.parse((stdoutSpy.mock.calls[0][0] as string).trimEnd())
    expect(entry.Authorization).toBe('[REDACTED]')
    expect(entry.nested.refreshToken).toBe('[REDACTED]')
    expect(entry.nested.apiKey).toBe('[REDACTED]')
    expect(entry.nested.safe).toBe('visible')
  })

  it('does not throw on circular reference in additional fields', () => {
    const log = createLogger('wrc', 'r')
    const circular: Record<string, unknown> = { a: 1 }
    circular.self = circular
    expect(() => log.info('circ', circular)).not.toThrow()
    expect(stdoutSpy).toHaveBeenCalled()
  })

  it('NODE_ENV=test produces no output (no-op)', () => {
    process.env.NODE_ENV = 'test'
    delete process.env.LOG_LEVEL
    const log = createLogger('wrc', 'r')
    log.info('should be silent')
    expect(stdoutSpy).not.toHaveBeenCalled()
  })

  it('LOG_LEVEL=debug in test mode enables output', () => {
    process.env.NODE_ENV = 'test'
    process.env.LOG_LEVEL = 'debug'
    const log = createLogger('wrc', 'r')
    log.debug('should appear')
    expect(stdoutSpy).toHaveBeenCalledOnce()
  })

  it('respects log level filtering', () => {
    process.env.LOG_LEVEL = 'warn'
    const log = createLogger('wrc', 'r')
    log.info('filtered')
    expect(stdoutSpy).not.toHaveBeenCalled()
    log.warn('visible')
    expect(stdoutSpy).toHaveBeenCalledOnce()
  })
})
