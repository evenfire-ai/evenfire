import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
