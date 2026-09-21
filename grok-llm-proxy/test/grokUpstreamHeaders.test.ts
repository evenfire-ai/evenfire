import { describe, expect, it } from 'vitest'
import {
  GROK_UPSTREAM_CLIENT_IDENTIFIER,
  GROK_UPSTREAM_DEFAULT_CLIENT_VERSION,
  GROK_UPSTREAM_USER_AGENT,
  grokUpstreamHeaders,
  resolveGrokClientVersion,
} from '../src/grokUpstreamHeaders.js'

describe('grokUpstreamHeaders', () => {
  it('sends the compatibility version xAI gates on without impersonating the Grok CLI', () => {
    const headers = grokUpstreamHeaders(
      'access-secret',
      { 'content-type': 'application/json' },
      '1.0.34'
    )
    expect(headers['x-grok-client-version']).toBe('1.0.34')
    expect(headers['x-xai-token-auth']).toBe('xai-grok-cli')
    expect(headers['x-grok-client-identifier']).toBe(GROK_UPSTREAM_CLIENT_IDENTIFIER)
    expect(headers['x-grok-client-mode']).toBe('headless')
    expect(headers['user-agent']).toBe(`${GROK_UPSTREAM_USER_AGENT} grok-build/1.0.34`)
    expect(headers.authorization).toBe('Bearer access-secret')
    expect(headers.accept).toBe('text/event-stream')
    // Identity stays Evenfire's: never the CLI's own identifier or UA product.
    expect(JSON.stringify(headers)).not.toContain('grok-shell')
    expect(JSON.stringify(headers)).not.toContain('xai-grok-workspace')
    expect(headers['openai-beta']).toBeUndefined()
    expect(JSON.stringify(headers)).not.toMatch(/sk-|refresh-secret/i)
  })

  it('takes a real dotted release from the operator override', () => {
    expect(resolveGrokClientVersion('1.2.3')).toBe('1.2.3')
    expect(resolveGrokClientVersion('0.1.202')).toBe('0.1.202')
    expect(resolveGrokClientVersion('2.0.0-rc.1')).toBe('2.0.0-rc.1')
  })

  it('falls back to the pinned release when the override is missing or malformed', () => {
    for (const bad of [undefined, '', '   ', 'latest', '1.0', 'v1.0.34', '1.0.34; rm -rf /']) {
      expect(resolveGrokClientVersion(bad)).toBe(GROK_UPSTREAM_DEFAULT_CLIENT_VERSION)
    }
  })
})
