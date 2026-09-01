import { describe, expect, it } from 'vitest'
import type { RpcConnector } from '../../../../src/types'
import { scopeCaption, statusPresentation } from '../connectorPresentation'

const connector = (overrides: Partial<RpcConnector>): RpcConnector => ({
  name: 'x',
  status: 'requires_setup',
  ...overrides,
})

describe('statusPresentation', () => {
  it('maps each grant status to a label + pill tone', () => {
    expect(statusPresentation('authorized')).toEqual({ label: 'Authorized', tone: 'success' })
    expect(statusPresentation('requires_setup')).toEqual({
      label: 'Requires setup',
      tone: 'warning',
    })
    expect(statusPresentation('no_oauth')).toEqual({ label: 'No OAuth', tone: 'neutral' })
  })
})

describe('scopeCaption', () => {
  it('returns null for a non-OAuth connector', () => {
    expect(scopeCaption(connector({ status: 'no_oauth' }))).toBeNull()
  })

  it('flags an oauth-context / context-scoped grant as team-shared', () => {
    expect(scopeCaption(connector({ authKind: 'oauth-context' }))).toMatch(/Shared by the team/i)
    expect(scopeCaption(connector({ grantScope: 'context' }))).toMatch(/Shared by the team/i)
  })

  it('flags an oauth-user grant as affecting all your agents', () => {
    expect(scopeCaption(connector({ authKind: 'oauth-user', grantScope: 'user' }))).toMatch(
      /Affects all your agents/i
    )
  })

  it('returns null for a non-OAuth-governed connector with a live status', () => {
    expect(scopeCaption(connector({ authKind: 'static' }))).toBeNull()
  })
})
