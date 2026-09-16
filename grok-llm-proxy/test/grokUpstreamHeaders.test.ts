import { describe, expect, it } from 'vitest'
import { GROK_UPSTREAM_USER_AGENT, grokUpstreamHeaders } from '../src/grokUpstreamHeaders.js'

describe('grokUpstreamHeaders', () => {
  it('stamps Evenfire identity and does not impersonate the Grok CLI', () => {
    const headers = grokUpstreamHeaders('access-secret', { 'content-type': 'application/json' })
    expect(headers['user-agent']).toBe(GROK_UPSTREAM_USER_AGENT)
    expect(headers.accept).toBe('text/event-stream')
    expect(headers.authorization).toBe('Bearer access-secret')
    expect(headers['openai-beta']).toBeUndefined()
    expect(headers['x-xai-token-auth']).toBeUndefined()
    expect(headers['x-grok-client-identifier']).toBeUndefined()
    expect(JSON.stringify(headers)).not.toContain('grok-shell')
    expect(JSON.stringify(headers)).not.toMatch(/sk-|refresh-secret/i)
  })
})
