import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const KEY = 'CONTROL_API_DESKTOP_GFS_OPERATOR_LINKING_ENABLED'
const original = process.env[KEY]

beforeEach(() => {
  delete process.env[KEY]
  vi.resetModules()
})

afterEach(() => {
  if (original === undefined) delete process.env[KEY]
  else process.env[KEY] = original
  vi.resetModules()
})

describe(KEY, () => {
  it('defaults to disabled when absent', async () => {
    const { config } = await import('../src/config.js')
    expect(config.desktopGfsOperatorLinkingEnabled).toBe(false)
  })

  it.each([
    ['true', true],
    ['false', false],
  ])('parses the exact %s value', async (value, expected) => {
    process.env[KEY] = value
    const { config } = await import('../src/config.js')
    expect(config.desktopGfsOperatorLinkingEnabled).toBe(expected)
  })

  it('fails closed on malformed values', async () => {
    process.env[KEY] = 'yes'
    await expect(import('../src/config.js')).rejects.toThrow(
      /CONTROL_API_DESKTOP_GFS_OPERATOR_LINKING_ENABLED must be 'true' or 'false'/
    )
  })
})
