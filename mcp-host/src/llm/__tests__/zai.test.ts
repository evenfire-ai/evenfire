import { describe, expect, it } from 'vitest'
import { LlmErrorCode } from '../../core/errors'
import { OpenAIProvider } from '../openai'
import { OpenAICompatibleProvider } from '../openaiCompatible'

function makeZai(model?: string) {
  return new OpenAICompatibleProvider(
    { id: 'zai', baseURL: 'https://api.z.ai/api/coding/paas/v4', defaultModel: 'glm-5.1' },
    'fake-key',
    model
  )
}

describe('ZaiProvider (OpenAICompatibleProvider)', () => {
  it('inherits classifyError from OpenAIProvider', () => {
    const zai = makeZai('zai-model')
    expect(zai).toBeInstanceOf(OpenAIProvider)
    const result = zai.classifyError({ status: 429, message: 'rate limited' })
    expect(result).toEqual({
      code: LlmErrorCode.RateLimited,
      retryable: true,
      message: 'rate limited',
    })
  })

  it("getProviderType returns 'zai'", () => {
    expect(makeZai().getProviderType()).toBe('zai')
  })
})
