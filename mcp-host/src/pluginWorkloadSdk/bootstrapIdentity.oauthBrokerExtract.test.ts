import { describe, expect, it, vi } from 'vitest'
import type { LlmProvider } from '../llm/registryCore'
import { configurePluginWorkloadSdkBootstrapIdentity } from './bootstrapIdentity'

vi.mock('@clerum/llm-providers', async () => {
  const actual =
    await vi.importActual<typeof import('@clerum/llm-providers')>('@clerum/llm-providers')
  return {
    ...actual,
    isLlmProviderId: (id: unknown): boolean =>
      actual.isLlmProviderId(id) || id === 'fixture-broker',
    PROVIDER_AUTH_MODE: {
      ...actual.PROVIDER_AUTH_MODE,
      'fixture-broker': 'oauth-broker',
    },
  }
})

vi.mock('../llm/registryCore', async () => {
  const actual = await vi.importActual<typeof import('../llm/registryCore')>('../llm/registryCore')
  return {
    ...actual,
    isLlmProvider: (id: string) => actual.isLlmProvider(id) || id === 'fixture-broker',
  }
})

const FIXTURE_BROKER = 'fixture-broker' as LlmProvider

describe('oauth-broker extract bootstrap', () => {
  it('uses contractVersion 3 for an injected fixture broker', async () => {
    const result = await configurePluginWorkloadSdkBootstrapIdentity(
      {
        capabilityFamily: 'promptBridge',
        provider: FIXTURE_BROKER,
        model: 'fixture-1',
      },
      { capabilityFamily: 'promptBridge' }
    )
    expect(result.contractVersion).toBe(3)
    expect(result.policyReason).toBe('codex_execution_binding_missing')
  })
})
