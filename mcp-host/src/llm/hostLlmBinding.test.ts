import { describe, expect, it } from 'vitest'
import { assignedConnectionRef, hostPrimaryLlmBindingChanged } from './hostLlmBinding'

describe('hostPrimaryLlmBindingChanged', () => {
  it('treats a connectionRef swap as a credential-surface change', () => {
    const change = hostPrimaryLlmBindingChanged(
      {
        provider: 'codex-subscription',
        name: 'gpt-5.1',
        connectionRef: 'deployment-default',
        secretRef: undefined,
      },
      {
        provider: 'codex-subscription',
        name: 'gpt-5.1',
        connectionRef: 'team-plus',
        secretRef: undefined,
      }
    )
    expect(change.providerChanged).toBe(false)
    expect(change.modelChanged).toBe(false)
    expect(change.secretRefChanged).toBe(false)
    expect(change.connectionRefChanged).toBe(true)
  })

  it('does not treat a Phase 1 missing ref as a change from deployment-default', () => {
    const change = hostPrimaryLlmBindingChanged(
      {
        provider: 'codex-subscription',
        name: 'gpt-5.1',
        connectionRef: undefined,
      },
      {
        provider: 'codex-subscription',
        name: 'gpt-5.1',
        connectionRef: 'deployment-default',
      }
    )
    expect(change.connectionRefChanged).toBe(false)
    expect(assignedConnectionRef(undefined)).toBe('deployment-default')
  })
})
