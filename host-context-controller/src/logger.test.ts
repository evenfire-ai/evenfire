import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiException } from '@kubernetes/client-node'
import { HostContextLogger } from './logger'

/** Log `fields` at error level and return the printed line and its parsed payload. */
function logError(fields: Record<string, unknown>): {
  line: string
  payload: Record<string, any>
} {
  const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  new HostContextLogger({ module: 'readiness' }).error('readiness detail check failed', fields)
  expect(errorLog).toHaveBeenCalledTimes(1)
  const line = String(errorLog.mock.calls[0][0])
  errorLog.mockRestore()
  return { line, payload: JSON.parse(line) }
}

const occurrences = (text: string, marker: string) => text.split(marker).length - 1

describe('HostContextLogger', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('flattens Error fields, with the stack frames only, so { err } is not empty', () => {
    const { payload } = logError({ err: new Error('L7T1-MSG-7f3a') })

    expect(payload.msg).toBe('readiness detail check failed')
    expect(Object.keys(payload.err).sort()).toEqual(['message', 'name', 'stack'])
    expect(payload.err).toMatchObject({ name: 'Error', message: 'L7T1-MSG-7f3a' })
    expect(payload.err.stack).toMatch(/^ {4}at /)
    expect(payload.err.stack).not.toContain('L7T1-MSG-7f3a')
    expect(payload).not.toHaveProperty('stack')
  })

  it('keeps an ApiException code and frames, logs its body text once, and copies neither body nor headers', () => {
    const err = new ApiException(
      403,
      'Forbidden',
      { marker: 'BODY-MARKER' },
      { 'audit-id': 'HDR-MARKER' }
    )
    const { line, payload } = logError({ err })

    expect(Object.keys(payload.err).sort()).toEqual(['code', 'message', 'name', 'stack'])
    expect(payload.err.code).toBe(403)
    expect(payload.err.stack).toMatch(/^ {4}at /)
    expect(occurrences(line, 'BODY-MARKER')).toBe(1)
    expect(occurrences(line, 'HDR-MARKER')).toBe(1)
  })

  it('keeps a string or number code and drops any other code', () => {
    const withCode = (code: unknown) => Object.assign(new Error('coded failure'), { code })

    expect(logError({ err: withCode('ECONNREFUSED') }).payload.err.code).toBe('ECONNREFUSED')
    expect(logError({ err: withCode(429) }).payload.err.code).toBe(429)
    const { line, payload } = logError({ err: withCode({ marker: 'CODE-OBJECT-MARKER' }) })
    // Witness: the Error itself was rendered.
    expect(payload.err).toMatchObject({ name: 'Error', message: 'coded failure' })
    expect(payload.err).not.toHaveProperty('code')
    expect(line).not.toContain('CODE-OBJECT-MARKER')
  })

  it('nests an Error cause and omits any other cause', () => {
    const inner = Object.assign(new TypeError('connect failed'), { code: 'ECONNREFUSED' })
    const nested = logError({ err: new Error('fetch failed', { cause: inner }) }).payload
    expect(nested.err.cause).toMatchObject({
      name: 'TypeError',
      message: 'connect failed',
      code: 'ECONNREFUSED',
    })
    expect(nested.err.cause.stack).toMatch(/^ {4}at /)

    for (const cause of ['CAUSE-STRING-MARKER', { marker: 'CAUSE-OBJECT-MARKER' }]) {
      const { line, payload } = logError({ err: new Error('outer failure', { cause }) })
      // Witness: the outer Error was rendered.
      expect(payload.err.message).toBe('outer failure')
      expect(payload.err).not.toHaveProperty('cause')
      expect(line).not.toContain('CAUSE-STRING-MARKER')
      expect(line).not.toContain('CAUSE-OBJECT-MARKER')
    }
  })

  it('terminates on a cause cycle and still renders one Error under two fields', () => {
    const a = new Error('cycle a')
    const b = new Error('cycle b')
    ;(a as any).cause = b
    ;(b as any).cause = a
    const cyclic = logError({ err: a }).payload
    expect(cyclic.err).toMatchObject({
      message: 'cycle a',
      cause: { message: 'cycle b', cause: { message: 'cycle a' } },
    })
    expect(cyclic.err.cause.cause).not.toHaveProperty('cause')

    const shared = new Error('shared failure')
    const { payload } = logError({ first: shared, second: shared })
    expect(payload.first).toMatchObject({ name: 'Error', message: 'shared failure' })
    expect(payload.second).toMatchObject({ name: 'Error', message: 'shared failure' })
  })

  it('leaves non-Error values as they were', () => {
    const loop: Record<string, unknown> = { label: 'loop' }
    loop.self = loop
    const { payload } = logError({
      text: 'plain',
      nothing: null,
      list: [new Error('in array')],
      token: 'token-value',
      loop,
    })

    expect(payload.text).toBe('plain')
    expect(payload.nothing).toBeNull()
    expect(payload.list).toHaveLength(1)
    expect(payload.list[0]).toMatchObject({ name: 'Error', message: 'in array' })
    expect(payload.token).toBe('[redacted]')
    expect(payload.loop).toEqual({ label: 'loop', self: '[Circular]' })
  })

  it('does not copy frame-like lines of the message into the stack', () => {
    const { line, payload } = logError({ err: new Error('outer\n    at INNER-MARKER (x)') })

    expect(Object.keys(payload.err).sort()).toEqual(['message', 'name', 'stack'])
    expect(occurrences(line, 'INNER-MARKER')).toBe(1)
    expect(payload.err.stack).toMatch(/^ {4}at /)
    expect(payload.err.stack).not.toContain('INNER-MARKER')
  })

  it('renders the cause of one Error each time the Error is logged', () => {
    const shared = new Error('shared outer', { cause: new TypeError('shared inner') })
    const { payload } = logError({ first: shared, second: shared, list: [shared, shared] })

    for (const rendered of [payload.first, payload.second, payload.list[0], payload.list[1]]) {
      expect(rendered).toMatchObject({
        message: 'shared outer',
        cause: { name: 'TypeError', message: 'shared inner' },
      })
    }
  })

  it('omits the stack of an Error that has no frame lines', () => {
    const frameless = new Error('FRAMELESS-MARKER')
    frameless.stack = 'Error: FRAMELESS-MARKER'
    const stackless = Object.assign(new Error('STACKLESS-MARKER'), { stack: undefined })
    const { line, payload } = logError({
      frameless,
      stackless,
      witness: new Error('has frames'),
    })

    expect(payload.frameless).toEqual({ name: 'Error', message: 'FRAMELESS-MARKER' })
    expect(payload.stackless).toEqual({ name: 'Error', message: 'STACKLESS-MARKER' })
    expect(occurrences(line, 'FRAMELESS-MARKER')).toBe(1)
    // Witness: the same line carries the frames of an Error that has them.
    expect(payload.witness.stack).toMatch(/^ {4}at /)
  })
})
