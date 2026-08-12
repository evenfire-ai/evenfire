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

  it('maps 401 to AuthenticationFailed, not retryable', () => {
    expect(classifyByHttpStatus({ status: 401, message: 'unauthorized' })).toMatchObject({
      code: LlmErrorCode.AuthenticationFailed,
      retryable: false,
      message: 'unauthorized',
    })
  })

  it('maps 403 to InsufficientQuota (account/billing access), NOT AuthenticationFailed', () => {
    // 403 is separated from 401: a bad credential is 401 (a rotatable key); 403
    // is account access / billing / permission and must not masquerade as a
    // credential failure (which would silently divert traffic via the `auth`
    // failover class).
    const c = classifyByHttpStatus({ status: 403, message: 'forbidden' })
    expect(c?.code).toBe(LlmErrorCode.InsufficientQuota)
    expect(c?.retryable).toBe(false)
    expect(c?.httpStatus).toBe(403)
  })

  it('maps 404 to ModelNotAvailable, NOT retryable', () => {
    // Model retired OR not accessible to this account — indistinguishable by
    // API. Non-retryable so the tool-use loop does not retry it, and NOT a
    // failover trigger so it does not silently divert cross-provider.
    const c = classifyByHttpStatus({ status: 404, message: 'model not found' })
    expect(c?.code).toBe(LlmErrorCode.ModelNotAvailable)
    expect(c?.retryable).toBe(false)
    expect(c?.httpStatus).toBe(404)
  })

  it('maps body-level model_not_found (code or type) to ModelNotAvailable', () => {
    expect(
      classifyByHttpStatus({ status: 400, error: { code: 'model_not_found', message: 'gone' } })
    ).toMatchObject({
      code: LlmErrorCode.ModelNotAvailable,
      retryable: false,
      providerCode: 'model_not_found',
    })
    expect(
      classifyByHttpStatus({ status: 400, error: { type: 'model_not_found', message: 'gone' } })
    ).toMatchObject({ code: LlmErrorCode.ModelNotAvailable, retryable: false })
  })

  it('maps body-level invalid_api_key to AuthenticationFailed', () => {
    expect(
      classifyByHttpStatus({ status: 401, error: { code: 'invalid_api_key', message: 'bad key' } })
    ).toMatchObject({ code: LlmErrorCode.AuthenticationFailed, retryable: false })
  })

  it('propagates httpStatus and providerCode onto the ClassifiedError', () => {
    const c = classifyByHttpStatus({
      status: 429,
      error: { code: 'rate_limit', message: 'slow down' },
    })
    expect(c?.httpStatus).toBe(429)
    expect(c?.providerCode).toBe('rate_limit')
  })

  it('maps 402 to InsufficientQuota, not retryable', () => {
    expect(classifyByHttpStatus({ status: 402, message: 'payment required' })).toMatchObject({
      code: LlmErrorCode.InsufficientQuota,
      retryable: false,
      message: 'payment required',
    })
  })

  it('maps 429 to RateLimited, retryable', () => {
    expect(classifyByHttpStatus({ status: 429, message: 'rate limited' })).toMatchObject({
      code: LlmErrorCode.RateLimited,
      retryable: true,
      message: 'rate limited',
    })
  })

  it('maps 503 and 529 to ModelOverloaded, retryable', () => {
    expect(classifyByHttpStatus({ status: 503, message: 'unavailable' })).toMatchObject({
      code: LlmErrorCode.ModelOverloaded,
      retryable: true,
      message: 'unavailable',
    })
    expect(classifyByHttpStatus({ status: 529, message: 'overloaded' })).toMatchObject({
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
    expect(classifyByHttpStatus({ status: 400, message: 'bad request' })).toMatchObject({
      code: LlmErrorCode.ApiCallFailed,
      retryable: false,
      message: 'bad request',
    })
  })

  it('recognizes body-level insufficient_quota via error.code', () => {
    const err = { status: 429, error: { code: 'insufficient_quota', message: 'out of credit' } }
    expect(classifyByHttpStatus(err)).toMatchObject({
      code: LlmErrorCode.InsufficientQuota,
      retryable: false,
      message: 'out of credit',
    })
  })

  it('recognizes body-level insufficient_quota via error.type', () => {
    const err = { status: 429, error: { type: 'insufficient_quota', message: 'out of credit' } }
    expect(classifyByHttpStatus(err)).toMatchObject({
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
