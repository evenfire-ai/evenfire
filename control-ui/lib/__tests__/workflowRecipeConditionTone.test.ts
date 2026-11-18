import { describe, expect, it } from 'vitest'
import { conditionTone } from '../workflowRecipeConditionTone'

describe('conditionTone', () => {
  describe('T-UI-1: WorkflowRecipe controller problem conditions', () => {
    it('shows EnvSecretOwnershipDenied=True as an error', () => {
      expect(conditionTone({ type: 'EnvSecretOwnershipDenied', status: 'True' })).toBe('error')
    })

    it('shows StatefulSetImmutableDrift=True as an error', () => {
      expect(conditionTone({ type: 'StatefulSetImmutableDrift', status: 'True' })).toBe('error')
    })

    it('shows EnvSecretOwnershipDenied=False (every referenced Secret owned or shared) as ok', () => {
      expect(conditionTone({ type: 'EnvSecretOwnershipDenied', status: 'False' })).toBe('ok')
    })
  })

  describe('T-UI-1 pins: tones of other condition types are unchanged', () => {
    it('keeps WebhookDormant informational when True and ok when False', () => {
      expect(conditionTone({ type: 'WebhookDormant', status: 'True' })).toBe('info')
      expect(conditionTone({ type: 'WebhookDormant', status: 'False' })).toBe('ok')
    })

    it('keeps *Missing types as errors when True and ok when False', () => {
      expect(conditionTone({ type: 'WebhookSecretMissing', status: 'True' })).toBe('error')
      expect(conditionTone({ type: 'WebhookSecretMissing', status: 'False' })).toBe('ok')
    })

    it('keeps positive types ok when True and a warning when False', () => {
      expect(conditionTone({ type: 'InternalDependenciesReady', status: 'True' })).toBe('ok')
      expect(conditionTone({ type: 'InternalDependenciesReady', status: 'False' })).toBe('warn')
    })
  })
})
