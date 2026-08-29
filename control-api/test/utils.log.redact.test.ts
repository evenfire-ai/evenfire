import { describe, expect, it } from 'vitest'
import { REQUIRED_REDACT_PATHS, TOKEN_LEAK_REDACT_PATHS } from '../src/utils/log/redact.js'

describe('token-leak redaction', () => {
  it('every required path is registered in the active redact list', () => {
    for (const required of REQUIRED_REDACT_PATHS) {
      expect(TOKEN_LEAK_REDACT_PATHS).toContain(required)
    }
  })

  it('redact list covers Authorization headers in both request and response shapes', () => {
    expect(TOKEN_LEAK_REDACT_PATHS).toContain('req.headers.authorization')
    expect(TOKEN_LEAK_REDACT_PATHS).toContain('headers.authorization')
  })

  it('redact list covers cross-service token header used by requireInternalToken', () => {
    expect(TOKEN_LEAK_REDACT_PATHS).toContain("req.headers['x-service-token']")
  })

  it('redact list covers JWT pair fields used by approval issuance', () => {
    expect(TOKEN_LEAK_REDACT_PATHS).toContain('accessToken')
    expect(TOKEN_LEAK_REDACT_PATHS).toContain('refreshToken')
  })

  it('redacts ChatGPT account identifiers', () => {
    expect(TOKEN_LEAK_REDACT_PATHS).toContain('chatgptAccountId')
    expect(TOKEN_LEAK_REDACT_PATHS).toContain('accountId')
    expect(REQUIRED_REDACT_PATHS).toContain('chatgptAccountId')
    expect(REQUIRED_REDACT_PATHS).toContain('accountId')
  })

  it('redacts the registry voucher field (defense-in-depth)', () => {
    expect(TOKEN_LEAK_REDACT_PATHS).toContain('voucher')
  })

  it('redacts registry connect claim tokens and client secrets', () => {
    for (const p of ['claim_token', 'claimToken', 'client_secret', 'clientSecret']) {
      expect(TOKEN_LEAK_REDACT_PATHS).toContain(p)
      expect(REQUIRED_REDACT_PATHS).toContain(p)
    }
  })
})
