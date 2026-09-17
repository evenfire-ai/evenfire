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
