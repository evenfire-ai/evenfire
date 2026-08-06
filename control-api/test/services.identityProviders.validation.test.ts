import { describe, expect, it, vi } from 'vitest'

vi.mock('../src/config.js', () => ({
  config: {
    controlUiBaseUrl: 'https://control.example.test',
    desktopProfileUiBaseUrl: 'https://profile.example.test',
  },
}))

const { requireCanonicalGuid, validateIdentityProviderReturnUrl } =
  await import('../src/services/identityProviders/validation.js')

describe('identity provider validation', () => {
  it('accepts only the configured callback path and origin for browser flows', () => {
    expect(
      validateIdentityProviderReturnUrl(
        'admin_connect',
        'https://control.example.test/settings/integrations/microsoft/connect?connected=1'
      )
    ).toContain('/settings/integrations/microsoft/connect')
    expect(() =>
      validateIdentityProviderReturnUrl(
        'profile_login',
        'https://attacker.example/auth/provider-callback'
      )
    ).toThrow('Return URL origin is not allowed')
    expect(() =>
      validateIdentityProviderReturnUrl('profile_login', 'https://profile.example.test/other')
    ).toThrow('Return URL path is not allowed')
  })

  it('allows only the fixed Evenfire callback for Desktop App login', () => {
    expect(
      validateIdentityProviderReturnUrl('desktop_login', 'evenfire://auth/microsoft/callback')
    ).toBe('evenfire://auth/microsoft/callback')
    expect(() =>
      validateIdentityProviderReturnUrl('desktop_login', 'https://attacker.example/callback')
    ).toThrow('Invalid desktop return URL')
  })

  it('requires canonical UUID grouping', () => {
    expect(requireCanonicalGuid('11111111-1111-4111-8111-111111111111', 'Tenant ID')).toBe(
      '11111111-1111-4111-8111-111111111111'
    )
    expect(() => requireCanonicalGuid('111111111111-4111-8111-111111111111', 'Tenant ID')).toThrow(
      'Tenant ID must be a canonical UUID'
    )
  })
})
