import { describe, expect, it } from 'vitest'
import { LlmErrorCode } from '../../core/errors'
import { OpenAIProvider } from '../openai'
import { OpenAICompatibleProvider } from '../openaiCompatible'

function makeBailian(model?: string) {
  return new OpenAICompatibleProvider(
    {
      id: 'bailian',
      baseURL: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
      defaultModel: 'qwen3-coder-plus',
    },
    'fake-key',
    model
  )
}

describe('BailianProvider (OpenAICompatibleProvider)', () => {
  it('delegates a plain rate-limit to the shared HTTP classifier', () => {
    const bailian = makeBailian('bailian-model')
    expect(bailian).toBeInstanceOf(OpenAIProvider)
    const result = bailian.classifyError({ status: 429, message: 'rate limited' })
    expect(result).toMatchObject({
      code: LlmErrorCode.RateLimited,
      retryable: true,
      message: 'rate limited',
    })
  })

  it("getProviderType returns 'bailian'", () => {
    expect(makeBailian().getProviderType()).toBe('bailian')
  })
})
