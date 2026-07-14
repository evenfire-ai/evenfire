import { describe, expect, it } from 'vitest'
import {
  evaluateCompletedRuntimePodRecovery,
  evaluateCrashRecovery,
} from '../../../src/workflow/crashRecovery'

describe('Crash Recovery', () => {
  it('returns none for Running Pod', () => {
    const result = evaluateCrashRecovery('Running', undefined)
    expect(result.action).toBe('none')
  })

  it('returns none for Pending Pod', () => {
    const result = evaluateCrashRecovery('Pending', undefined)
    expect(result.action).toBe('none')
  })

  it('returns none for Succeeded Pod', () => {
    const result = evaluateCrashRecovery('Succeeded', undefined)
    expect(result.action).toBe('none')
  })

  it('returns replace for completed runtime pod on first attempt', () => {
    const result = evaluateCompletedRuntimePodRecovery(
      { phase: 'initializing', attempt: 0 },
      'mcp_host'
    )
    expect(result.action).toBe('replace')
    expect(result.newPhase).toBe('recovering')
    expect(result.newAttempt).toBe(1)
  })

  it('returns fail for completed runtime pod after attempts exhausted', () => {
    const result = evaluateCompletedRuntimePodRecovery(
      { phase: 'recovering', attempt: 3 },
      'mcp_host'
    )
    expect(result.action).toBe('fail')
    expect(result.newPhase).toBe('failed')
  })

  it('returns replace for Failed Pod on first attempt', () => {
    const result = evaluateCrashRecovery('Failed', { phase: 'running', attempt: 0 })
    expect(result.action).toBe('replace')
    expect(result.newPhase).toBe('recovering')
    expect(result.newAttempt).toBe(1)
  })

  it('returns replace for Running CrashLoopBackOff before attempts are exhausted', () => {
    const result = evaluateCrashRecovery(
      'Running',
      { phase: 'recovering', attempt: 1 },
      'CrashLoopBackOff'
    )
    expect(result.action).toBe('replace')
    expect(result.newPhase).toBe('recovering')
    expect(result.newAttempt).toBe(2)
  })

  it('returns fail for Running CrashLoopBackOff after attempts are exhausted', () => {
    const result = evaluateCrashRecovery(
      'Running',
      { phase: 'recovering', attempt: 3 },
      'CrashLoopBackOff'
    )
    expect(result.action).toBe('fail')
    expect(result.newPhase).toBe('failed')
  })

  it('returns replace for Failed Pod on second attempt', () => {
    const result = evaluateCrashRecovery('Failed', { phase: 'recovering', attempt: 1 })
    expect(result.action).toBe('replace')
    expect(result.newAttempt).toBe(2)
  })

  it('returns fail after 3 attempts exhausted', () => {
    const result = evaluateCrashRecovery('Failed', { phase: 'recovering', attempt: 3 })
    expect(result.action).toBe('fail')
    expect(result.newPhase).toBe('failed')
  })

  it('returns replace for Unknown Pod phase', () => {
    const result = evaluateCrashRecovery('Unknown', { phase: 'running', attempt: 0 })
    expect(result.action).toBe('replace')
  })

  it('treats undefined execution status as attempt 0', () => {
    const result = evaluateCrashRecovery('Failed', undefined)
    expect(result.action).toBe('replace')
    expect(result.newAttempt).toBe(1)
  })

  it('returns none for undefined pod phase', () => {
    const result = evaluateCrashRecovery(undefined, undefined)
    expect(result.action).toBe('none')
  })
})
