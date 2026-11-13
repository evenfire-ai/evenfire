import { describe, expect, it } from 'vitest'
import { validateDesktopProfileUiBaseUrl } from '../src/config.js'

describe('DESKTOP_PROFILE_UI_PUBLIC_BASE_URL validation', () => {
  it.each([
    ['https://profile.example.com', 'https://api.example.com/api/v1'],
    ['https://[2606:4700:4700::1111]', 'https://api.example.com'],
    ['http://localhost:3001/', 'http://localhost:8091/api/v1'],
    ['http://127.4.5.6:3001', 'http://127.0.0.1:8091'],
  ])('accepts a public origin with a valid REST pairing: %s', (profile, rest) => {
    expect(validateDesktopProfileUiBaseUrl(profile, rest)).toBe(new URL(profile).origin)
  })

  it.each([
    ['http://profile.example.com', 'https://api.example.com'],
    ['http://127.0.0.1:3001', 'https://api.example.com'],
    ['https://10.0.0.5', 'https://api.example.com'],
    ['https://192.168.1.20', 'https://api.example.com'],
    ['https://[fd00::1]', 'https://api.example.com'],
    ['https://[fec0::1]', 'https://api.example.com'],
    ['https://user:password@profile.example.com', 'https://api.example.com'],
    ['https://profile.example.com/path', 'https://api.example.com'],
    ['https://profile.example.com?tenant=other', 'https://api.example.com'],
    ['https://profile.example.com#fragment', 'https://api.example.com'],
    ['javascript:alert(1)', 'https://api.example.com'],
  ])('rejects an unsafe or non-origin value: %s', (profile, rest) => {
    expect(() => validateDesktopProfileUiBaseUrl(profile, rest)).toThrow()
  })

  it('does not treat a hostname with a 127 prefix as an IPv4 loopback address', () => {
    expect(() =>
      validateDesktopProfileUiBaseUrl('http://127.attacker.example', 'http://localhost:8091/api/v1')
    ).toThrow()
  })
})
