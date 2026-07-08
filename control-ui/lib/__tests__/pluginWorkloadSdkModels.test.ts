import { describe, expect, it } from 'vitest'
import {
  appendCustomPluginWorkloadSdkModel,
  buildPluginWorkloadSdkModelOptions,
  getCustomPluginWorkloadSdkModelError,
  validateCustomPluginWorkloadSdkModel,
} from '../pluginWorkloadSdkModels'

describe('plugin workload SDK model helpers', () => {
  it('keeps known provider models and appends selected custom models', () => {
    const options = buildPluginWorkloadSdkModelOptions('zai', [
      'glm-5.1',
      'glm-6-preview',
      'glm-6-preview',
    ])

    expect(options.slice(0, 2)).toEqual(['glm-5.2', 'glm-5.1'])
    expect(options.filter(model => model === 'glm-6-preview')).toHaveLength(1)
    expect(options.at(-1)).toBe('glm-6-preview')
  })

  it('accepts a trimmed configured custom model name', () => {
    expect(validateCustomPluginWorkloadSdkModel('  glm-6-preview  ', ['glm-5.1'])).toEqual({
      ok: true,
      model: 'glm-6-preview',
    })
  })

  it('rejects empty, wildcard, and duplicate custom model names', () => {
    expect(validateCustomPluginWorkloadSdkModel('', [])).toEqual({
      ok: false,
      reason: 'empty',
    })
    expect(validateCustomPluginWorkloadSdkModel('glm-*', [])).toEqual({
      ok: false,
      reason: 'wildcard',
    })
    expect(validateCustomPluginWorkloadSdkModel('glm-5.1', ['glm-5.1'])).toEqual({
      ok: false,
      reason: 'duplicate',
    })
  })

  it('appends only valid custom model names', () => {
    expect(appendCustomPluginWorkloadSdkModel(['glm-5.1'], ' glm-6-preview ')).toEqual([
      'glm-5.1',
      'glm-6-preview',
    ])
    expect(appendCustomPluginWorkloadSdkModel(['glm-5.1'], 'glm-*')).toEqual(['glm-5.1'])
  })

  it('returns user-facing errors only for actionable invalid custom model input', () => {
    expect(getCustomPluginWorkloadSdkModelError('', [])).toBe('')
    expect(getCustomPluginWorkloadSdkModelError('glm-*', [])).toBe(
      'Model names cannot contain wildcards.'
    )
    expect(getCustomPluginWorkloadSdkModelError('glm-5.1', ['glm-5.1'])).toBe(
      'That model is already selected.'
    )
  })
})
