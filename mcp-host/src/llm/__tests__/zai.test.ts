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
  it('delegates a plain rate-limit to the shared HTTP classifier', () => {
    const zai = makeZai('zai-model')
    expect(zai).toBeInstanceOf(OpenAIProvider)
    const result = zai.classifyError({ status: 429, message: 'rate limited' })
    expect(result).toMatchObject({
      code: LlmErrorCode.RateLimited,
      retryable: true,
      message: 'rate limited',
    })
  })

  it("getProviderType returns 'zai'", () => {
    expect(makeZai().getProviderType()).toBe('zai')
  })

  it('reports documented image input for glm-5.3-flash on the Coding Plan endpoint', async () => {
    await expect(makeZai('glm-5.3-flash').getImageInputCapability()).resolves.toEqual({
      status: 'supported',
      provider: 'zai',
      model: 'glm-5.3-flash',
      evidence: 'zai-documented-model-contract',
    })
  })

  it('keeps unlisted z.ai models unknown rather than inferring vision', async () => {
    await expect(makeZai('glm-4.7').getImageInputCapability()).resolves.toEqual({
      status: 'unknown',
    })
    await expect(makeZai().getImageInputCapability()).resolves.toEqual({ status: 'unknown' })
  })
})
