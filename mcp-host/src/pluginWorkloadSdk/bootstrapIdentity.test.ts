import { describe, expect, it, vi } from 'vitest'
import { CODEX_UNASSIGNED_CONNECTION_KEY } from '@clerum/codex-catalog-projection'
import { computeCodexPolicyHash } from '@clerum/llm-provider-attempt-contract'
import {
  configurePluginWorkloadSdkBootstrapIdentity,
  resolvePluginWorkloadSdkBootstrapCapabilityFamily,
} from './bootstrapIdentity'
import * as sdkOnlyCodexBinding from './sdkOnlyCodexBinding'
import {
  readSdkOnlyCodexBinding,
  readVerifiedSdkOnlyCodexBinding,
  replaceSdkOnlyCodexBinding,
} from './sdkOnlyCodexBinding'

describe('readVerifiedSdkOnlyCodexBinding', () => {
  const model = 'gpt-5.6-luna'
  const binding = {
    connectionKey: 'team-plus',
    catalogRevision: 4,
    credentialRevision: 1,
    model,
    bindingHash: computeCodexPolicyHash({
      model,
      catalogRevision: 4,
      credentialRevision: 1,
      connectionKey: 'team-plus',
    }),
  }

  it('accepts only a hash that matches the bound fields and expected model', () => {
    expect(readVerifiedSdkOnlyCodexBinding(binding, model)).toEqual(binding)
    expect(
      readVerifiedSdkOnlyCodexBinding({ ...binding, bindingHash: 'a'.repeat(64) }, model)
    ).toBeNull()
    expect(readVerifiedSdkOnlyCodexBinding(binding, 'gpt-5.4-mini')).toBeNull()
    expect(readVerifiedSdkOnlyCodexBinding(undefined, model)).toBeNull()
    expect(readVerifiedSdkOnlyCodexBinding({ ...binding, extra: 'drop-me' }, model)).toEqual(
      binding
    )
  })

  it('rejects the shared unassigned connection sentinel', () => {
    expect(
      readVerifiedSdkOnlyCodexBinding(
        {
          ...binding,
          connectionKey: CODEX_UNASSIGNED_CONNECTION_KEY,
          bindingHash: computeCodexPolicyHash({
            model,
            catalogRevision: 4,
            credentialRevision: 1,
            connectionKey: CODEX_UNASSIGNED_CONNECTION_KEY,
          }),
        },
        model
      )
    ).toBeNull()
  })
})

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

  it('keeps Codex identity ready while the v3 execution binding is missing', async () => {
    replaceSdkOnlyCodexBinding(null)
    const verify = vi.fn()
    const result = await configurePluginWorkloadSdkBootstrapIdentity(
      {
        capabilityFamily: 'promptBridge',
        provider: 'codex-subscription',
        model: 'gpt-5.6-luna',
        contractVersion: 2,
      },
      { capabilityFamily: 'promptBridge', verify }
    )
    expect(result).toMatchObject({
      configured: true,
      ready: true,
      contractVersion: 3,
      policyReady: false,
      policyReason: 'codex_execution_binding_missing',
    })
    expect(verify).not.toHaveBeenCalled()
    expect(readSdkOnlyCodexBinding()).toBeNull()
  })

  it('stores a verified v3 Codex binding before identity verification', async () => {
    const binding = {
      connectionKey: 'team-plus',
      catalogRevision: 4,
      credentialRevision: 1,
      model: 'gpt-5.6-luna',
      bindingHash: computeCodexPolicyHash({
        model: 'gpt-5.6-luna',
        catalogRevision: 4,
        credentialRevision: 1,
        connectionKey: 'team-plus',
      }),
    }
    const verify = vi.fn().mockResolvedValue({
      ready: true,
      contractVersion: 3,
      provider: 'codex-subscription',
      model: 'gpt-5.6-luna',
      policyReady: true,
      policyState: 'active',
      codexBindingReady: true,
    })
    const result = await configurePluginWorkloadSdkBootstrapIdentity(
      {
        capabilityFamily: 'promptBridge',
        provider: 'codex-subscription',
        model: 'gpt-5.6-luna',
        contractVersion: 3,
        codexBinding: binding,
      },
      { capabilityFamily: 'promptBridge', verify }
    )
    expect(result).toMatchObject({
      configured: true,
      ready: true,
      contractVersion: 3,
      provider: 'codex-subscription',
      model: 'gpt-5.6-luna',
      codexBinding: binding,
    })
    expect(readSdkOnlyCodexBinding()).toEqual(binding)
    replaceSdkOnlyCodexBinding(null)
  })

  it('integrity-checks a supplied Codex binding even when the request provider is not Codex', async () => {
    replaceSdkOnlyCodexBinding(null)
    const verifyBinding = vi.spyOn(sdkOnlyCodexBinding, 'readVerifiedSdkOnlyCodexBinding')
    const binding = {
      connectionKey: 'team-plus',
      catalogRevision: 4,
      credentialRevision: 1,
      model: 'gpt-5.4-mini',
      bindingHash: computeCodexPolicyHash({
        model: 'gpt-5.4-mini',
        catalogRevision: 4,
        credentialRevision: 1,
        connectionKey: 'team-plus',
      }),
    }
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
        contractVersion: 2,
        codexBinding: binding,
      },
      { capabilityFamily: 'promptBridge', verify }
    )
    expect(result).toMatchObject({
      configured: true,
      ready: true,
      provider: 'openai',
      contractVersion: 2,
    })
    expect(result).not.toHaveProperty('codexBinding')
    expect(verifyBinding).toHaveBeenCalledWith(binding, 'gpt-5.4-mini')
    expect(readSdkOnlyCodexBinding()).toBeNull()
    verifyBinding.mockRestore()
  })

  it('rejects a Codex binding whose hash does not match the bound fields', async () => {
    replaceSdkOnlyCodexBinding(null)
    const verify = vi.fn()
    const result = await configurePluginWorkloadSdkBootstrapIdentity(
      {
        capabilityFamily: 'promptBridge',
        provider: 'codex-subscription',
        model: 'gpt-5.6-luna',
        contractVersion: 3,
        codexBinding: {
          connectionKey: 'team-plus',
          catalogRevision: 4,
          credentialRevision: 1,
          model: 'gpt-5.6-luna',
          bindingHash: 'a'.repeat(64),
        },
      },
      { capabilityFamily: 'promptBridge', verify }
    )
    expect(result).toMatchObject({
      configured: true,
      ready: true,
      contractVersion: 3,
      policyReady: false,
      policyReason: 'codex_execution_binding_missing',
    })
    expect(verify).not.toHaveBeenCalled()
    expect(readSdkOnlyCodexBinding()).toBeNull()
  })

  it('accepts a hash-valid Codex binding even if the request echoes contract v2', async () => {
    const binding = {
      connectionKey: 'team-plus',
      catalogRevision: 4,
      credentialRevision: 1,
      model: 'gpt-5.6-luna',
      bindingHash: computeCodexPolicyHash({
        model: 'gpt-5.6-luna',
        catalogRevision: 4,
        credentialRevision: 1,
        connectionKey: 'team-plus',
      }),
    }
    const verify = vi.fn().mockResolvedValue({
      ready: true,
      contractVersion: 3,
      provider: 'codex-subscription',
      model: 'gpt-5.6-luna',
      policyReady: true,
      policyState: 'active',
      codexBindingReady: true,
    })
    const result = await configurePluginWorkloadSdkBootstrapIdentity(
      {
        capabilityFamily: 'promptBridge',
        provider: 'codex-subscription',
        model: 'gpt-5.6-luna',
        contractVersion: 2,
        codexBinding: binding,
      },
      { capabilityFamily: 'promptBridge', verify }
    )
    expect(result).toMatchObject({
      configured: true,
      ready: true,
      contractVersion: 3,
      codexBinding: binding,
    })
    expect(readSdkOnlyCodexBinding()).toEqual(binding)
    replaceSdkOnlyCodexBinding(null)
  })

  it('echoes a sanitized five-field Codex binding instead of extra request keys', async () => {
    const binding = {
      connectionKey: 'team-plus',
      catalogRevision: 4,
      credentialRevision: 1,
      model: 'gpt-5.6-luna',
      bindingHash: computeCodexPolicyHash({
        model: 'gpt-5.6-luna',
        catalogRevision: 4,
        credentialRevision: 1,
        connectionKey: 'team-plus',
      }),
    }
    const verify = vi.fn().mockResolvedValue({
      ready: true,
      contractVersion: 3,
      provider: 'codex-subscription',
      model: 'gpt-5.6-luna',
      policyReady: true,
      policyState: 'active',
      codexBindingReady: true,
    })
    const result = await configurePluginWorkloadSdkBootstrapIdentity(
      {
        capabilityFamily: 'promptBridge',
        provider: 'codex-subscription',
        model: 'gpt-5.6-luna',
        contractVersion: 3,
        codexBinding: { ...binding, leaked: 'drop-me' } as typeof binding,
      },
      { capabilityFamily: 'promptBridge', verify }
    )
    expect(result.codexBinding).toEqual(binding)
    expect(result.codexBinding).not.toHaveProperty('leaked')
    replaceSdkOnlyCodexBinding(null)
  })
})
