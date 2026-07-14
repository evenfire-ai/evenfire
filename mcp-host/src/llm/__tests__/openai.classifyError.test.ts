import { describe, expect, it } from 'vitest'
import { LlmErrorCode } from '../../core/errors'
import { OpenAIProvider } from '../openai'

describe('OpenAIProvider.classifyError', () => {
  const provider = new OpenAIProvider('fake-key', 'gpt-4o')

  it('classifies 429 as RateLimited, retryable', () => {
    const result = provider.classifyError({ status: 429, message: 'rate limit exceeded' })
    expect(result).toEqual({
      code: LlmErrorCode.RateLimited,
      retryable: true,
      message: 'rate limit exceeded',
    })
  })

  it('classifies 400 insufficient_quota body code as InsufficientQuota, not retryable', () => {
    const err = {
      status: 429,
      error: { code: 'insufficient_quota', message: 'You exceeded your current quota' },
    }
    expect(provider.classifyError(err)).toEqual({
      code: LlmErrorCode.InsufficientQuota,
      retryable: false,
      message: 'You exceeded your current quota',
    })
  })

  it('classifies 401 as AuthenticationFailed', () => {
    const result = provider.classifyError({ status: 401, message: 'invalid API key' })
    expect(result.code).toBe(LlmErrorCode.AuthenticationFailed)
    expect(result.retryable).toBe(false)
  })

  it('falls back to unknown classification for plain Error', () => {
    const result = provider.classifyError(new Error('ECONNRESET'))
    expect(result).toEqual({
      code: LlmErrorCode.ApiCallFailed,
      retryable: true,
      message: 'ECONNRESET',
    })
  })

  it('falls back to unknown classification for null input (does not throw)', () => {
    const result = provider.classifyError(null)
    expect(result.code).toBe(LlmErrorCode.ApiCallFailed)
    expect(result.retryable).toBe(true)
  })
})
