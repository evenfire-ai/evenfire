import { afterEach, expect, it, vi } from 'vitest'

const originalProfileOrigin = process.env.CONTROL_API_DESKTOP_PROFILE_UI_BASE_URL
const originalRestOrigin = process.env.CONTROL_API_DESKTOP_EXTERNAL_REST_API_BASE_URL

afterEach(() => {
  if (originalProfileOrigin === undefined)
    delete process.env.CONTROL_API_DESKTOP_PROFILE_UI_BASE_URL
  else process.env.CONTROL_API_DESKTOP_PROFILE_UI_BASE_URL = originalProfileOrigin
  if (originalRestOrigin === undefined)
    delete process.env.CONTROL_API_DESKTOP_EXTERNAL_REST_API_BASE_URL
  else process.env.CONTROL_API_DESKTOP_EXTERNAL_REST_API_BASE_URL = originalRestOrigin
  vi.resetModules()
})

it('keeps the established Control API default when only the REST origin is configured', async () => {
  delete process.env.CONTROL_API_DESKTOP_PROFILE_UI_BASE_URL
  process.env.CONTROL_API_DESKTOP_EXTERNAL_REST_API_BASE_URL = 'https://api.example.test'
  vi.resetModules()

  const { config } = await import('../src/config.js')
  const resolvedOrigin = new URL(config.desktopProfileUiBaseUrl)

  expect(resolvedOrigin).toMatchObject({
    protocol: 'http:',
    hostname: '127.0.0.1',
    port: '3001',
    pathname: '/',
    search: '',
    hash: '',
  })
})
