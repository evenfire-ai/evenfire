import { describe, expect, it } from 'vitest'
import { credentialSelectValue, parseCredentialSelect } from '../llmCredentialSelect'

describe('llmCredentialSelect', () => {
  it('encodes a subscription without colliding with a secret of the same name', () => {
    expect(credentialSelectValue('Team Plus', 'codex-aaa')).toBe('sub:codex-subscription:codex-aaa')
    expect(parseCredentialSelect('sub:codex-aaa')).toEqual({
      kind: 'subscription',
      provider: 'codex-subscription',
      connectionKey: 'codex-aaa',
    })
    expect(parseCredentialSelect('sub:grok-subscription:team-grok')).toEqual({
      kind: 'subscription',
      provider: 'grok-subscription',
      connectionKey: 'team-grok',
    })
    expect(credentialSelectValue('', 'team-grok', 'grok-subscription')).toBe(
      'sub:grok-subscription:team-grok'
    )
    expect(parseCredentialSelect('Team Plus')).toEqual({ kind: 'secret', name: 'Team Plus' })
  })

  it('treats unassigned and blank as empty', () => {
    expect(credentialSelectValue('', 'unassigned')).toBe('')
    expect(parseCredentialSelect('')).toEqual({ kind: 'empty' })
    expect(parseCredentialSelect('sub:unassigned')).toEqual({ kind: 'empty' })
  })
})
