import { describe, expect, it } from 'vitest'
import {
  CONTEXT_OAUTH_SCOPE_ERROR,
  canAssignConnectorToContext,
  connectorContextAssignmentError,
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
