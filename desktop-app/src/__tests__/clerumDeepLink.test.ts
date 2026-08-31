import { describe, expect, it } from 'vitest'
import { routeClerumOauthCompleted } from '../clerumDeepLink.js'

const PROTO = 'clerum'

describe('routeClerumOauthCompleted — U5 source branching (T5 guardian)', () => {
  it('source ABSENT routes to the sandbox-ui embed, byte-identical to pre-U5', () => {
    const route = routeClerumOauthCompleted(
      'clerum://oauth-completed?clientId=abc123&provider=google',
      PROTO
    )
    // The sandbox-ui / recipe path is unchanged: same clientId + provider envelope
    // the embed dispatch has always consumed.
    expect(route).toEqual({ kind: 'sandbox', oauthClientId: 'abc123', provider: 'google' })
  })

  it('source=mcp routes to the task resume (NOT the embed), carrying mcpServerName', () => {
    const route = routeClerumOauthCompleted(
      'clerum://oauth-completed?clientId=abc123&provider=google&source=mcp&mcpServerName=monday',
      PROTO
    )
    expect(route).toEqual({ kind: 'mcp', mcpServerName: 'monday', provider: 'google' })
    // Guardian: an mcp completion must never be dispatched to the sandbox embed.
    expect(route.kind).not.toBe('sandbox')
  })

  it('source=mcp wins even though the deep-link still carries clientId', () => {
    // control-api builds clientId unconditionally; the branch is on `source`, so
    // the presence of clientId must NOT drag an mcp completion into the embed path.
    const route = routeClerumOauthCompleted(
      'clerum://oauth-completed?clientId=abc123&provider=microsoft-graph&source=mcp&mcpServerName=office365',
      PROTO
    )
    expect(route.kind).toBe('mcp')
  })

  it('an unknown source (!== mcp) falls through to the sandbox path unchanged', () => {
    const route = routeClerumOauthCompleted(
      'clerum://oauth-completed?clientId=abc123&provider=google&source=recipe',
      PROTO
    )
    expect(route).toEqual({ kind: 'sandbox', oauthClientId: 'abc123', provider: 'google' })
  })

  it('missing clientId is ignored for BOTH paths (guard precedes the source branch)', () => {
    expect(routeClerumOauthCompleted('clerum://oauth-completed?provider=google', PROTO).kind).toBe(
      'ignore'
    )
    expect(
      routeClerumOauthCompleted(
        'clerum://oauth-completed?provider=google&source=mcp&mcpServerName=monday',
        PROTO
      ).kind
    ).toBe('ignore')
  })

  it('ignores a non-clerum protocol, a wrong host, and an unparseable URL', () => {
    expect(routeClerumOauthCompleted('https://oauth-completed?clientId=x', PROTO).kind).toBe(
      'ignore'
    )
    expect(routeClerumOauthCompleted('clerum://oauth?clientId=x&source=mcp', PROTO).kind).toBe(
      'ignore'
    )
    expect(routeClerumOauthCompleted('not a url', PROTO).kind).toBe('ignore')
  })

  it('mcpServerName defaults to empty string when absent on an mcp deep-link', () => {
    // Forward-compatibility: if control-api has not yet appended &mcpServerName,
    // the route is still mcp (never sandbox) with an empty key — the renderer then
    // simply finds no correlation match rather than mis-dispatching to the embed.
    const route = routeClerumOauthCompleted(
      'clerum://oauth-completed?clientId=abc123&provider=google&source=mcp',
      PROTO
    )
    expect(route).toEqual({ kind: 'mcp', mcpServerName: '', provider: 'google' })
  })
})
