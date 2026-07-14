import { describe, expect, it } from 'vitest'
import {
  LLM_DEFAULT_MODEL_BY_PROVIDER,
  LLM_MODELS_BY_PROVIDER,
  getDefaultModel,
  getModelOptions,
  inferProviderFromModels,
} from '../llm'

describe('llm model registry', () => {
  describe('ZAI provider', () => {
    it('includes glm-5.2 as a selectable model', () => {
      expect(getModelOptions('zai')).toContain('glm-5.2')
    })

    it('keeps glm-5.1 as the default model', () => {
      expect(getDefaultModel('zai')).toBe('glm-5.1')
      expect(LLM_DEFAULT_MODEL_BY_PROVIDER.zai).toBe('glm-5.1')
    })

    it('lists models newest-first', () => {
      const models = LLM_MODELS_BY_PROVIDER.zai
      expect(models.indexOf('glm-5.2')).toBeLessThan(models.indexOf('glm-5.1'))
    })
  })

  describe('Bailian provider', () => {
    it('includes Qwen and aliased provider models as selectable models', () => {
      expect(getModelOptions('bailian')).toEqual(
        expect.arrayContaining(['qwen3-coder-plus', 'qwen3.5-plus', 'MiniMax-M2.5'])
      )
    })

    it('keeps qwen3-coder-plus as the default model', () => {
      expect(getDefaultModel('bailian')).toBe('qwen3-coder-plus')
      expect(LLM_DEFAULT_MODEL_BY_PROVIDER.bailian).toBe('qwen3-coder-plus')
    })
  })

  describe('getDefaultModel fallback', () => {
    it('returns a model that exists in the options list', () => {
      for (const provider of Object.keys(LLM_MODELS_BY_PROVIDER) as Array<
        keyof typeof LLM_MODELS_BY_PROVIDER
      >) {
        const options = getModelOptions(provider)
        const defaultModel = getDefaultModel(provider)
        expect(options).toContain(defaultModel)
      }
    })
  })

  describe('inferProviderFromModels', () => {
    it('recovers the provider from a known model', () => {
      expect(inferProviderFromModels(['glm-5.1'])).toBe('zai')
      expect(inferProviderFromModels(['claude-sonnet-4-6'])).toBe('claude')
      expect(inferProviderFromModels(['gpt-5.4-mini'])).toBe('openai')
      expect(inferProviderFromModels(['qwen3-coder-plus'])).toBe('bailian')
    })

    it('uses the first recognized model when the list is mixed', () => {
      expect(inferProviderFromModels(['unknown-model', 'glm-5'])).toBe('zai')
    })

    it('defaults to the first provider option for an empty or unknown allowlist', () => {
      expect(inferProviderFromModels([])).toBe('openai')
      expect(inferProviderFromModels(['some-future-model'])).toBe('openai')
    })
  })
})
