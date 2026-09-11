import { describe, expect, it } from 'vitest'
import { chatgptAccountIdFromJwt } from '../src/services/chatgptAccountId.js'

function jwtWithPayload(payload: Record<string, unknown>): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `hdr.${encoded}.sig`
}

describe('chatgptAccountIdFromJwt', () => {
  it('reads chatgpt_account_id from the OpenAI auth claim', () => {
    const token = jwtWithPayload({
      sub: 'user-1',
      'https://api.openai.com/auth': { chatgpt_account_id: 'acct_live_1' },
    })
    expect(chatgptAccountIdFromJwt(token)).toBe('acct_live_1')
  })

  it('returns undefined for opaque tokens', () => {
    expect(chatgptAccountIdFromJwt('opaque-token')).toBeUndefined()
  })
})
