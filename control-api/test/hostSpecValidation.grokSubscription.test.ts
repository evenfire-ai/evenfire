import { afterEach, describe, expect, it, vi } from 'vitest'
import { validateHostSpec } from '../src/routes/admin/hostSpecValidation.js'

afterEach(() => {
  delete process.env.CONTROL_API_GROK_SUBSCRIPTION_ENABLED
})

describe('grok-subscription Host admission', () => {
  it('rejects a Grok target when the Grok management flag is absent or false', async () => {
    const isModelAllowed = vi.fn().mockResolvedValue(true)
    const res = await validateHostSpec(
      { model: { provider: 'grok-subscription', name: 'grok-4.6' } },
      { isModelAllowed }
    )
    expect(res).not.toBeNull()
    expect(res!.errors[0].message).toMatch(/CONTROL_API_GROK_SUBSCRIPTION_ENABLED/)
    expect(isModelAllowed).not.toHaveBeenCalled()
  })

  it('does not tolerate switching a Grok Host onto a revoked connectionRef with the same model', async () => {
    process.env.CONTROL_API_GROK_SUBSCRIPTION_ENABLED = 'true'
    const isModelAllowed = vi.fn(async (_provider, _model, connectionRef) => {
      return connectionRef === 'team-grok'
    })
    const tolerations: Array<Record<string, unknown>> = []
    const res = await validateHostSpec(
      {
        model: {
          provider: 'grok-subscription',
          name: 'grok-4.6',
          connectionRef: 'revoked-grok',
        },
      },
      { isModelAllowed },
      {
        stored: {
          model: {
            provider: 'grok-subscription',
            name: 'grok-4.6',
            connectionRef: 'team-grok',
          },
        },
        hostRef: { namespace: 'mcp-host', name: 'agent-g' },
        tolerations,
      }
    )
    expect(res).not.toBeNull()
    expect(res!.errors[0].message).toContain('model_not_allowed')
    expect(tolerations).toEqual([])
    expect(isModelAllowed).toHaveBeenCalledWith('grok-subscription', 'grok-4.6', 'revoked-grok')
  })
})

