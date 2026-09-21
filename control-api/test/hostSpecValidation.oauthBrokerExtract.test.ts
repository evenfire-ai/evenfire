import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@clerum/llm-providers', async () => {
  const actual =
    await vi.importActual<typeof import('@clerum/llm-providers')>('@clerum/llm-providers')
  return {
    ...actual,
    isLlmProviderId: (id: unknown): id is (typeof actual.PROVIDER_IDS)[number] =>
      actual.isLlmProviderId(id) || id === 'fixture-broker',
    PROVIDER_AUTH_MODE: {
      ...actual.PROVIDER_AUTH_MODE,
      'fixture-broker': 'oauth-broker',
    },
  }
})

const { validateHostSpec } = await import('../src/routes/admin/hostSpecValidation.js')

describe('oauth-broker extract admission', () => {
  afterEach(() => {
    delete process.env.CONTROL_API_CODEX_SUBSCRIPTION_ENABLED
  })

  it('rejects two distinct oauth-broker ids on one Host', async () => {
    process.env.CONTROL_API_CODEX_SUBSCRIPTION_ENABLED = 'true'
    const res = await validateHostSpec(
      {
        model: { provider: 'codex-subscription', name: 'gpt-5.1' },
        allowedModels: [{ provider: 'fixture-broker', name: 'fixture-1' }],
      },
      { isModelAllowed: vi.fn().mockResolvedValue(true) }
    )
    expect(res).not.toBeNull()
    expect(res!.errors[0].message).toMatch(/at most one oauth-broker/)
  })
})
