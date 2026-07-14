import { describe, expect, it } from 'vitest'
import { describePluginWorkloadSdkCapability } from '../workflowStatus'

describe('describePluginWorkloadSdkCapability', () => {
  it('returns null when the recipe declares no SDK capability', () => {
    expect(describePluginWorkloadSdkCapability(null)).toBeNull()
    expect(describePluginWorkloadSdkCapability(undefined)).toBeNull()
  })

  it('summarizes a validated capability with both families', () => {
    const result = describePluginWorkloadSdkCapability({
      state: 'validated',
      promptBridge: true,
      clientNotifications: true,
    })
    expect(result).toEqual({
      label: 'SDK: promptBridge, clientNotifications',
      tone: 'success',
      title: 'Plugin Workload SDK capability validated (promptBridge, clientNotifications)',
    })
  })

  it('lists only the validated families', () => {
    const result = describePluginWorkloadSdkCapability({
      state: 'validated',
      promptBridge: true,
      clientNotifications: false,
    })
    expect(result?.label).toBe('SDK: promptBridge')
    expect(result?.tone).toBe('success')
  })

  it('renders a neutral disabled pill and surfaces the reason in the title', () => {
    const result = describePluginWorkloadSdkCapability({
      state: 'disabled',
      promptBridge: true,
      clientNotifications: false,
      message: 'Disabled (feature flag off)',
    })
    expect(result).toEqual({
      label: 'SDK: disabled',
      tone: 'neutral',
      title: 'Disabled (feature flag off)',
    })
  })

  it('falls back to a generic title when disabled without a message', () => {
    const result = describePluginWorkloadSdkCapability({
      state: 'disabled',
      promptBridge: false,
      clientNotifications: false,
    })
    expect(result?.tone).toBe('neutral')
    expect(result?.title).toBe('Plugin Workload SDK capability is disabled')
  })
})
