import { describe, expect, it, vi } from 'vitest'
import {
  configurePluginWorkloadSdkBootstrapIdentity,
  resolvePluginWorkloadSdkBootstrapCapabilityFamily,
} from './bootstrapIdentity'

describe('Plugin Workload SDK bootstrap identity', () => {
  it('uses the host capability projection instead of a request-selected family', async () => {
    const verify = vi.fn().mockResolvedValue({
      ready: true,
      contractVersion: 2,
      provider: 'openai',
      model: 'gpt-5.4-mini',
      policyReady: true,
      policyState: 'active',
    })

    const result = await configurePluginWorkloadSdkBootstrapIdentity(
      {
        capabilityFamily: 'promptBridge',
        provider: 'openai',
        model: 'gpt-5.4-mini',
      },
      { capabilityFamily: 'promptBridge', verify }
    )

    expect(result).toMatchObject({
      configured: true,
      ready: true,
      capabilityFamily: 'promptBridge',
      provider: 'openai',
      model: 'gpt-5.4-mini',
    })
    expect(verify).toHaveBeenCalledWith('openai', 'gpt-5.4-mini')
  })

  it('rejects a request that tries to switch the projected family before verification', async () => {
    const verify = vi.fn()

    const result = await configurePluginWorkloadSdkBootstrapIdentity(
      {
        capabilityFamily: 'clientNotifications',
        provider: 'openai',
        model: 'gpt-5.4-mini',
      },
      { capabilityFamily: 'promptBridge', verify }
    )

    expect(result).toEqual({
      configured: false,
      ready: false,
      contractVersion: 2,
      capabilityFamily: 'promptBridge',
      message: 'Plugin Workload SDK bootstrap capability family does not match the host projection',
    })
    expect(verify).not.toHaveBeenCalled()
  })

  it('keeps notifications-only bootstrap provider-free under its projected family', async () => {
    const verifyClientNotifications = vi.fn().mockResolvedValue({
      ready: true,
      contractVersion: 2,
      policyReady: true,
      policyState: 'active',
    })
    const onConfigured = vi.fn()

    const result = await configurePluginWorkloadSdkBootstrapIdentity(
      { capabilityFamily: 'clientNotifications', provider: 'openai', model: 'gpt-5.4-mini' },
      { capabilityFamily: 'clientNotifications', verifyClientNotifications, onConfigured }
    )

    expect(result).toMatchObject({
      configured: true,
      ready: true,
      capabilityFamily: 'clientNotifications',
      policyReady: true,
      policyState: 'active',
    })
    expect(verifyClientNotifications).toHaveBeenCalledOnce()
    expect(onConfigured).not.toHaveBeenCalled()
  })

  it('maps the mounted capability projection to the bootstrap proof family', () => {
    expect(resolvePluginWorkloadSdkBootstrapCapabilityFamily(['promptBridge'])).toBe('promptBridge')
    expect(
      resolvePluginWorkloadSdkBootstrapCapabilityFamily(['promptBridge', 'clientNotifications'])
    ).toBe('promptBridge')
    expect(resolvePluginWorkloadSdkBootstrapCapabilityFamily(['clientNotifications'])).toBe(
      'clientNotifications'
    )
  })
})
