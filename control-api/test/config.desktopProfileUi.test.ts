import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveDesktopProfileUiBaseUrl, validateDesktopProfileUiBaseUrl } from '../src/config.js'

const originalLegacy = process.env.CONTROL_API_DESKTOP_PROFILE_UI_BASE_URL
const originalFormerAlias = process.env.DESKTOP_PROFILE_UI_PUBLIC_BASE_URL
const originalExternalRestBase = process.env.CONTROL_API_DESKTOP_EXTERNAL_REST_API_BASE_URL

afterEach(() => {
  if (originalLegacy === undefined) delete process.env.CONTROL_API_DESKTOP_PROFILE_UI_BASE_URL
  else process.env.CONTROL_API_DESKTOP_PROFILE_UI_BASE_URL = originalLegacy
  if (originalFormerAlias === undefined) delete process.env.DESKTOP_PROFILE_UI_PUBLIC_BASE_URL
  else process.env.DESKTOP_PROFILE_UI_PUBLIC_BASE_URL = originalFormerAlias
  if (originalExternalRestBase === undefined) {
    delete process.env.CONTROL_API_DESKTOP_EXTERNAL_REST_API_BASE_URL
  } else {
    process.env.CONTROL_API_DESKTOP_EXTERNAL_REST_API_BASE_URL = originalExternalRestBase
  }
})

describe('resolveDesktopProfileUiBaseUrl', () => {
  it('uses the established operator-owned setting', () => {
    process.env.CONTROL_API_DESKTOP_PROFILE_UI_BASE_URL = 'https://profile.legacy.example'
    delete process.env.DESKTOP_PROFILE_UI_PUBLIC_BASE_URL
    expect(resolveDesktopProfileUiBaseUrl()).toBe('https://profile.legacy.example')
  })

  it('preserves surrounding whitespace so the shared validator rejects it', () => {
    process.env.CONTROL_API_DESKTOP_PROFILE_UI_BASE_URL = ' https://profile.legacy.example '
    expect(resolveDesktopProfileUiBaseUrl()).toBe(' https://profile.legacy.example ')
    expect(() =>
      validateDesktopProfileUiBaseUrl(resolveDesktopProfileUiBaseUrl(), 'https://api.example.test')
    ).toThrow()
  })

  it('keeps the established setting when an inherited former alias disagrees', () => {
    process.env.CONTROL_API_DESKTOP_PROFILE_UI_BASE_URL = 'https://profile.legacy.example'
    process.env.DESKTOP_PROFILE_UI_PUBLIC_BASE_URL = 'http://127.0.0.1:3001'
    expect(resolveDesktopProfileUiBaseUrl()).toBe('https://profile.legacy.example')
  })

  it('starts with the established setting when the former alias is inherited and conflicts', async () => {
    process.env.CONTROL_API_DESKTOP_PROFILE_UI_BASE_URL = 'https://profile.legacy.example'
    process.env.CONTROL_API_DESKTOP_EXTERNAL_REST_API_BASE_URL = 'https://api.example.test'
    process.env.DESKTOP_PROFILE_UI_PUBLIC_BASE_URL = 'http://127.0.0.1:3001'
    vi.resetModules()

    const loaded = await import('../src/config.js')

    expect(loaded.config.desktopProfileUiBaseUrl).toBe('https://profile.legacy.example')
  })

  it('does not treat the former alias as an operator authority', () => {
    delete process.env.CONTROL_API_DESKTOP_PROFILE_UI_BASE_URL
    process.env.DESKTOP_PROFILE_UI_PUBLIC_BASE_URL = 'https://profile.other.example'
    expect(resolveDesktopProfileUiBaseUrl()).toBe('http://127.0.0.1:3001')
  })

  it('rejects an explicitly empty canonical setting instead of falling back to loopback', async () => {
    process.env.CONTROL_API_DESKTOP_PROFILE_UI_BASE_URL = ''
    process.env.CONTROL_API_DESKTOP_EXTERNAL_REST_API_BASE_URL = 'http://127.0.0.1:8091'
    vi.resetModules()

    await expect(import('../src/config.js')).rejects.toThrow(
      'CONTROL_API_DESKTOP_PROFILE_UI_BASE_URL must be an absolute HTTP(S) origin'
    )
  })

  it.each([
    ['https://profile.example.com', 'https://api.example.com/api/v1'],
    ['http://localhost:3001', 'http://127.0.0.1:8091'],
    ['http://localhost.:3001', 'http://127.0.0.1:8091'],
    ['http://127.4.5.6:3001', 'http://localhost:8091'],
  ])('validates canonical origin %s against REST %s', (profile, rest) => {
    expect(validateDesktopProfileUiBaseUrl(profile, rest)).toBe(new URL(profile).origin)
  })

  it.each([
    ['http://profile.example.com', 'https://api.example.com'],
    ['http://127.0.0.1:3001', 'https://api.example.com'],
    ['https://localhost.', 'https://api.example.com'],
    ['https://10.0.0.5', 'https://api.example.com'],
    ['https://192.0.2.3', 'https://api.example.com'],
    ['https://198.51.100.2', 'https://api.example.com'],
    ['https://203.0.113.3', 'https://api.example.com'],
    ['https://[::ffff:192.0.2.3]', 'https://api.example.com'],
    ['https://[fec0::1]', 'https://api.example.com'],
    ['https://[ff02::1]', 'https://api.example.com'],
    ['https://[ff05::1]', 'https://api.example.com'],
    ['https://profile.example.com\\admin', 'https://api.example.com'],
    ['https://[::ffff:10.0.0.5]', 'https://api.example.com'],
    ['https://user:password@profile.example.com', 'https://api.example.com'],
  ])('rejects unsafe or unpaired canonical origin %s', (profile, rest) => {
    expect(() => validateDesktopProfileUiBaseUrl(profile, rest)).toThrow()
  })
})
