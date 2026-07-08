import { describe, expect, it } from 'vitest'
import { LlmErrorCode } from '../../core/errors'
import { ClaudeProvider } from '../claude'

describe('ClaudeProvider.classifyError', () => {
  const provider = new ClaudeProvider('fake-key', 'claude-3-5-sonnet-20241022')

  it('classifies 429 as RateLimited, retryable', () => {
    expect(provider.classifyError({ status: 429, message: 'rate limited' })).toEqual({
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
    expect(provider.classifyError({ status: 529, message: 'overloaded' })).toEqual({
      code: LlmErrorCode.ModelOverloaded,
      retryable: true,
      message: 'overloaded',
    })
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
