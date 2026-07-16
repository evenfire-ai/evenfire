import { describe, expect, it } from 'vitest'
import { classifyErrorKind, errorRecoveryHint } from '../format'

describe('classifyErrorKind — host availability codes', () => {
  it('classifies host_waking messages as waking, even wrapped by Electron IPC', () => {
    expect(
      classifyErrorKind(
        'Error invoking remote method rpc:invokeHostMessage: ' +
          'Error: host_waking: agent host "chatllm" is waking up — retry shortly'
      )
    ).toBe('waking')
  })

  it('classifies host_draining messages as waking', () => {
    expect(
      classifyErrorKind('host_draining: agent host "chatllm" is draining — retry shortly')
    ).toBe('waking')
  })

  it('keeps the existing classifications intact', () => {
    expect(classifyErrorKind('Gateway Timeout')).toBe('network')
    expect(classifyErrorKind('403 Forbidden')).toBe('auth')
    expect(classifyErrorKind('Upstream host unavailable 502')).toBe('upstream')
  })

  it('provides a waking-specific recovery hint', () => {
    expect(errorRecoveryHint('waking')).toContain('starting up')
  })
})
