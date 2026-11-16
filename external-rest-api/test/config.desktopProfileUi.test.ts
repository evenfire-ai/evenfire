import { afterAll, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'

const originalProfileUiUrl = process.env.CONTROL_API_DESKTOP_PROFILE_UI_BASE_URL
process.env.CONTROL_API_DESKTOP_PROFILE_UI_BASE_URL ??= 'http://127.0.0.1:3001'

afterAll(() => {
  if (originalProfileUiUrl === undefined) {
    delete process.env.CONTROL_API_DESKTOP_PROFILE_UI_BASE_URL
  } else {
    process.env.CONTROL_API_DESKTOP_PROFILE_UI_BASE_URL = originalProfileUiUrl
  }
})

describe('CONTROL_API_DESKTOP_PROFILE_UI_BASE_URL validation for External REST', () => {
  it('uses the local Profile UI origin by default in development and preserves an override', async () => {
    const originalNodeEnv = process.env.NODE_ENV
    const originalDevMode = process.env.CLERUM_DEV_MODE
    const originalProfileUiBaseUrl = process.env.CONTROL_API_DESKTOP_PROFILE_UI_BASE_URL

    process.env.NODE_ENV = 'development'
    process.env.CLERUM_DEV_MODE = 'true'
    delete process.env.CONTROL_API_DESKTOP_PROFILE_UI_BASE_URL
    vi.resetModules()

    try {
      const { config } = await import('../src/config.js')
      expect(config.desktopProfileUiBaseUrl).toBe('http://127.0.0.1:3001')

      process.env.CONTROL_API_DESKTOP_PROFILE_UI_BASE_URL = 'https://profile.example.test'
      vi.resetModules()
      const explicitConfig = await import('../src/config.js')
      expect(explicitConfig.config.desktopProfileUiBaseUrl).toBe('https://profile.example.test')
    } finally {
      if (originalNodeEnv === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = originalNodeEnv
      if (originalDevMode === undefined) delete process.env.CLERUM_DEV_MODE
      else process.env.CLERUM_DEV_MODE = originalDevMode
      if (originalProfileUiBaseUrl === undefined) {
        delete process.env.CONTROL_API_DESKTOP_PROFILE_UI_BASE_URL
      } else {
        process.env.CONTROL_API_DESKTOP_PROFILE_UI_BASE_URL = originalProfileUiBaseUrl
      }
      vi.resetModules()
    }
  })

  it('defaults the standalone local dev target without overriding an explicit origin', () => {
    const makefile = readFileSync(new URL('../Makefile', import.meta.url), 'utf8')
    expect(makefile).toContain(
      'CONTROL_API_DESKTOP_PROFILE_UI_BASE_URL="$${CONTROL_API_DESKTOP_PROFILE_UI_BASE_URL-http://127.0.0.1:3001}" CLERUM_DEV_MODE=true npm run dev'
    )
  })

  it.each([
    ['https://profile.example.com', 'https://api.example.com/api/v1'],
    ['https://[2606:4700:4700::1111]', 'https://api.example.com'],
    ['http://localhost:3001/', 'http://localhost:8091/api/v1'],
    ['http://localhost.:3001', 'http://127.0.0.1:8091'],
    ['http://127.4.5.6:3001', 'http://127.0.0.1:8091'],
  ])('accepts a public origin with a valid REST pairing: %s', async (profile, rest) => {
    const { validateDesktopProfileUiBaseUrl } = await import('../src/config.js')
    expect(validateDesktopProfileUiBaseUrl(profile, rest)).toBe(new URL(profile).origin)
  })

  it.each([
    ['', 'http://127.0.0.1:8091'],
    ['http://profile.example.com', 'https://api.example.com'],
    ['http://127.0.0.1:3001', 'https://api.example.com'],
    ['https://localhost.', 'https://api.example.com'],
    ['https://10.0.0.5', 'https://api.example.com'],
    ['https://192.168.1.20', 'https://api.example.com'],
    ['https://192.0.2.3', 'https://api.example.com'],
    ['https://198.51.100.2', 'https://api.example.com'],
    ['https://203.0.113.3', 'https://api.example.com'],
    ['https://[::ffff:192.0.2.3]', 'https://api.example.com'],
    ['https://[fd00::1]', 'https://api.example.com'],
    ['https://[fec0::1]', 'https://api.example.com'],
    ['https://[ff02::1]', 'https://api.example.com'],
    ['https://[ff05::1]', 'https://api.example.com'],
    ['https://[::ffff:10.0.0.5]', 'https://api.example.com'],
    ['https://profile.example.com\\admin', 'https://api.example.com'],
    ['https://user:password@profile.example.com', 'https://api.example.com'],
    ['https://profile.example.com/path', 'https://api.example.com'],
    ['https://profile.example.com?tenant=other', 'https://api.example.com'],
    ['https://profile.example.com#fragment', 'https://api.example.com'],
    ['javascript:alert(1)', 'https://api.example.com'],
  ])('rejects an unsafe or non-origin value: %s', async (profile, rest) => {
    const { validateDesktopProfileUiBaseUrl } = await import('../src/config.js')
    expect(() => validateDesktopProfileUiBaseUrl(profile, rest)).toThrow()
  })

  it('does not treat a hostname with a 127 prefix as an IPv4 loopback address', async () => {
    const { validateDesktopProfileUiBaseUrl } = await import('../src/config.js')
    expect(() =>
      validateDesktopProfileUiBaseUrl('http://127.attacker.example', 'http://localhost:8091/api/v1')
    ).toThrow()
  })
})
