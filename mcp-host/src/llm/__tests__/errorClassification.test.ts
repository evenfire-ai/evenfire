import { describe, expect, it } from 'vitest'
import { LlmErrorCode } from '../../core/errors'
import { classifyByHttpStatus, classifyUnknown } from '../errorClassification'

describe('classifyByHttpStatus', () => {
  it('returns null for non-HTTP-shaped errors', () => {
    expect(classifyByHttpStatus(new Error('plain'))).toBeNull()
    expect(classifyByHttpStatus('string')).toBeNull()
    expect(classifyByHttpStatus(null)).toBeNull()
    expect(classifyByHttpStatus(undefined)).toBeNull()
    expect(classifyByHttpStatus(42)).toBeNull()
  })

  it('maps 401 and 403 to AuthenticationFailed, not retryable', () => {
    expect(classifyByHttpStatus({ status: 401, message: 'unauthorized' })).toEqual({
      code: LlmErrorCode.AuthenticationFailed,
      retryable: false,
      message: 'unauthorized',
    })
    expect(classifyByHttpStatus({ status: 403, message: 'forbidden' })).toEqual({
      code: LlmErrorCode.AuthenticationFailed,
      retryable: false,
      message: 'forbidden',
    })
  })

  it('maps 402 to InsufficientQuota, not retryable', () => {
    expect(classifyByHttpStatus({ status: 402, message: 'payment required' })).toEqual({
      code: LlmErrorCode.InsufficientQuota,
      retryable: false,
      message: 'payment required',
    })
  })

  it('maps 429 to RateLimited, retryable', () => {
    expect(classifyByHttpStatus({ status: 429, message: 'rate limited' })).toEqual({
      code: LlmErrorCode.RateLimited,
      retryable: true,
      message: 'rate limited',
    })
  })

  it('maps 503 and 529 to ModelOverloaded, retryable', () => {
    expect(classifyByHttpStatus({ status: 503, message: 'unavailable' })).toEqual({
      code: LlmErrorCode.ModelOverloaded,
      retryable: true,
      message: 'unavailable',
    })
    expect(classifyByHttpStatus({ status: 529, message: 'overloaded' })).toEqual({
      code: LlmErrorCode.ModelOverloaded,
      retryable: true,
      message: 'overloaded',
    })
  })

  it('maps any 5xx to ModelOverloaded, retryable', () => {
    expect(classifyByHttpStatus({ status: 502, message: 'bad gateway' })?.code).toBe(
      LlmErrorCode.ModelOverloaded
    )
    expect(classifyByHttpStatus({ status: 504, message: 'gateway timeout' })?.code).toBe(
      LlmErrorCode.ModelOverloaded
    )
  })

  it('maps 400 without quota signal to ApiCallFailed, NOT retryable', () => {
    expect(classifyByHttpStatus({ status: 400, message: 'bad request' })).toEqual({
      code: LlmErrorCode.ApiCallFailed,
      retryable: false,
      message: 'bad request',
    })
  })

  it('recognizes body-level insufficient_quota via error.code', () => {
    const err = { status: 429, error: { code: 'insufficient_quota', message: 'out of credit' } }
    expect(classifyByHttpStatus(err)).toEqual({
      code: LlmErrorCode.InsufficientQuota,
      retryable: false,
      message: 'out of credit',
    })
  })

  it('recognizes body-level insufficient_quota via error.type', () => {
    const err = { status: 429, error: { type: 'insufficient_quota', message: 'out of credit' } }
    expect(classifyByHttpStatus(err)).toEqual({
      code: LlmErrorCode.InsufficientQuota,
      retryable: false,
      message: 'out of credit',
    })
  })

  it('prefers error.message over top-level message when both present', () => {
    const err = { status: 429, message: 'top', error: { message: 'nested' } }
    expect(classifyByHttpStatus(err)?.message).toBe('nested')
  })

  it('returns null for unrecognized status codes', () => {
    expect(classifyByHttpStatus({ status: 418, message: 'teapot' })).toBeNull()
  })

  it('returns null when object is HttpErrorLike but no status matches', () => {
    // Admitted by isHttpErrorLike (has `error` key) but neither the body-level
    // quota check nor any status branch triggers — must return null so callers
    // can fall through to classifyUnknown.
    expect(classifyByHttpStatus({ error: undefined })).toBeNull()
    expect(classifyByHttpStatus({ status: undefined })).toBeNull()
    expect(classifyByHttpStatus({ status: 999 })).toBeNull()
  })
})

describe('classifyUnknown', () => {
  it('wraps Error instances as retryable ApiCallFailed', () => {
    expect(classifyUnknown(new Error('network dead'))).toEqual({
      code: LlmErrorCode.ApiCallFailed,
      retryable: true,
      message: 'network dead',
    })
  })

  it('wraps non-Error values safely', () => {
    expect(classifyUnknown('boom').code).toBe(LlmErrorCode.ApiCallFailed)
    expect(classifyUnknown('boom').message).toBe('boom')
    expect(classifyUnknown(null).message).toBe('null')
    expect(classifyUnknown(undefined).message).toBe('undefined')
  })
})
