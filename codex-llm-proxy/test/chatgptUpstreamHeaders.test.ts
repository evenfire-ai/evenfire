import { describe, expect, it } from 'vitest'
import {
  chatgptAccountIdFromAccessToken,
  chatgptUpstreamHeaders,
  CODEX_UPSTREAM_ORIGINATOR,
} from '../src/chatgptUpstreamHeaders.js'

function jwtWithPayload(payload: Record<string, unknown>): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `hdr.${encoded}.sig`
}

describe('chatgptUpstreamHeaders', () => {
  it('attaches ChatGPT-Account-ID from the OpenAI auth claim without leaking the token', () => {
    const token = jwtWithPayload({
      sub: 'user-1',
      'https://api.openai.com/auth': { chatgpt_account_id: 'acct_live_1' },
    })
    const headers = chatgptUpstreamHeaders(token, { accept: 'application/json' })
    expect(headers['chatgpt-account-id']).toBe('acct_live_1')
    expect(headers.originator).toBe(CODEX_UPSTREAM_ORIGINATOR)
    expect(headers.originator).not.toBe('codex_cli_rs')
    expect(headers['openai-beta']).toBe('responses=v1')
    expect(headers.version).toBe('1.0.0')
    expect(JSON.stringify(headers)).not.toMatch(/sk-|refresh-secret/i)
  })

  it('omits the account header when the access token is not a JWT', () => {
    expect(chatgptAccountIdFromAccessToken('opaque-token')).toBeUndefined()
    const headers = chatgptUpstreamHeaders('opaque-token')
    expect(headers['chatgpt-account-id']).toBeUndefined()
    expect(headers.authorization).toBe('Bearer opaque-token')
  })

  it('also reads chatgpt_account_id from a nested auth object', () => {
    const token = jwtWithPayload({ auth: { chatgpt_account_id: 'acct_nested' } })
    expect(chatgptAccountIdFromAccessToken(token)).toBe('acct_nested')
  })
})
