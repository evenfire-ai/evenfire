import { describe, expect, it } from 'vitest'
import { EXECUTION_RESULT_MAX_BYTES, parseHostExecutionResult } from './result'

const result = {
  reason: 'exited',
  exitCode: 7,
  signal: null,
  truncated: false,
  stdout: Buffer.from([0, 255, 128, 10]).toString('base64'),
  stderr: '',
}

describe('execution result protocol', () => {
  it('preserves arbitrary bytes and the actual command status', () => {
    const parsed = parseHostExecutionResult(JSON.stringify(result) + '\n')
    expect(parsed).toEqual(result)
    expect(Buffer.from(parsed.stdout, 'base64')).toEqual(Buffer.from([0, 255, 128, 10]))
    expect(Object.isFrozen(parsed)).toBe(true)
  })

  it('accepts the maximum aggregate bytes even when split between streams', () => {
    const maximum = {
      ...result,
      stdout: Buffer.alloc(32_768, 255).toString('base64'),
      stderr: Buffer.alloc(32_768, 0).toString('base64'),
    }
    expect(Buffer.byteLength(JSON.stringify(maximum))).toBeLessThan(EXECUTION_RESULT_MAX_BYTES)
    expect(parseHostExecutionResult(JSON.stringify(maximum))).toEqual(maximum)
  })

  it('rejects oversized, truncated, concatenated or forged frames', () => {
    for (const frame of [
      '{',
      JSON.stringify(result).slice(0, -1),
      JSON.stringify(result).repeat(2),
      ' '.repeat(EXECUTION_RESULT_MAX_BYTES + 1),
      JSON.stringify({ ...result, injected: true }),
      JSON.stringify({ ...result, reason: 'approved' }),
      JSON.stringify({ ...result, exitCode: -1 }),
      JSON.stringify({ ...result, exitCode: 256 }),
      JSON.stringify({ ...result, signal: 'unbounded private exception' }),
      JSON.stringify({ ...result, stdout: 'not-base64' }),
      JSON.stringify({ ...result, stdout: 'YQ' }),
      JSON.stringify({ ...result, truncated: 'true' }),
      JSON.stringify({ ...result, stdout: Buffer.alloc(65_537).toString('base64') }),
      JSON.stringify({
        ...result,
        stdout: Buffer.alloc(65_536).toString('base64'),
        stderr: 'YQ==',
      }),
    ])
      expect(() => parseHostExecutionResult(frame)).toThrow('execution_result_invalid')
  })
})
