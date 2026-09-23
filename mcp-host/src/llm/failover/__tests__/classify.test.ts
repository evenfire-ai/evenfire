import { describe, expect, it } from 'vitest'
import { LlmErrorCode } from '../../../core/errors'
import { ALL_FAILOVER_CLASSES, classifyFailoverClass } from '../classify'

describe('classifyFailoverClass', () => {
  it('maps the four catalogue tuples (spec §3-R5.2)', () => {
    expect(classifyFailoverClass(LlmErrorCode.InsufficientQuota, false)).toBe('insufficient_quota')
    expect(classifyFailoverClass(LlmErrorCode.AuthenticationFailed, false)).toBe('auth')
    expect(classifyFailoverClass(LlmErrorCode.RateLimited, true)).toBe('rate_limited')
    expect(classifyFailoverClass(LlmErrorCode.ModelOverloaded, true)).toBe('provider_unavailable')
  })

  it('ApiCallFailed is provider_unavailable ONLY when retryable', () => {
    expect(classifyFailoverClass(LlmErrorCode.ApiCallFailed, true)).toBe('provider_unavailable')
    // 400 / validation / content-policy — never eligible (would mask bugs).
    expect(classifyFailoverClass(LlmErrorCode.ApiCallFailed, false)).toBeNull()
  })

  it('returns null for classes outside the catalogue', () => {
    expect(classifyFailoverClass(LlmErrorCode.InvalidResponse, true)).toBeNull()
    expect(classifyFailoverClass(LlmErrorCode.ContextLengthExceeded, false)).toBeNull()
    expect(classifyFailoverClass(LlmErrorCode.ContentFiltered, false)).toBeNull()
    expect(classifyFailoverClass(LlmErrorCode.ModelNotAvailable, false)).toBeNull()
  })

  it('never fails over a tool-call limit, whatever its retryable flag', () => {
    expect(classifyFailoverClass(LlmErrorCode.ToolCallLimitExceeded, false)).toBeNull()
    expect(classifyFailoverClass(LlmErrorCode.ToolCallLimitExceeded, true)).toBeNull()
    // Witness: the same classifier still switches on an outage.
    expect(classifyFailoverClass(LlmErrorCode.ModelOverloaded, true)).toBe('provider_unavailable')
  })

  it('exports all four classes as the default triggerOn set', () => {
    expect([...ALL_FAILOVER_CLASSES].sort()).toEqual(
      ['auth', 'insufficient_quota', 'provider_unavailable', 'rate_limited'].sort()
    )
  })
})
