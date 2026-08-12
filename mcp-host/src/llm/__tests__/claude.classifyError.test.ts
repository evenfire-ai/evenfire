import { describe, expect, it } from 'vitest'
import { LlmErrorCode } from '../../core/errors'
import { ClaudeProvider } from '../claude'
import { anthropicApiError } from './sdkErrorFixtures'

describe('ClaudeProvider.classifyError', () => {
  const provider = new ClaudeProvider('fake-key', 'claude-3-5-sonnet-20241022')

  it('classifies 429 as RateLimited, retryable', () => {
    expect(provider.classifyError({ status: 429, message: 'rate limited' })).toMatchObject({
      code: LlmErrorCode.RateLimited,
      retryable: true,
      message: 'rate limited',
    })
  })

  it('classifies 401 as AuthenticationFailed', () => {
    expect(provider.classifyError({ status: 401, message: 'invalid key' }).code).toBe(
      LlmErrorCode.AuthenticationFailed
    )
  })

  it('classifies 529 as ModelOverloaded, retryable', () => {
    expect(provider.classifyError({ status: 529, message: 'overloaded' })).toMatchObject({
      code: LlmErrorCode.ModelOverloaded,
      retryable: true,
      message: 'overloaded',
    })
  })

  // Fixtures derived from Anthropic.APIError.generate: the modeled type is
  // nested at `.error.error.type`. A classifier reading the wrong level would
  // (a) fall through to the HTTP-status branch — which coincidentally maps some
  // of these right — and (b) surface providerCode='error' and the ugly
  // enveloped `.message`. The providerCode + message assertions below are what
  // catch that regression regardless of the status coincidence.
  it('classifies error.type not_found_error as ModelNotAvailable, not retryable', () => {
    const err = anthropicApiError(404, 'not_found_error', 'model: claude-x not found')
    const c = provider.classifyError(err)
    expect(c.code).toBe(LlmErrorCode.ModelNotAvailable)
    expect(c.retryable).toBe(false)
    expect(c.httpStatus).toBe(404)
    expect(c.providerCode).toBe('not_found_error')
    expect(c.message).toBe('model: claude-x not found')
  })

  it('classifies error.type overloaded_error as ModelOverloaded, retryable', () => {
    const err = anthropicApiError(529, 'overloaded_error', 'overloaded')
    const c = provider.classifyError(err)
    expect(c.code).toBe(LlmErrorCode.ModelOverloaded)
    expect(c.retryable).toBe(true)
    expect(c.providerCode).toBe('overloaded_error')
    expect(c.message).toBe('overloaded')
  })

  it('classifies error.type billing_error as InsufficientQuota, not retryable', () => {
    // Anthropic surfaces billing as a 400 in practice (not the documented 402),
    // so the HTTP-status branch would map this to ApiCallFailed — only the
    // modeled type gets it to InsufficientQuota. This case fails on `code` too
    // when the nesting is read wrong.
    const err = anthropicApiError(400, 'billing_error', 'billing issue')
    const c = provider.classifyError(err)
    expect(c.code).toBe(LlmErrorCode.InsufficientQuota)
    expect(c.retryable).toBe(false)
    expect(c.providerCode).toBe('billing_error')
    expect(c.message).toBe('billing issue')
  })

  it('classifies error.type permission_error as InsufficientQuota (account access), not retryable', () => {
    const err = anthropicApiError(403, 'permission_error', 'no permission')
    const c = provider.classifyError(err)
    expect(c.code).toBe(LlmErrorCode.InsufficientQuota)
    expect(c.retryable).toBe(false)
    expect(c.providerCode).toBe('permission_error')
    expect(c.message).toBe('no permission')
  })

  it("reclassifies 400 with 'credit balance is too low' as InsufficientQuota", () => {
    const err = {
      status: 400,
      error: {
        type: 'invalid_request_error',
        message: 'Your credit balance is too low to access the Claude API',
      },
    }
    const result = provider.classifyError(err)
    expect(result.code).toBe(LlmErrorCode.InsufficientQuota)
    expect(result.retryable).toBe(false)
    expect(result.message).toBe('Your credit balance is too low to access the Claude API')
  })

  it('keeps 400 without credit message as ApiCallFailed', () => {
    const err = {
      status: 400,
      error: { type: 'invalid_request_error', message: 'messages.0.role: Field required' },
    }
    expect(provider.classifyError(err).code).toBe(LlmErrorCode.ApiCallFailed)
  })

  it('falls back to unknown for plain Error', () => {
    const result = provider.classifyError(new Error('socket closed'))
    expect(result).toEqual({
      code: LlmErrorCode.ApiCallFailed,
      retryable: true,
      message: 'socket closed',
    })
  })
})
