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

  it('treats a missing ref as unassigned, not as the reserved grant', () => {
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
    expect(change.connectionRefChanged).toBe(true)
    expect(assignedConnectionRef(undefined)).toBe('unassigned')
    expect(assignedConnectionRef('')).toBe('unassigned')
    expect(assignedConnectionRef('deployment-default')).toBe('deployment-default')
  })
})
