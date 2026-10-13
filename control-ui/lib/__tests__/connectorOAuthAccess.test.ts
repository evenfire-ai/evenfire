import { describe, expect, it } from 'vitest'
import {
  CONTEXT_OAUTH_SCOPE_ERROR,
  SHARED_GRANT_REQUIRES_AGENT_ERROR,
  canAssignConnectorToContext,
  connectorContextAssignmentError,
  sharedGrantScopeError,
} from '../connectorOAuthAccess'

describe('context-scoped OAuth connector access', () => {
  const contextOAuthSpec = {
    contextRef: 'ctx-alpha',
    oauth: { grantScope: 'context' },
  }

  it('allows multiple Agents that share the authoritative Context', () => {
    expect(connectorContextAssignmentError(contextOAuthSpec, ['ctx-alpha', 'ctx-alpha'])).toBe(
      undefined
    )
  })

  it('fails closed when a selected Agent belongs to another Context', () => {
    expect(canAssignConnectorToContext(contextOAuthSpec, 'ctx-beta')).toBe(false)
    expect(connectorContextAssignmentError(contextOAuthSpec, ['ctx-alpha', 'ctx-beta'])).toBe(
      CONTEXT_OAUTH_SCOPE_ERROR
    )
  })

  it('does not constrain non-context OAuth connectors', () => {
    expect(
      connectorContextAssignmentError({ contextRef: 'ctx-alpha', oauth: { grantScope: 'user' } }, [
        'ctx-beta',
      ])
    ).toBeUndefined()
  })
})

describe('shared grant scope for a new remote install', () => {
  it('requires at least one agent for a shared grant', () => {
    expect(sharedGrantScopeError('context', [])).toBe(SHARED_GRANT_REQUIRES_AGENT_ERROR)
  })

  it('allows a shared grant for agents in one Context', () => {
    expect(sharedGrantScopeError('context', ['ctx-alpha'])).toBeUndefined()
  })

  it('blocks a shared grant across distinct Contexts', () => {
    expect(sharedGrantScopeError('context', ['ctx-alpha', 'ctx-beta'])).toBe(
      CONTEXT_OAUTH_SCOPE_ERROR
    )
  })

  it('does not constrain a per-user grant', () => {
    expect(sharedGrantScopeError('user', [])).toBeUndefined()
    expect(sharedGrantScopeError('user', ['ctx-alpha', 'ctx-beta'])).toBeUndefined()
  })
})
