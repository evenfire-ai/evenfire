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

  it('detects a baseURL-only change (openai-compatible endpoint repointed → re-bind)', () => {
    const base = {
      provider: 'openai-compatible',
      name: 'llama-3.3-70b',
      secretRef: 'llm-secret',
    }
    const change = hostPrimaryLlmBindingChanged(
      { ...base, baseURL: 'http://10.0.0.5:8000/v1' },
      { ...base, baseURL: 'http://10.0.0.5:8000/v2' }
    )
    expect(change.baseURLChanged).toBe(true)
    // Nothing else moved — only the endpoint.
    expect(change.providerChanged).toBe(false)
    expect(change.modelChanged).toBe(false)
    expect(change.secretRefChanged).toBe(false)
    expect(change.connectionRefChanged).toBe(false)
  })

  it('treats an unchanged baseURL (and null≈undefined) as no change', () => {
    expect(
      hostPrimaryLlmBindingChanged(
        { provider: 'openai', name: 'gpt-5.4', baseURL: undefined },
        { provider: 'openai', name: 'gpt-5.4', baseURL: null }
      ).baseURLChanged
    ).toBe(false)
    expect(
      hostPrimaryLlmBindingChanged(
        { provider: 'openai-compatible', name: 'm', baseURL: 'http://10.0.0.5/v1' },
        { provider: 'openai-compatible', name: 'm', baseURL: 'http://10.0.0.5/v1' }
      ).baseURLChanged
    ).toBe(false)
  })
})
