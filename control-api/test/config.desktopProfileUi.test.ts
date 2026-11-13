import { afterEach, describe, expect, it } from 'vitest'
import { resolveDesktopProfileUiBaseUrl } from '../src/config.js'

const originalPublic = process.env.DESKTOP_PROFILE_UI_PUBLIC_BASE_URL
const originalLegacy = process.env.CONTROL_API_DESKTOP_PROFILE_UI_BASE_URL

afterEach(() => {
  if (originalPublic === undefined) delete process.env.DESKTOP_PROFILE_UI_PUBLIC_BASE_URL
  else process.env.DESKTOP_PROFILE_UI_PUBLIC_BASE_URL = originalPublic
  if (originalLegacy === undefined) delete process.env.CONTROL_API_DESKTOP_PROFILE_UI_BASE_URL
  else process.env.CONTROL_API_DESKTOP_PROFILE_UI_BASE_URL = originalLegacy
})

describe('resolveDesktopProfileUiBaseUrl', () => {
  it('uses the shared deployment-owned setting', () => {
    process.env.DESKTOP_PROFILE_UI_PUBLIC_BASE_URL = 'https://profile.example.com'
    delete process.env.CONTROL_API_DESKTOP_PROFILE_UI_BASE_URL
    expect(resolveDesktopProfileUiBaseUrl()).toBe('https://profile.example.com')
  })

  it('retains the legacy setting when the new setting is absent', () => {
    delete process.env.DESKTOP_PROFILE_UI_PUBLIC_BASE_URL
    process.env.CONTROL_API_DESKTOP_PROFILE_UI_BASE_URL = 'https://profile.legacy.example'
    expect(resolveDesktopProfileUiBaseUrl()).toBe('https://profile.legacy.example')
  })

  it('rejects conflicting old and new deployment values', () => {
    process.env.DESKTOP_PROFILE_UI_PUBLIC_BASE_URL = 'https://profile.example.com'
    process.env.CONTROL_API_DESKTOP_PROFILE_UI_BASE_URL = 'https://other.example.com'
    expect(() => resolveDesktopProfileUiBaseUrl()).toThrow(/conflicts/)
  })
})
