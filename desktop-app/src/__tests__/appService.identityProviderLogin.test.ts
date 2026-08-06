import { describe, expect, it } from 'vitest'
import { validateMicrosoftAuthorizeUrl } from '../appService.js'

describe('Microsoft identity provider authorization URLs', () => {
  it('allows the exact Microsoft login origin', () => {
    expect(
      validateMicrosoftAuthorizeUrl(
        'https://login.microsoftonline.com/tenant/oauth2/v2.0/authorize?client_id=client'
      )
    ).toContain('https://login.microsoftonline.com/tenant/oauth2/v2.0/authorize')
  })

  it.each([
    'file:///tmp/authorize',
    'evenfire://auth/microsoft/callback?code=spoofed',
    'http://login.microsoftonline.com/tenant/oauth2/v2.0/authorize',
    'https://login.microsoftonline.com.attacker.test/authorize',
    'https://user:pass@login.microsoftonline.com/authorize',
    'https://login.microsoftonline.com/authorize#unexpected',
  ])('rejects an untrusted authorize URL: %s', value => {
    expect(() => validateMicrosoftAuthorizeUrl(value)).toThrow(/authorization URL/)
  })
})
