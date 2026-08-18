import { describe, expect, it } from 'vitest'
import { LlmErrorCode } from '../../core/errors'
import { OpenAICompatibleProvider } from '../openaiCompatible'
import { openaiApiError } from './sdkErrorFixtures'

const zai = new OpenAICompatibleProvider(
  { id: 'zai', baseURL: 'https://example.invalid', defaultModel: 'glm-4' },
  'fake-key'
)
const bailian = new OpenAICompatibleProvider(
  { id: 'bailian', baseURL: 'https://example.invalid', defaultModel: 'qwen-max' },
  'fake-key'
)

// Fixtures derived from OpenAI.APIError.generate (T1): the provider-native code
// lands at `err.error.code`, the level the override reads. Deriving guards
// against the same nesting mismatch that broke the Claude arm.
describe('OpenAICompatibleProvider.classifyError', () => {
  it('maps z.ai model-not-available codes (1211/1220) to ModelNotAvailable', () => {
    for (const code of ['1211', '1220']) {
      const c = zai.classifyError(openaiApiError(404, { code, message: 'model not available' }))
      expect(c.code).toBe(LlmErrorCode.ModelNotAvailable)
      expect(c.retryable).toBe(false)
      expect(c.providerCode).toBe(code)
    }
  })

  it('maps z.ai billing code 1113 inside a 429 to InsufficientQuota (not a retryable rate-limit)', () => {
    const c = zai.classifyError(
      openaiApiError(429, { code: '1113', message: 'insufficient balance' })
    )
    expect(c.code).toBe(LlmErrorCode.InsufficientQuota)
    expect(c.retryable).toBe(false)
  })

  it('maps Bailian ModelNotFound / Model.AccessDenied to ModelNotAvailable', () => {
    for (const code of ['ModelNotFound', 'Model.AccessDenied']) {
      const c = bailian.classifyError(openaiApiError(404, { code, message: 'no access to model' }))
      expect(c.code).toBe(LlmErrorCode.ModelNotAvailable)
      expect(c.retryable).toBe(false)
    }
  })

  it('maps Bailian Arrearage (billing) to InsufficientQuota, not retryable', () => {
    const c = bailian.classifyError(openaiApiError(429, { code: 'Arrearage', message: 'arrears' }))
    expect(c.code).toBe(LlmErrorCode.InsufficientQuota)
    expect(c.retryable).toBe(false)
  })

  it('falls through to the shared HTTP classifier for generic 404', () => {
    const c = zai.classifyError(openaiApiError(404, { message: 'not found' }))
    expect(c.code).toBe(LlmErrorCode.ModelNotAvailable)
    expect(c.retryable).toBe(false)
  })

  it('falls through to the shared HTTP classifier for a plain rate-limit 429', () => {
    const c = zai.classifyError(openaiApiError(429, { message: 'rate limited' }))
    expect(c.code).toBe(LlmErrorCode.RateLimited)
    expect(c.retryable).toBe(true)
  })

  it('falls back to unknown classification for a plain Error (does not throw)', () => {
    const c = zai.classifyError(new Error('ECONNRESET'))
    expect(c.code).toBe(LlmErrorCode.ApiCallFailed)
    expect(c.retryable).toBe(true)
  })
})
