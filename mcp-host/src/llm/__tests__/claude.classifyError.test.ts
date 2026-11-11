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

  it('classifies error.type permission_error as AuthenticationFailed (403 identity/authz), not retryable (R1-M1)', () => {
    // A 403 is identity/authorization (account access / IAM permission), not
    // billing — it lands on the `auth` failover class uniformly with the other
    // arms. billing_error above keeps InsufficientQuota (Anthropic's quota channel).
    const err = anthropicApiError(403, 'permission_error', 'no permission')
    const c = provider.classifyError(err)
    expect(c.code).toBe(LlmErrorCode.AuthenticationFailed)
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

  // #1433: a 400 is a rejected request, not "Connection Error" (ApiCallFailed).
  it('classifies 400 without credit message as UpstreamRejected, not retryable', () => {
    const err = {
      status: 400,
      error: { type: 'invalid_request_error', message: 'messages.0.role: Field required' },
    }
    expect(provider.classifyError(err)).toMatchObject({
      code: LlmErrorCode.UpstreamRejected,
      retryable: false,
      httpStatus: 400,
    })
  })

  it('surfaces the inner modeled type as providerCode for an unmapped enveloped error (R1-L1)', () => {
    // Derived from the real SDK constructor: `.error` is the FULL envelope, so a
    // fallthrough that reads the outer level gets the constant 'error' instead of
    // the real modeled type. invalid_request_error is not in the byType switch, so
    // it falls through to the shared HTTP classifier.
    const err = anthropicApiError(400, 'invalid_request_error', 'messages.0.role: Field required')
    const c = provider.classifyError(err)
    expect(c.code).toBe(LlmErrorCode.UpstreamRejected)
    expect(c.providerCode).toBe('invalid_request_error')
    expect(c.providerCode).not.toBe('error')
  })

  // #1433: the request body that held a lone UTF-16 surrogate. The message is
  // the provider's own text, not the SDK's `400 {json}` string.
  it('classifies the "request body is not valid JSON" 400 as UpstreamRejected', () => {
    const text =
      'The request body is not valid JSON: unexpected end of hex escape at line 1 column 9'
    const c = provider.classifyError(anthropicApiError(400, 'invalid_request_error', text))
    expect(c).toMatchObject({
      code: LlmErrorCode.UpstreamRejected,
      retryable: false,
      httpStatus: 400,
      providerCode: 'invalid_request_error',
    })
    expect(c.message).toBe(text)
  })

  // The inner message is used for the 400 arm only (#1433): any other status that
  // falls to the shared classifier keeps the SDK's `${status} {json}` message.
  it('keeps the SDK message for an enveloped non-400 error', () => {
    const err = anthropicApiError(401, 'authentication_error', 'invalid x-api-key')
    const c = provider.classifyError(err)
    expect(c).toMatchObject({
      code: LlmErrorCode.AuthenticationFailed,
      httpStatus: 401,
      providerCode: 'authentication_error',
    })
    expect(c.message).toBe((err as Error).message)
    expect(c.message).not.toBe('invalid x-api-key')
  })

  // The credit-balance guard keys on the HTTP status, so it survives the 400
  // recode above (claude.ts). Real SDK envelope, not a plain object.
  it('still reclassifies an enveloped credit-balance 400 as InsufficientQuota', () => {
    const c = provider.classifyError(
      anthropicApiError(
        400,
        'invalid_request_error',
        'Your credit balance is too low to access the Claude API'
      )
    )
    expect(c.code).toBe(LlmErrorCode.InsufficientQuota)
    expect(c.retryable).toBe(false)
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