// RP-001: the Host's oauth-broker grant must reach the per-host subset
// (allowedModels) and the same-broker fallback gates, not only the primary.
// The stub answers per grant key, so a gate that drops or swaps the key fails.
describe('oauth-broker connectionRef reaches allowedModels and fallbacks (RP-001)', () => {
  afterEach(() => {
    delete process.env.CONTROL_API_CODEX_SUBSCRIPTION_ENABLED
  })

  const brokers = [
    {
      provider: 'grok-subscription',
      flag: 'CONTROL_API_GROK_SUBSCRIPTION_ENABLED',
      key: 'team-grok',
      primary: 'grok-4.6',
      extra: 'grok-4.6-mini',
    },
    {
      provider: 'codex-subscription',
      flag: 'CONTROL_API_CODEX_SUBSCRIPTION_ENABLED',
      key: 'team-codex',
      primary: 'gpt-5.5',
      extra: 'gpt-5.5-mini',
    },
  ] as const

  const grantOffers = (key: string) =>
    vi.fn(async (_provider: string, _model: string, connectionRef?: string) => {
      return connectionRef === key
    })

  for (const b of brokers) {
    describe(b.provider, () => {
      it('accepts a subset entry the selected grant offers and checks it against that grant', async () => {
        process.env[b.flag] = 'true'
        const isModelAllowed = grantOffers(b.key)
        const res = await validateHostSpec(
          {
            model: { provider: b.provider, name: b.primary, connectionRef: b.key },
            allowedModels: [
              { provider: b.provider, model: b.primary },
              { provider: b.provider, model: b.extra },
            ],
          },
          { isModelAllowed }
        )
        expect(res).toBeNull()
        expect(isModelAllowed).toHaveBeenCalledWith(b.provider, b.extra, b.key)
      })

      it('accepts a same-broker fallback the selected grant offers and checks it against that grant', async () => {
        process.env[b.flag] = 'true'
        const isModelAllowed = grantOffers(b.key)
        const res = await validateHostSpec(
          {
            model: { provider: b.provider, name: b.primary, connectionRef: b.key },
            llmPolicy: { fallbacks: [{ provider: b.provider, model: b.extra }] },
          },
          { isModelAllowed }
        )
        expect(res).toBeNull()
        expect(isModelAllowed).toHaveBeenCalledWith(b.provider, b.extra, b.key)
      })

      it('rejects a subset entry only another grant offers (model_not_allowed)', async () => {
        process.env[b.flag] = 'true'
        const isModelAllowed = vi.fn(
          async (_provider: string, model: string, connectionRef?: string) =>
            model === b.extra ? connectionRef === 'other-grant' : connectionRef === b.key
        )
        const res = await validateHostSpec(
          {
            model: { provider: b.provider, name: b.primary, connectionRef: b.key },
            allowedModels: [
              { provider: b.provider, model: b.primary },
              { provider: b.provider, model: b.extra },
            ],
          },
          { isModelAllowed }
        )
        expect(res).not.toBeNull()
        expect(res!.errors[0].field).toBe('spec.allowedModels[1].model')
        expect(res!.errors[0].message).toContain('model_not_allowed')
      })

      it('rejects a same-broker fallback when the selected grant is revoked (model_not_allowed)', async () => {
        process.env[b.flag] = 'true'
        // The revoked grant still covers the primary through no-worsening
        // tolerance on an unchanged stored Host; the NEW fallback must not ride it.
        const isModelAllowed = vi.fn(async () => false)
        const stored = {
          model: { provider: b.provider, name: b.primary, connectionRef: 'revoked-grant' },
        }
        const res = await validateHostSpec(
          {
            model: { provider: b.provider, name: b.primary, connectionRef: 'revoked-grant' },
            llmPolicy: { fallbacks: [{ provider: b.provider, model: b.extra }] },
          },
          { isModelAllowed },
          { stored, hostRef: { namespace: 'mcp-host', name: 'agent' }, tolerations: [] }
        )
        expect(res).not.toBeNull()
        expect(res!.errors[0].field).toBe('spec.llmPolicy.fallbacks[0].model')
        expect(isModelAllowed).toHaveBeenCalledWith(b.provider, b.extra, 'revoked-grant')
      })

      it('does not leak the broker connectionRef to a static-provider subset entry', async () => {
        process.env[b.flag] = 'true'
        const isModelAllowed = vi.fn(async () => true)
        const res = await validateHostSpec(
          {
            model: { provider: b.provider, name: b.primary, connectionRef: b.key },
            secretRef: 'llm-keys',
            allowedModels: [
              { provider: b.provider, model: b.primary },
              { provider: 'openai', model: 'gpt-5.1' },
            ],
            llmPolicy: { fallbacks: [{ provider: 'openai', model: 'gpt-5.1' }] },
          },
          { isModelAllowed }
        )
        expect(res).toBeNull()
        expect(isModelAllowed).toHaveBeenCalledWith('openai', 'gpt-5.1', undefined)
        expect(isModelAllowed).not.toHaveBeenCalledWith('openai', 'gpt-5.1', b.key)
      })

      it('skips grant lookups for broker subset/fallback entries on an unassigned Host', async () => {
        process.env[b.flag] = 'true'
        const isModelAllowed = vi.fn(async () => false)
        const res = await validateHostSpec(
          {
            model: { provider: b.provider, name: b.primary },
            allowedModels: [
              { provider: b.provider, model: b.primary },
              { provider: b.provider, model: b.extra },
            ],
            llmPolicy: { fallbacks: [{ provider: b.provider, model: b.extra }] },
          },
          { isModelAllowed }
        )
        expect(res).toBeNull()
        expect(isModelAllowed).not.toHaveBeenCalled()
      })
    })
  }

  it('uses the Grok grant for a Grok fallback behind a static primary', async () => {
    process.env.CONTROL_API_GROK_SUBSCRIPTION_ENABLED = 'true'
    const isModelAllowed = vi.fn(
      async (provider: string, _model: string, connectionRef?: string) =>
        provider === 'openai' ? connectionRef === undefined : connectionRef === 'team-grok'
    )
    const res = await validateHostSpec(
      {
        model: { provider: 'openai', name: 'gpt-5.1', connectionRef: 'team-grok' },
        secretRef: 'llm-keys',
        llmPolicy: { fallbacks: [{ provider: 'grok-subscription', model: 'grok-4.6' }] },
      },
      { isModelAllowed }
    )
    expect(res).toBeNull()
    expect(isModelAllowed).toHaveBeenCalledWith('grok-subscription', 'grok-4.6', 'team-grok')
  })
})
